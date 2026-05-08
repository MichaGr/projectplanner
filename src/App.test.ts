import { describe, expect, it } from 'vitest';

import { sanitizeSnapshot } from './App';

describe('sanitizeSnapshot', () => {
  it('drops duplicate, invalid, and self-referential edges before persistence', () => {
    const snapshot = sanitizeSnapshot({
      root: {
        title: 'Main Graph',
        description: '',
        completionCriteria: '',
        tags: [],
      },
      nodes: [
        {
          id: 'task-a',
          kind: 'task',
          title: 'Task A',
          status: 'todo',
          position: { x: 0, y: 0 },
          description: '',
          completionCriteria: '',
          tags: [],
        },
        {
          id: 'task-b',
          kind: 'task',
          title: 'Task B',
          status: 'todo',
          position: { x: 80, y: 0 },
          description: '',
          completionCriteria: '',
          tags: [],
        },
        {
          id: 'group-1',
          kind: 'group',
          title: 'Group',
          status: 'todo',
          position: { x: 120, y: 120 },
          description: '',
          completionCriteria: '',
          tags: [],
        },
        {
          id: 'task-c',
          kind: 'task',
          title: 'Task C',
          status: 'todo',
          position: { x: 16, y: 16 },
          description: '',
          completionCriteria: '',
          tags: [],
          parentId: 'group-1',
        },
      ],
      edges: [
        { id: 'edge-1', source: 'task-a', target: 'task-b' },
        { id: 'edge-2', source: 'task-a', target: 'task-b' },
        { id: 'edge-3', source: 'task-a', target: 'task-a' },
        { id: 'edge-4', source: 'task-a', target: 'missing' },
        { id: 'edge-5', source: 'task-a', target: 'task-c' },
      ],
    });

    expect(snapshot.edges).toEqual([{ id: 'edge-1', source: 'task-a', target: 'task-b' }]);
  });
});
