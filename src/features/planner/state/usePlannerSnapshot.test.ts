import { describe, expect, it } from 'vitest';
import { plannerSnapshotReducer } from './usePlannerSnapshot';
import type { PlannerSnapshot } from '../model/types';

const snapshot: PlannerSnapshot = {
  root: { title: 'Project', description: '', completionCriteria: '', tags: [] },
  nodes: [],
  edges: [],
};

describe('planner snapshot reducer', () => {
  it('accepts replacement snapshots', () => {
    const replacement = { ...snapshot, root: { ...snapshot.root, title: 'Replacement' } };
    expect(plannerSnapshotReducer(snapshot, replacement)).toBe(replacement);
  });

  it('applies functional graph updates', () => {
    const result = plannerSnapshotReducer(snapshot, (current) => ({
      ...current,
      root: { ...current.root, title: 'Updated' },
    }));
    expect(result.root.title).toBe('Updated');
    expect(result.nodes).toBe(snapshot.nodes);
  });
});
