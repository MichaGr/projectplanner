import { beforeEach, describe, expect, it } from 'vitest';
import { getStoredSnapshot, normalizeImportedProjectFile, sanitizeSnapshot, serializeProjectFile } from './project';
import type { PlannerSnapshot } from './types';

const snapshot: PlannerSnapshot = {
  root: { title: 'Project', description: '', completionCriteria: '', tags: ['Roadmap.API'] },
  nodes: [{ id: 'task', kind: 'task', title: 'Task', status: 'todo', position: { x: 1, y: 2 }, description: '', completionCriteria: '', tags: [] }],
  edges: [],
};

describe('project serialization', () => {
  beforeEach(() => window.localStorage.clear());

  it('preserves the existing version 2 project file contract', () => {
    const file = serializeProjectFile('project-1', snapshot, [{ id: 'main', kind: 'main' }], 'main', 'task');
    expect(file).toMatchObject({ version: 2, projectId: 'project-1', project: snapshot, ui: { activeTabId: 'main', selectedNodeId: 'task' } });
    expect(normalizeImportedProjectFile(file)).toMatchObject({
      version: 2,
      projectId: 'project-1',
      project: { root: snapshot.root, edges: [] },
      ui: file.ui,
    });
  });

  it('sanitizes legacy fields and invalid cross-scope edges', () => {
    const legacy = {
      ...snapshot,
      root: { title: 'Legacy', description: '', acceptanceCriteria: 'Done', tags: [' Roadmap.API '] },
      nodes: [
        { ...snapshot.nodes[0], completionCriteria: undefined, acceptanceCriteria: 'Accepted' },
        { ...snapshot.nodes[0], id: 'nested', parentId: 'group' },
      ],
      edges: [{ id: 'invalid', source: 'task', target: 'nested' }],
    } as unknown as PlannerSnapshot;
    const result = sanitizeSnapshot(legacy);
    expect(result.root.completionCriteria).toBe('Done');
    expect(result.nodes[0].completionCriteria).toBe('Accepted');
    expect(result.edges).toEqual([]);
  });

  it('reads the existing local-storage key and stored shape', () => {
    window.localStorage.setItem('project-planner-state-v2', JSON.stringify({ version: 3, project: snapshot, ui: { openTabs: [{ id: 'main', kind: 'main' }], activeTabId: 'main', selectedNodeId: null } }));
    expect(getStoredSnapshot().root.title).toBe('Project');
  });
});
