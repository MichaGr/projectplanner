import type { ImportableProjectFile, PlannerNodeRecord, PlannerSnapshot, ProjectFileV1, ScopeId, TabDescriptor } from './types';

const STORAGE_KEY = 'project-planner-state-v2';
const mainTab: TabDescriptor = { id: 'main', kind: 'main' };
const groupSize = { width: 280, height: 132 };

const seedSnapshot = (): PlannerSnapshot => ({
  root: {
    title: 'Main Graph',
    description: 'Top-level project workflow across the whole plan.',
    completionCriteria: 'The main delivery path and major grouped workstreams are represented clearly.',
    tags: ['Planning.Root'],
  },
  nodes: [
    {
      id: 'vision',
      kind: 'task',
      title: 'Define project vision',
      status: 'done',
      position: { x: 40, y: 80 },
      description: 'Align the project around the user problem and the outcome the workflow should support.',
      completionCriteria: 'Vision statement is agreed and clearly readable by the team.',
      tags: ['Planning.Strategy'],
    },
    {
      id: 'research',
      kind: 'task',
      title: 'Research users',
      status: 'done',
      position: { x: 40, y: 280 },
      description: 'Collect the main needs and constraints from likely users of the planner.',
      completionCriteria: 'At least a concise list of recurring needs is captured.',
      tags: ['Research.Users'],
    },
    {
      id: 'architecture',
      kind: 'task',
      title: 'Set architecture',
      status: 'todo',
      position: { x: 380, y: 180 },
      description: 'Choose the graph, state, and UI architecture for the first version.',
      completionCriteria: 'The team can explain how tasks, groups, and dependencies are represented.',
      tags: ['Planning.Architecture'],
    },
    {
      id: 'prototype',
      kind: 'group',
      title: 'Build prototype',
      status: 'todo',
      position: { x: 760, y: 130 },
      description: 'Deliver a working prototype that demonstrates nested task planning.',
      completionCriteria: 'Core workflow is testable in the browser.',
      tags: ['Delivery.Prototype'],
      size: { ...groupSize },
    },
    {
      id: 'ui-shell',
      kind: 'task',
      title: 'Create shell UI',
      status: 'done',
      position: { x: 60, y: 80 },
      description: 'Build the main layout with the graph canvas and supporting panels.',
      completionCriteria: 'Users can view and navigate the planner comfortably.',
      tags: ['Implementation.UI.Shell'],
      parentId: 'prototype',
    },
    {
      id: 'workflow',
      kind: 'group',
      title: 'Task workflow',
      status: 'todo',
      position: { x: 380, y: 80 },
      description: 'Implement the core graph logic around unlocking and nested decomposition.',
      completionCriteria: 'Availability and dependency behavior work across nested items.',
      tags: ['Implementation.Workflow'],
      parentId: 'prototype',
      size: { ...groupSize },
    },
    {
      id: 'deps',
      kind: 'task',
      title: 'Map dependencies',
      status: 'done',
      position: { x: 60, y: 80 },
      description: 'Support dependency relationships across tasks inside the same scope.',
      completionCriteria: 'Blocked tasks respond correctly to completed prerequisites.',
      tags: ['Implementation.Workflow.Dependencies'],
      parentId: 'workflow',
    },
    {
      id: 'availability',
      kind: 'task',
      title: 'Show available work',
      status: 'todo',
      position: { x: 380, y: 80 },
      description: 'Expose which tasks can be worked on right now.',
      completionCriteria: 'The available tasks panel updates correctly when statuses change.',
      tags: ['Implementation.Workflow.Availability'],
      parentId: 'workflow',
    },
    {
      id: 'qa',
      kind: 'task',
      title: 'QA review',
      status: 'todo',
      position: { x: 1120, y: 80 },
      description: 'Review the prototype flow and edge cases before release.',
      completionCriteria: 'Critical workflow issues are identified and documented.',
      tags: ['QA.Review'],
    },
    {
      id: 'launch',
      kind: 'task',
      title: 'Launch prep',
      status: 'todo',
      position: { x: 1120, y: 280 },
      description: 'Prepare the prototype for a clean handoff or demo.',
      completionCriteria: 'Demo path is stable and ready to share.',
      tags: ['Delivery.Launch'],
    },
  ],
  edges: [
    { id: 'e-vision-architecture', source: 'vision', target: 'architecture' },
    { id: 'e-research-architecture', source: 'research', target: 'architecture' },
    { id: 'e-architecture-prototype', source: 'architecture', target: 'prototype' },
    { id: 'e-ui-workflow', source: 'ui-shell', target: 'workflow' },
    { id: 'e-deps-availability', source: 'deps', target: 'availability' },
    { id: 'e-prototype-qa', source: 'prototype', target: 'qa' },
    { id: 'e-prototype-launch', source: 'prototype', target: 'launch' },
  ],
});

export const blankSnapshot = (): PlannerSnapshot => ({
  root: {
    title: 'New Project',
    description: '',
    completionCriteria: '',
    tags: [],
  },
  nodes: [],
  edges: [],
});

export const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
export const serializeSnapshot = (snapshot: PlannerSnapshot) => JSON.stringify(snapshot);
export const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const normalizeTag = (value: string) =>
  value
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('.');

export const normalizeDateOnly = (value: unknown) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

export const formatCreatedAt = (value?: string) => {
  if (!value) return 'Pending save';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(parsed);
};

export const getNodeScope = (node: PlannerNodeRecord): ScopeId => node.parentId ?? null;

export const isSameScope = (nodes: PlannerNodeRecord[], sourceId: string, targetId: string) => {
  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);
  if (!source || !target) {
    return false;
  }
  return getNodeScope(source) === getNodeScope(target);
};

export const sanitizeSnapshot = (snapshot: PlannerSnapshot): PlannerSnapshot => {
  const rawRoot = snapshot.root as PlannerSnapshot['root'] & {
    acceptanceCriteria?: string;
    tags?: unknown;
  };

  const root = {
    title: rawRoot?.title ?? 'Main Graph',
    description: rawRoot?.description ?? '',
    completionCriteria: rawRoot?.completionCriteria ?? rawRoot?.acceptanceCriteria ?? '',
    tags: Array.isArray(rawRoot?.tags)
      ? rawRoot.tags.map((tag) => normalizeTag(String(tag))).filter(Boolean)
      : [],
  };

  const nodes = snapshot.nodes.map((node) => {
    const legacyNode = node as PlannerNodeRecord & {
      acceptanceCriteria?: string;
      tags?: unknown;
      createdAt?: unknown;
      dueDate?: unknown;
      doDate?: unknown;
    };

    return {
      ...node,
      description: legacyNode.description ?? '',
      completionCriteria: legacyNode.completionCriteria ?? legacyNode.acceptanceCriteria ?? '',
      tags: Array.isArray(legacyNode.tags)
        ? legacyNode.tags.map((tag) => normalizeTag(String(tag))).filter(Boolean)
        : [],
      createdAt: typeof legacyNode.createdAt === 'string' ? legacyNode.createdAt : undefined,
      dueDate: normalizeDateOnly(legacyNode.dueDate),
      doDate: normalizeDateOnly(legacyNode.doDate),
    };
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = snapshot.edges.filter((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      return false;
    }
    return isSameScope(nodes, edge.source, edge.target);
  });

  return { root, nodes, edges };
};

export const getStoredSnapshot = (): PlannerSnapshot => {
  if (typeof window === 'undefined') {
    return seedSnapshot();
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return seedSnapshot();
  }

  try {
    const parsed = JSON.parse(raw) as PlannerSnapshot | ProjectFileV1;
    if ('project' in parsed && parsed.project) {
      return sanitizeProjectFile(parsed).project;
    }
    return sanitizeSnapshot(parsed as PlannerSnapshot);
  } catch {
    return seedSnapshot();
  }
};

export const getStoredProjectId = (): string => {
  if (typeof window === 'undefined') {
    return '';
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return '';
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ProjectFileV1>;
    return typeof parsed.projectId === 'string' ? parsed.projectId : '';
  } catch {
    return '';
  }
};

export const getStoredWorkspaceId = (): string => {
  if (typeof window === 'undefined') return '';
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectFileV1>;
    return typeof parsed.workspaceId === 'string' ? parsed.workspaceId : '';
  } catch {
    return '';
  }
};

const sanitizeTabs = (tabs: TabDescriptor[] | undefined, nodes: PlannerNodeRecord[]) => {
  const validGroupIds = new Set(nodes.filter((node) => node.kind === 'group').map((node) => node.id));
  const normalized = (tabs ?? []).filter((tab) => tab.kind === 'main' || validGroupIds.has(tab.id));
  const deduped = normalized.filter(
    (tab, index) => normalized.findIndex((candidate) => candidate.id === tab.id && candidate.kind === tab.kind) === index,
  );
  return deduped.some((tab) => tab.kind === 'main') ? deduped : [mainTab, ...deduped];
};

export const sanitizeProjectFile = (raw: ProjectFileV1): ProjectFileV1 => {
  const project = sanitizeSnapshot(raw.project);
  const openTabs = sanitizeTabs(raw.ui?.openTabs, project.nodes);
  const validTabIds = new Set(openTabs.map((tab) => tab.id));
  const validNodeIds = new Set(project.nodes.map((node) => node.id));
  const activeTabId = validTabIds.has(raw.ui?.activeTabId) ? raw.ui.activeTabId : 'main';
  const selectedNodeId =
    raw.ui?.selectedNodeId && validNodeIds.has(raw.ui.selectedNodeId) ? raw.ui.selectedNodeId : null;

  return {
    version: 2,
    projectId: raw.projectId || '',
    project,
    ui: {
      openTabs,
      activeTabId,
      selectedNodeId,
    },
  };
};

const isPlannerSnapshot = (value: unknown): value is PlannerSnapshot => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<PlannerSnapshot>;
  return Boolean(candidate.root && Array.isArray(candidate.nodes) && Array.isArray(candidate.edges));
};

export const normalizeImportedProjectFile = (raw: ImportableProjectFile): ProjectFileV1 => {
  if (isPlannerSnapshot(raw)) {
    return sanitizeProjectFile({
      version: 2,
      projectId: '',
      project: raw,
      ui: {
        openTabs: [mainTab],
        activeTabId: 'main',
        selectedNodeId: null,
      },
    });
  }

  if ('project' in raw && isPlannerSnapshot(raw.project)) {
    const maybeProjectFile = raw as Partial<ProjectFileV1>;
    return sanitizeProjectFile({
      version: maybeProjectFile.version === 1 || maybeProjectFile.version === 2 ? maybeProjectFile.version : 2,
      projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
      project: raw.project,
      ui: {
        openTabs: maybeProjectFile.ui?.openTabs ?? [mainTab],
        activeTabId: maybeProjectFile.ui?.activeTabId ?? 'main',
        selectedNodeId: maybeProjectFile.ui?.selectedNodeId ?? null,
      },
    });
  }

  throw new Error('Invalid project file format.');
};

export const serializeProjectFile = (
  projectId: string,
  snapshot: PlannerSnapshot,
  openTabs: TabDescriptor[],
  activeTabId: string,
  selectedNodeId: string | null,
): ProjectFileV1 => ({
  version: 2,
  projectId,
  project: snapshot,
  ui: {
    openTabs,
    activeTabId,
    selectedNodeId,
  },
});

export const serializeStoredState = (
  workspaceId: string,
  projectId: string,
  snapshot: PlannerSnapshot,
  openTabs: TabDescriptor[],
  activeTabId: string,
  selectedNodeId: string | null,
): ProjectFileV1 => ({
  ...serializeProjectFile(projectId, snapshot, openTabs, activeTabId, selectedNodeId),
  version: 3,
  workspaceId,
});

export const fileNameFromTitle = (title: string) =>
  `${title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project-planner'}.json`;
