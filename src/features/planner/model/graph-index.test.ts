import { describe, expect, it } from 'vitest';
import { createPlannerGraphIndex, getDescendantNodeIds, wouldCreateCycle } from './graph-index';
import type { PlannerEdgeRecord, PlannerNodeRecord } from './types';

const node = (id: string, kind: 'task' | 'group', parentId?: string, status: 'todo' | 'done' = 'todo'): PlannerNodeRecord => ({
  id,
  kind,
  parentId,
  status,
  title: id,
  position: { x: 0, y: 0 },
  description: '',
  completionCriteria: '',
  tags: [],
});

describe('planner graph index', () => {
  const nodes = [node('blocker', 'task', undefined, 'done'), node('group', 'group'), node('a', 'task', 'group', 'done'), node('b', 'task', 'group')];
  const edges: PlannerEdgeRecord[] = [{ id: 'edge', source: 'blocker', target: 'group' }];
  const index = createPlannerGraphIndex(nodes, edges);

  it('indexes scopes and descendants', () => {
    expect(index.getScopeNodes(null).map((item) => item.id)).toEqual(['blocker', 'group']);
    expect(index.getScopeNodes('group').map((item) => item.id)).toEqual(['a', 'b']);
    expect(getDescendantNodeIds(nodes, 'group')).toEqual(['a', 'b']);
  });

  it('derives completion, availability, and progress once from the graph', () => {
    expect(index.isNodeComplete('group')).toBe(false);
    expect(index.isNodeAvailable('group')).toBe(true);
    expect(index.isNodeAvailable('b')).toBe(true);
    expect(index.getGroupProgress('group')).toEqual({ done: 1, total: 2 });
  });

  it('detects dependency cycles', () => {
    const graph = [{ id: 'one', source: 'a', target: 'b' }, { id: 'two', source: 'b', target: 'c' }];
    expect(wouldCreateCycle(graph, 'c', 'a')).toBe(true);
    expect(wouldCreateCycle(graph, 'a', 'c')).toBe(false);
  });
});
