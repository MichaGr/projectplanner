import { describe, expect, it } from 'vitest';
import type { PlannerSnapshot } from './types';
import {
  extractNodeSubtree,
  insertNodeSubtreeIntoSnapshot,
  moveNodeWithinSnapshot,
  removeNodeSubtreeFromSnapshot,
} from './nodeMove';

const sourceSnapshot: PlannerSnapshot = {
  root: { title: 'Source', description: '', completionCriteria: '', tags: [] },
  nodes: [
    {
      id: 'task-root',
      kind: 'task',
      title: 'Root task',
      status: 'todo',
      position: { x: 100, y: 200 },
      description: '',
      completionCriteria: '',
      tags: [],
    },
    {
      id: 'group-a',
      kind: 'group',
      title: 'Group A',
      status: 'todo',
      position: { x: 400, y: 100 },
      description: '',
      completionCriteria: '',
      tags: [],
      size: { width: 280, height: 132 },
    },
    {
      id: 'group-b',
      kind: 'group',
      title: 'Group B',
      status: 'todo',
      position: { x: 900, y: 140 },
      description: '',
      completionCriteria: '',
      tags: [],
      size: { width: 280, height: 132 },
    },
    {
      id: 'nested-task',
      kind: 'task',
      title: 'Nested task',
      status: 'todo',
      position: { x: 120, y: 140 },
      description: '',
      completionCriteria: '',
      tags: [],
      parentId: 'group-a',
    },
    {
      id: 'nested-group',
      kind: 'group',
      title: 'Nested group',
      status: 'todo',
      position: { x: 320, y: 120 },
      description: '',
      completionCriteria: '',
      tags: [],
      parentId: 'group-a',
      size: { width: 280, height: 132 },
    },
    {
      id: 'deep-task',
      kind: 'task',
      title: 'Deep task',
      status: 'todo',
      position: { x: 140, y: 130 },
      description: '',
      completionCriteria: '',
      tags: [],
      parentId: 'nested-group',
    },
  ],
  edges: [
    { id: 'edge-root-group', source: 'task-root', target: 'group-a' },
    { id: 'edge-inside', source: 'nested-task', target: 'nested-group' },
    { id: 'edge-cross-scope', source: 'nested-task', target: 'task-root' },
  ],
};

describe('node move helpers', () => {
  it('moves a task into another group and removes invalid cross-scope edges', () => {
    const moved = moveNodeWithinSnapshot(sourceSnapshot, 'task-root', 'group-b');
    const task = moved.nodes.find((node) => node.id === 'task-root');

    expect(task).toMatchObject({
      parentId: 'group-b',
      position: { x: 60, y: 80 },
    });
    expect(moved.edges.map((edge) => edge.id)).toEqual([]);
  });

  it('moves a group to the project root while preserving descendant structure', () => {
    const nestedSource: PlannerSnapshot = {
      ...sourceSnapshot,
      nodes: sourceSnapshot.nodes.map((node) =>
        node.id === 'group-a' ? { ...node, parentId: 'group-b', position: { x: 90, y: 100 } } : node,
      ),
      edges: sourceSnapshot.edges.filter((edge) => edge.id === 'edge-inside'),
    };

    const moved = moveNodeWithinSnapshot(nestedSource, 'group-a', null);
    const group = moved.nodes.find((node) => node.id === 'group-a');
    const deepTask = moved.nodes.find((node) => node.id === 'deep-task');

    expect(group).toMatchObject({
      parentId: undefined,
      position: { x: 990, y: 240 },
    });
    expect(deepTask?.parentId).toBe('nested-group');
    expect(deepTask?.position).toEqual({ x: 140, y: 130 });
  });

  it('prevents moving a group into its descendant', () => {
    const moved = moveNodeWithinSnapshot(sourceSnapshot, 'group-a', 'nested-group');
    expect(moved).toBe(sourceSnapshot);
  });

  it('extracts, inserts, and removes subtrees across projects', () => {
    const subtree = extractNodeSubtree(sourceSnapshot, 'group-a');
    expect(subtree?.nodes.map((node) => node.id)).toEqual(['group-a', 'nested-task', 'nested-group', 'deep-task']);
    expect(subtree?.edges.map((edge) => edge.id)).toEqual(['edge-inside']);

    const destinationSnapshot: PlannerSnapshot = {
      root: { title: 'Destination', description: '', completionCriteria: '', tags: [] },
      nodes: [
        {
          id: 'dest-group',
          kind: 'group',
          title: 'Destination Group',
          status: 'todo',
          position: { x: 300, y: 140 },
          description: '',
          completionCriteria: '',
          tags: [],
          size: { width: 280, height: 132 },
        },
      ],
      edges: [],
    };

    const inserted = insertNodeSubtreeIntoSnapshot(destinationSnapshot, subtree!, 'dest-group');
    const insertedRoot = inserted.snapshot.nodes.find((node) => node.id === inserted.insertedRootId);

    expect(inserted.snapshot.nodes).toHaveLength(5);
    expect(insertedRoot).toMatchObject({
      parentId: 'dest-group',
      position: { x: 80, y: 120 },
    });
    expect(inserted.snapshot.edges).toEqual([
      {
        id: 'edge-inside',
        source: inserted.idMap.get('nested-task'),
        target: inserted.idMap.get('nested-group'),
      },
    ]);

    const removed = removeNodeSubtreeFromSnapshot(sourceSnapshot, 'group-a');
    expect(removed.nodes.map((node) => node.id)).toEqual(['task-root', 'group-b']);
    expect(removed.edges).toEqual([]);
  });
});
