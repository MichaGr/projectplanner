import { CSSProperties, ChangeEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  BaseEdge,
  Connection,
  Controls,
  Edge,
  EdgeProps,
  Handle,
  MiniMap,
  Node,
  NodeChange,
  NodeProps,
  PanOnScrollMode,
  SelectionMode,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AIGraphEdge,
  AIGraphNode,
  AIGraphResponse,
  AIContext,
  AIConversationMessage,
  AIDocument,
  AIMemoryResult,
  AIProposal,
  ApiError,
  AppSettings,
  GraphMutationOperation,
  ModelOption,
  fetchAIGraph,
  fetchNotionDatabaseSchema,
  fetchModels,
  fetchSettings,
  NotionDatabaseSchemaResponse,
  NotionProgressEntry,
  saveOpenAISettings,
  saveNotionSettings,
  sendAIChat,
  syncNotionProgress,
  uploadAIDocuments,
} from './api';

type PlannerNodeKind = 'task' | 'group';
type TaskStatus = 'todo' | 'done';
type ScopeId = string | null;
type ThemeMode = 'dark' | 'light';
type RightPanelTab = 'properties' | 'ai';
type EditableNodeField = 'description' | 'completionCriteria';
type EditableRootField = 'title' | 'description' | 'completionCriteria';

type PlannerNodeRecord = {
  id: string;
  kind: PlannerNodeKind;
  title: string;
  status: TaskStatus;
  position: { x: number; y: number };
  description: string;
  completionCriteria: string;
  tags: string[];
  parentId?: string;
  size?: { width: number; height: number };
};

type PlannerEdgeRecord = {
  id: string;
  source: string;
  target: string;
};

type PlannerSnapshot = {
  root: {
    title: string;
    description: string;
    completionCriteria: string;
    tags: string[];
  };
  nodes: PlannerNodeRecord[];
  edges: PlannerEdgeRecord[];
};

type TabDescriptor =
  | { id: 'main'; kind: 'main' }
  | { id: 'ai-graph'; kind: 'system' }
  | { id: string; kind: 'group' };

type ProjectFileV1 = {
  version: 1 | 2;
  projectId?: string;
  project: PlannerSnapshot;
  ui: {
    openTabs: TabDescriptor[];
    activeTabId: string;
    selectedNodeId: string | null;
  };
};

type RenderNodeData = {
  title: string;
  kind: PlannerNodeKind;
  status: TaskStatus;
  isAvailable: boolean;
  isBlocked: boolean;
  isDropTarget: boolean;
  completionLabel?: string;
  progressPercent?: number;
  childSummary?: string;
  onToggleComplete: () => void;
  onSplit: () => void;
  onOpen: () => void;
  onDelete: () => void;
  canToggleComplete: boolean;
  canSplit: boolean;
  canOpen: boolean;
  showActions: boolean;
};

type PlannerFlowNode = Node<RenderNodeData, 'plannerTask' | 'plannerGroup'>;
type NodeDropTarget =
  | { mode: 'group'; nodeId: string }
  | { mode: 'combine'; nodeId: string }
  | null;
type DragPreviewEdge = {
  source: string;
  target: string;
  path: string;
};
type AgentGraphRenderData = {
  label: string;
  kind: AIGraphNode['kind'];
  description: string;
};
type AgentGraphFlowNode = Node<AgentGraphRenderData, 'agentPill' | 'agentCard'>;
type NodeJournalState = {
  id: string;
  kind: PlannerNodeKind;
  title: string;
  description: string;
  completionCriteria: string;
  status: TaskStatus;
  scopeTitle: string;
};
type SessionJournalEntry = NotionProgressEntry & {
  entityKey?: string;
  initialNodeState?: NodeJournalState;
  finalNodeState?: NodeJournalState;
  nodeAction?: 'created' | 'updated' | 'deleted';
};
type NotionProgressFieldKey =
  | 'titleField'
  | 'projectNameField'
  | 'syncedAtField'
  | 'changedCountField'
  | 'completedCountField'
  | 'scopeField';
type NotionNotesFieldKey = 'titleField' | 'summaryField' | 'statusField' | 'tagsField' | 'scopeField';

const notionProgressFieldLabels: Record<NotionProgressFieldKey, string> = {
  titleField: 'Title field',
  projectNameField: 'Project name field',
  syncedAtField: 'Synced-at field',
  changedCountField: 'Changed-count field',
  completedCountField: 'Completed-count field',
  scopeField: 'Scope field',
};
const notionNotesFieldLabels: Record<NotionNotesFieldKey, string> = {
  titleField: 'Title field',
  summaryField: 'Summary field',
  statusField: 'Status field',
  tagsField: 'Tags field',
  scopeField: 'Scope field',
};

const STORAGE_KEY = 'project-planner-state-v2';
const THEME_STORAGE_KEY = 'project-planner-theme-v1';
const RIGHT_PANEL_WIDTH_STORAGE_KEY = 'project-planner-right-panel-width-v1';
const mainTab: TabDescriptor = { id: 'main', kind: 'main' };
const aiGraphTab: TabDescriptor = { id: 'ai-graph', kind: 'system' };
const groupSize = { width: 360, height: 180 };
const taskSize = { width: 260, height: 120 };
const particleGridConfig = {
  spacing: 26,
  attractRadius: 148,
  maxOffset: 22,
  dotRadius: 0.9,
  damping: 0.84,
  homePull: 0.045,
  attractPull: 0.14,
};

type ParticlePoint = {
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

function ParticleGridBackground({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) {
      return;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    let animationFrame = 0;
    let width = 0;
    let height = 0;
    let particles: ParticlePoint[] = [];
    let dpr = 1;
    const mouse = { x: 0, y: 0, active: false };

    const rebuildParticles = () => {
      particles = [];
      const columns = Math.ceil(width / particleGridConfig.spacing) + 4;
      const rows = Math.ceil(height / particleGridConfig.spacing) + 4;
      const startX = particleGridConfig.spacing * 0.5;
      const startY = particleGridConfig.spacing * 0.5;

      for (let row = -2; row < rows - 2; row += 1) {
        for (let column = -2; column < columns - 2; column += 1) {
          const homeX = startX + column * particleGridConfig.spacing;
          const homeY = startY + row * particleGridConfig.spacing;
          particles.push({
            homeX,
            homeY,
            x: homeX,
            y: homeY,
            vx: 0,
            vy: 0,
          });
        }
      }
    };

    const resizeCanvas = () => {
      const bounds = host.getBoundingClientRect();
      width = Math.max(1, Math.floor(bounds.width));
      height = Math.max(1, Math.floor(bounds.height));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      rebuildParticles();
    };

    const handlePointerMove = (event: PointerEvent) => {
      const bounds = host.getBoundingClientRect();
      mouse.x = event.clientX - bounds.left;
      mouse.y = event.clientY - bounds.top;
      mouse.active = true;
    };

    const handlePointerLeave = () => {
      mouse.active = false;
    };

    const render = () => {
      context.clearRect(0, 0, width, height);
      context.fillStyle = 'rgba(225, 195, 255, 0.38)';
      
      for (const particle of particles) {
        const homeX = particle.homeX;
        const homeY = particle.homeY;
        const homeMouseDx = mouse.x - homeX;
        const homeMouseDy = mouse.y - homeY;
        const homeMouseDistance = Math.hypot(homeMouseDx, homeMouseDy);

          let targetX = homeX;
          let targetY = homeY;

          if (mouse.active && homeMouseDistance < particleGridConfig.attractRadius) {
            const influence = 1 - homeMouseDistance / particleGridConfig.attractRadius;
            const offsetScale = Math.min(particleGridConfig.maxOffset, influence * particleGridConfig.maxOffset);
            const direction = Math.max(homeMouseDistance, 0.001);
            targetX = homeX + (homeMouseDx / direction) * offsetScale;
            targetY = homeY + (homeMouseDy / direction) * offsetScale;
            particle.vx += (targetX - particle.x) * particleGridConfig.attractPull * influence;
            particle.vy += (targetY - particle.y) * particleGridConfig.attractPull * influence;
          } else {
            particle.vx += (targetX - particle.x) * particleGridConfig.homePull;
            particle.vy += (targetY - particle.y) * particleGridConfig.homePull;
          }

          particle.vx *= particleGridConfig.damping;
          particle.vy *= particleGridConfig.damping;
          particle.x += particle.vx;
          particle.y += particle.vy;

          context.beginPath();
          context.arc(particle.x, particle.y, particleGridConfig.dotRadius, 0, Math.PI * 2);
          context.fill();
      }

      animationFrame = window.requestAnimationFrame(render);
    };

    const resizeObserver = new ResizeObserver(() => resizeCanvas());
    resizeObserver.observe(host);
    host.addEventListener('pointermove', handlePointerMove);
    host.addEventListener('pointerleave', handlePointerLeave);

    resizeCanvas();
    render();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      host.removeEventListener('pointermove', handlePointerMove);
      host.removeEventListener('pointerleave', handlePointerLeave);
    };
  }, []);

  return <canvas ref={canvasRef} className={className ?? 'particle-grid'} aria-hidden="true" />;
}

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

const blankSnapshot = (): PlannerSnapshot => ({
  root: {
    title: 'New Project',
    description: '',
    completionCriteria: '',
    tags: [],
  },
  nodes: [],
  edges: [],
});

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
const createProjectId = () => `project-${Math.random().toString(36).slice(2, 10)}`;
const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const normalizeTag = (value: string) =>
  value
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('.');

const getNodeScope = (node: PlannerNodeRecord): ScopeId => node.parentId ?? null;

const isSameScope = (nodes: PlannerNodeRecord[], sourceId: string, targetId: string) => {
  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);
  if (!source || !target) {
    return false;
  }
  return getNodeScope(source) === getNodeScope(target);
};

const sanitizeSnapshot = (snapshot: PlannerSnapshot): PlannerSnapshot => {
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
    };

    return {
      ...node,
      description: legacyNode.description ?? '',
      completionCriteria: legacyNode.completionCriteria ?? legacyNode.acceptanceCriteria ?? '',
      tags: Array.isArray(legacyNode.tags)
        ? legacyNode.tags.map((tag) => normalizeTag(String(tag))).filter(Boolean)
        : [],
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

const getStoredSnapshot = (): PlannerSnapshot => {
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

const getStoredProjectId = (): string => {
  if (typeof window === 'undefined') {
    return createProjectId();
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return createProjectId();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ProjectFileV1>;
    return typeof parsed.projectId === 'string' && parsed.projectId ? parsed.projectId : createProjectId();
  } catch {
    return createProjectId();
  }
};

const sanitizeTabs = (tabs: TabDescriptor[] | undefined, nodes: PlannerNodeRecord[]) => {
  const validGroupIds = new Set(nodes.filter((node) => node.kind === 'group').map((node) => node.id));
  const normalized = (tabs ?? []).filter(
    (tab) => tab.kind === 'main' || tab.kind === 'system' || validGroupIds.has(tab.id),
  );
  const deduped = normalized.filter(
    (tab, index) => normalized.findIndex((candidate) => candidate.id === tab.id && candidate.kind === tab.kind) === index,
  );
  const withMain = deduped.some((tab) => tab.kind === 'main') ? deduped : [mainTab, ...deduped];
  return withMain.some((tab) => tab.kind === 'system' && tab.id === 'ai-graph') ? withMain : [...withMain, aiGraphTab];
};

const sanitizeProjectFile = (raw: ProjectFileV1): ProjectFileV1 => {
  const project = sanitizeSnapshot(raw.project);
  const openTabs = sanitizeTabs(raw.ui?.openTabs, project.nodes);
  const validTabIds = new Set(openTabs.map((tab) => tab.id));
  const validNodeIds = new Set(project.nodes.map((node) => node.id));
  const activeTabId = validTabIds.has(raw.ui?.activeTabId) ? raw.ui.activeTabId : 'main';
  const selectedNodeId =
    raw.ui?.selectedNodeId && validNodeIds.has(raw.ui.selectedNodeId) ? raw.ui.selectedNodeId : null;

  return {
    version: 2,
    projectId: raw.projectId || createProjectId(),
    project,
    ui: {
      openTabs,
      activeTabId,
      selectedNodeId,
    },
  };
};

const serializeProjectFile = (
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

const fileNameFromTitle = (title: string) =>
  `${title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project-planner'}.json`;

const formatScopeTitle = (snapshot: PlannerSnapshot, scopeId: string | null | undefined) => {
  if (!scopeId) {
    return snapshot.root.title;
  }
  return snapshot.nodes.find((node) => node.id === scopeId)?.title ?? snapshot.root.title;
};

const nodeJournalStateFromNode = (node: PlannerNodeRecord, scopeTitle: string): NodeJournalState => ({
  id: node.id,
  kind: node.kind,
  title: node.title,
  description: node.description,
  completionCriteria: node.completionCriteria,
  status: node.status,
  scopeTitle,
});

const summarizeNodeJournalEntry = (entry: SessionJournalEntry): SessionJournalEntry => {
  const initial = entry.initialNodeState;
  const final = entry.finalNodeState ?? initial;

  if (!initial || !final || !entry.nodeAction) {
    return entry;
  }

  const label = final.title || initial.title || 'Untitled';
  const changes: string[] = [];

  if (initial.title !== final.title) {
    changes.push(`Renamed from ${initial.title || 'Untitled'} to ${final.title || 'Untitled'}.`);
  }
  if (initial.description !== final.description) {
    changes.push(final.description.trim() ? 'Updated description.' : 'Cleared description.');
  }
  if (initial.completionCriteria !== final.completionCriteria) {
    changes.push(final.completionCriteria.trim() ? 'Updated completion criteria.' : 'Cleared completion criteria.');
  }
  if (initial.status !== final.status) {
    changes.push(`Status changed from ${initial.status} to ${final.status}.`);
  }

  if (entry.nodeAction === 'created') {
    return {
      ...entry,
      type: 'create_node',
      title: `Created ${final.kind} ${label}`,
      detail: [`Added to ${final.scopeTitle}.`, ...changes].join(' '),
      scopeTitle: final.scopeTitle,
      completed: final.status === 'done',
    };
  }

  if (entry.nodeAction === 'deleted') {
    return {
      ...entry,
      type: 'delete_node',
      title: `Deleted ${initial.kind} ${initial.title || 'Untitled'}`,
      detail: changes.length > 0 ? `Removed from ${initial.scopeTitle}. Final session state before deletion: ${changes.join(' ')}` : `Removed from ${initial.scopeTitle}.`,
      scopeTitle: initial.scopeTitle,
      completed: false,
    };
  }

  return {
    ...entry,
    type: initial.status !== final.status && changes.length === 1 ? 'status_change' : 'update_node',
    title:
      initial.status !== final.status && changes.length === 1
        ? `${final.status === 'done' ? 'Completed' : 'Reopened'} ${label}`
        : `Updated ${final.kind} ${label}`,
    detail: changes.join(' ') || `Updated ${final.kind} details.`,
    scopeTitle: final.scopeTitle,
    completed: final.status === 'done',
  };
};

const mergeSessionJournalEntry = (current: SessionJournalEntry[], nextEntry: SessionJournalEntry): SessionJournalEntry[] => {
  if (!nextEntry.entityKey) {
    const lastEntry = current[current.length - 1];
    if (
      lastEntry &&
      !lastEntry.entityKey &&
      lastEntry.type === nextEntry.type &&
      lastEntry.title === nextEntry.title &&
      lastEntry.scopeTitle === nextEntry.scopeTitle
    ) {
      return [...current.slice(0, -1), nextEntry];
    }
    return [...current, nextEntry];
  }

  const existingIndex = current.findIndex((entry) => entry.entityKey === nextEntry.entityKey);
  if (existingIndex === -1) {
    return [...current, summarizeNodeJournalEntry(nextEntry)];
  }

  const existing = current[existingIndex];
  if (!existing.initialNodeState || !nextEntry.initialNodeState) {
    const merged = [...current];
    merged[existingIndex] = summarizeNodeJournalEntry(nextEntry);
    return merged;
  }

  if (existing.nodeAction === 'created' && nextEntry.nodeAction === 'deleted') {
    return current.filter((_, index) => index !== existingIndex);
  }

  const mergedEntry: SessionJournalEntry = {
    ...existing,
    ...nextEntry,
    entityKey: existing.entityKey,
    initialNodeState: existing.initialNodeState,
    finalNodeState: nextEntry.finalNodeState ?? existing.finalNodeState ?? existing.initialNodeState,
    nodeAction:
      nextEntry.nodeAction === 'deleted'
        ? 'deleted'
        : existing.nodeAction === 'created'
          ? 'created'
          : 'updated',
  };

  const merged = [...current];
  merged[existingIndex] = summarizeNodeJournalEntry(mergedEntry);
  return merged;
};

const summarizeProposalOperations = (proposal: AIProposal) =>
  proposal.operations
    .map((operation) => {
      if (operation.type === 'update_node_fields') {
        return `Updated ${operation.targetType === 'root' ? proposal.context.targetTitle : operation.targetId}`;
      }
      if (operation.type === 'create_group') {
        return `Created group ${operation.group.title}`;
      }
      if (operation.type === 'create_tasks') {
        return `Created ${operation.tasks.length} task${operation.tasks.length === 1 ? '' : 's'}`;
      }
      return `Added ${operation.edges.length} dependenc${operation.edges.length === 1 ? 'y' : 'ies'}`;
    })
    .join('; ');

type TagTreeNode = {
  id: string;
  label: string;
  path: string;
  isTag: boolean;
  children: TagTreeNode[];
};

const matchesTagQuery = (tag: string, query: string) => {
  if (!query) {
    return true;
  }
  return tag === query || tag.startsWith(`${query}.`);
};

const getAllKnownTags = (snapshot: PlannerSnapshot) =>
  Array.from(
    new Set([
      ...snapshot.root.tags.map(normalizeTag),
      ...snapshot.nodes.flatMap((node) => node.tags.map(normalizeTag)),
    ]),
  )
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

const buildTagTree = (tags: string[]): TagTreeNode[] => {
  const root = new Map<string, TagTreeNode>();
  const tagSet = new Set(tags);

  for (const tag of tags) {
    const parts = tag.split('.');
    let level = root;
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}.${part}` : part;
      if (!level.has(part)) {
        level.set(part, {
          id: currentPath,
          label: part,
          path: currentPath,
          isTag: tagSet.has(currentPath),
          children: [],
        });
      }

      const node = level.get(part)!;
      node.isTag = node.isTag || tagSet.has(currentPath);
      if (!(node as TagTreeNode & { childMap?: Map<string, TagTreeNode> }).childMap) {
        (node as TagTreeNode & { childMap?: Map<string, TagTreeNode> }).childMap = new Map();
      }
      level = (node as TagTreeNode & { childMap: Map<string, TagTreeNode> }).childMap;
    }
  }

  const materialize = (map: Map<string, TagTreeNode>): TagTreeNode[] =>
    Array.from(map.values()).map((node) => {
      const childMap = (node as TagTreeNode & { childMap?: Map<string, TagTreeNode> }).childMap;
      return {
        id: node.id,
        label: node.label,
        path: node.path,
        isTag: node.isTag,
        children: childMap ? materialize(childMap) : [],
      };
    });

  const sortTree = (nodes: TagTreeNode[]): TagTreeNode[] =>
    nodes
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((node) => ({
        ...node,
        children: sortTree(node.children),
      }));

  return sortTree(materialize(root));
};

const getChildren = (nodes: PlannerNodeRecord[], nodeId: string) => nodes.filter((node) => node.parentId === nodeId);

const getGroupPath = (nodes: PlannerNodeRecord[], groupId: string): PlannerNodeRecord[] => {
  const node = nodes.find((entry) => entry.id === groupId);
  if (!node) {
    return [];
  }

  const parentPath = node.parentId ? getGroupPath(nodes, node.parentId) : [];
  return [...parentPath, node];
};

const getDescendantNodeIds = (nodes: PlannerNodeRecord[], nodeId: string): string[] => {
  const children = getChildren(nodes, nodeId);
  return children.flatMap((child) => [child.id, ...getDescendantNodeIds(nodes, child.id)]);
};

const getDescendantTaskIds = (nodes: PlannerNodeRecord[], nodeId: string): string[] => {
  const children = getChildren(nodes, nodeId);
  return children.flatMap((child) => (child.kind === 'task' ? [child.id] : getDescendantTaskIds(nodes, child.id)));
};

const isNodeComplete = (nodes: PlannerNodeRecord[], nodeId: string): boolean => {
  const node = nodes.find((entry) => entry.id === nodeId);
  if (!node) {
    return false;
  }

  if (node.kind === 'task') {
    return node.status === 'done';
  }

  const descendants = getDescendantTaskIds(nodes, nodeId);
  return descendants.length > 0 && descendants.every((taskId) => isNodeComplete(nodes, taskId));
};

const getIncomingEdges = (edges: PlannerEdgeRecord[], nodeId: string) => edges.filter((edge) => edge.target === nodeId);

const getAncestorGroupIds = (nodes: PlannerNodeRecord[], nodeId: string): string[] => {
  const node = nodes.find((entry) => entry.id === nodeId);
  if (!node?.parentId) {
    return [];
  }

  return [node.parentId, ...getAncestorGroupIds(nodes, node.parentId)];
};

const isTaskAvailable = (nodes: PlannerNodeRecord[], edges: PlannerEdgeRecord[], node: PlannerNodeRecord) => {
  if (node.kind !== 'task' || node.status === 'done') {
    return false;
  }

  const inheritedBlockers = getAncestorGroupIds(nodes, node.id).flatMap((groupId) => getIncomingEdges(edges, groupId));
  const blockers = [...getIncomingEdges(edges, node.id), ...inheritedBlockers];
  return blockers.every((edge) => isNodeComplete(nodes, edge.source));
};

const isGroupAvailable = (nodes: PlannerNodeRecord[], edges: PlannerEdgeRecord[], node: PlannerNodeRecord) => {
  if (node.kind !== 'group' || isNodeComplete(nodes, node.id)) {
    return false;
  }

  return getIncomingEdges(edges, node.id).every((edge) => isNodeComplete(nodes, edge.source));
};

const countGroupProgress = (nodes: PlannerNodeRecord[], nodeId: string) => {
  const descendants = getDescendantTaskIds(nodes, nodeId);
  const done = descendants.filter((taskId) => isNodeComplete(nodes, taskId)).length;
  return { done, total: descendants.length };
};

const countImmediateChildren = (nodes: PlannerNodeRecord[], nodeId: string) => getChildren(nodes, nodeId).length;

const getScopeNodes = (nodes: PlannerNodeRecord[], scopeId: ScopeId) => nodes.filter((node) => getNodeScope(node) === scopeId);

const getScopeEdges = (nodes: PlannerNodeRecord[], edges: PlannerEdgeRecord[], scopeId: ScopeId) => {
  const scopedNodeIds = new Set(getScopeNodes(nodes, scopeId).map((node) => node.id));
  return edges.filter((edge) => scopedNodeIds.has(edge.source) && scopedNodeIds.has(edge.target));
};

const wouldCreateCycle = (edges: PlannerEdgeRecord[], source: string, target: string) => {
  if (source === target) {
    return true;
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const current = adjacency.get(edge.source) ?? [];
    current.push(edge.target);
    adjacency.set(edge.source, current);
  }

  const stack = [target];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === source) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      stack.push(next);
    }
  }

  return false;
};

const getDefaultNodeSize = (node: PlannerNodeRecord) => (node.kind === 'group' ? groupSize : taskSize);

const getFlowNodeDimensions = (node: PlannerFlowNode) => ({
  width: Number(node.style?.width ?? node.width ?? (node.type === 'plannerGroup' ? groupSize.width : taskSize.width)),
  height: Number(node.style?.height ?? node.height ?? (node.type === 'plannerGroup' ? groupSize.height : taskSize.height)),
});

const getNodeCenter = (node: PlannerFlowNode) => {
  const { width, height } = getFlowNodeDimensions(node);
  return {
    x: node.position.x + width / 2,
    y: node.position.y + height / 2,
    width,
    height,
  };
};

const getRectBoundaryPoint = (
  rect: { x: number; y: number; width: number; height: number },
  toward: { x: number; y: number },
) => {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const deltaX = toward.x - centerX;
  const deltaY = toward.y - centerY;

  if (deltaX === 0 && deltaY === 0) {
    return { x: centerX, y: centerY };
  }

  const scaleX = deltaX === 0 ? Number.POSITIVE_INFINITY : rect.width / 2 / Math.abs(deltaX);
  const scaleY = deltaY === 0 ? Number.POSITIVE_INFINITY : rect.height / 2 / Math.abs(deltaY);
  const scale = Math.min(scaleX, scaleY);

  return {
    x: centerX + deltaX * scale,
    y: centerY + deltaY * scale,
  };
};

const buildDragPreviewPath = (sourceNode: PlannerFlowNode, targetNode: PlannerFlowNode) => {
  const source = getNodeCenter(sourceNode);
  const target = getNodeCenter(targetNode);
  const sourcePoint = getRectBoundaryPoint(
    { x: sourceNode.position.x, y: sourceNode.position.y, width: source.width, height: source.height },
    { x: target.x, y: target.y },
  );
  const targetPoint = getRectBoundaryPoint(
    { x: targetNode.position.x, y: targetNode.position.y, width: target.width, height: target.height },
    { x: source.x, y: source.y },
  );

  return `M ${sourcePoint.x} ${sourcePoint.y} L ${targetPoint.x} ${targetPoint.y}`;
};

const getRelativeChildPosition = (
  childPosition: { x: number; y: number },
  parentPosition: { x: number; y: number },
): { x: number; y: number } => ({
  x: Math.max(60, childPosition.x - parentPosition.x),
  y: Math.max(80, childPosition.y - parentPosition.y),
});

const getEdgeIdFromDomElement = (element: Element | null): string | null => {
  if (!element) {
    return null;
  }

  const edgeElement = element.closest('.react-flow__edge') as HTMLElement | null;
  if (!edgeElement) {
    return null;
  }

  const dataId = edgeElement.getAttribute('data-id');
  if (dataId) {
    return dataId;
  }

  const domId = edgeElement.getAttribute('id');
  if (domId?.startsWith('reactflow__edge-')) {
    return domId.slice('reactflow__edge-'.length);
  }

  return null;
};

const buildFlowNodes = (
  nodes: PlannerNodeRecord[],
  scopeNodes: PlannerNodeRecord[],
  allEdges: PlannerEdgeRecord[],
  selectedNodeId: string | null,
  selectedNodeIds: string[],
  toolbarNodeId: string | null,
  dropTargetNodeId: string | null,
  onToggleComplete: (nodeId: string) => void,
  onSplit: (nodeId: string) => void,
  onOpen: (nodeId: string) => void,
  onDelete: (nodeId: string) => void,
): PlannerFlowNode[] =>
  scopeNodes.map((node) => {
    const isComplete = isNodeComplete(nodes, node.id);
    const isAvailable = node.kind === 'group' ? isGroupAvailable(nodes, allEdges, node) : isTaskAvailable(nodes, allEdges, node);
    const progress = node.kind === 'group' ? countGroupProgress(nodes, node.id) : null;
    const childCount = node.kind === 'group' ? countImmediateChildren(nodes, node.id) : null;

    return {
      id: node.id,
      position: node.position,
      draggable: true,
      selected: selectedNodeIds.includes(node.id) || node.id === selectedNodeId,
      type: node.kind === 'group' ? 'plannerGroup' : 'plannerTask',
      data: {
        title: node.title,
        kind: node.kind,
        status: node.kind === 'group' ? (isComplete ? 'done' : 'todo') : node.status,
        isAvailable,
        isBlocked: !isAvailable && !isComplete,
        isDropTarget: node.id === dropTargetNodeId,
        completionLabel:
          node.kind === 'group'
            ? progress && progress.total > 0
              ? `${progress.done}/${progress.total} complete`
              : 'empty group'
            : undefined,
        progressPercent: node.kind === 'group' ? (progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0) : undefined,
        childSummary: node.kind === 'group' ? `${childCount} direct items` : undefined,
        onToggleComplete: () => onToggleComplete(node.id),
        onSplit: () => onSplit(node.id),
        onOpen: () => onOpen(node.id),
        onDelete: () => onDelete(node.id),
        canToggleComplete: node.kind === 'task',
        canSplit: node.kind === 'task',
        canOpen: node.kind === 'group',
        showActions: node.id === toolbarNodeId,
      },
      style: {
        width: node.kind === 'group' ? groupSize.width : node.size?.width ?? getDefaultNodeSize(node).width,
        height: node.kind === 'group' ? groupSize.height : node.size?.height ?? getDefaultNodeSize(node).height,
      },
    } as PlannerFlowNode;
  });

const buildFlowEdges = (
  edges: PlannerEdgeRecord[],
  selectedEdgeId: string | null,
  insertionEdgeId: string | null,
  dragPreviewEdge: DragPreviewEdge | null,
): Edge[] => {
  const flowEdges: Edge[] = edges.map((edge): Edge => {
    const isInsertionTarget = edge.id === insertionEdgeId;
    const isSelected = edge.id === selectedEdgeId;
    const isHighlighted = isInsertionTarget || isSelected;

    return {
      ...edge,
      animated: isInsertionTarget,
      selectable: true,
      selected: isSelected,
      className: isHighlighted ? 'planner-edge is-insertion-target' : 'planner-edge',
      style: {
        strokeWidth: isHighlighted ? 3.5 : 1.75,
        stroke: isHighlighted ? '#fd6f85' : undefined,
      },
    };
  });

  if (!dragPreviewEdge) {
    return flowEdges;
  }

  flowEdges.push({
    id: '__drag-preview__',
    source: dragPreviewEdge.source,
    target: dragPreviewEdge.target,
    type: 'dragPreview',
    animated: false,
    className: 'planner-edge is-drag-preview',
    data: { path: dragPreviewEdge.path },
    style: {
      strokeWidth: 2.5,
      stroke: '#e1c3ff',
    },
  });

  return flowEdges;
};

const getStoredTheme = (): ThemeMode => {
  return 'dark';
};

const clampRightPanelWidth = (value: number) => Math.min(720, Math.max(360, value));

const getStoredRightPanelWidth = () => {
  if (typeof window === 'undefined') {
    return 440;
  }

  const raw = window.localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? clampRightPanelWidth(parsed) : 440;
};

const nextAvailableOffset = (nodes: PlannerNodeRecord[], parentId?: string) => {
  const siblings = nodes.filter((node) => node.parentId === parentId);
  return {
    x: 90 + (siblings.length % 4) * 120,
    y: 110 + Math.floor(siblings.length / 4) * 120,
  };
};

const getAIContext = (
  snapshot: PlannerSnapshot,
  selectedNodeId: string | null,
  activeScopeId: ScopeId,
): AIContext => {
  const selectedNode = selectedNodeId ? snapshot.nodes.find((node) => node.id === selectedNodeId) ?? null : null;
  if (selectedNode) {
    return {
      targetType: selectedNode.kind === 'group' ? 'group' : 'node',
      targetId: selectedNode.id,
      targetTitle: selectedNode.title,
      scopeId: getNodeScope(selectedNode),
    };
  }

  if (activeScopeId) {
    const activeScopeNode = snapshot.nodes.find((node) => node.id === activeScopeId) ?? null;
    if (activeScopeNode) {
      return {
        targetType: 'group',
        targetId: activeScopeNode.id,
        targetTitle: activeScopeNode.title,
        scopeId: getNodeScope(activeScopeNode),
      };
    }
  }

  return {
    targetType: 'root',
    targetId: null,
    targetTitle: snapshot.root.title,
    scopeId: null,
  };
};

const describeOperation = (operation: GraphMutationOperation) => {
  if (operation.type === 'update_node_fields') {
    const changedFields = Object.keys(operation.fields).join(', ');
    return `Update ${operation.targetType === 'root' ? 'root graph' : operation.targetId} fields: ${changedFields}`;
  }

  if (operation.type === 'create_group') {
    return `Create group "${operation.group.title}"`;
  }

  if (operation.type === 'create_tasks') {
    return `Create ${operation.tasks.length} task${operation.tasks.length === 1 ? '' : 's'}`;
  }

  return `Create ${operation.edges.length} dependenc${operation.edges.length === 1 ? 'y' : 'ies'}`;
};

const formatProposalTarget = (value: string) => value.replace(/^root$/, 'Root graph');

const getProposalNodeLabels = (proposal: AIProposal) => {
  const labels = new Map<string, string>();

  for (const operation of proposal.operations) {
    if (operation.type === 'create_group') {
      labels.set(operation.group.id, operation.group.title);
      continue;
    }

    if (operation.type === 'create_tasks') {
      for (const task of operation.tasks) {
        labels.set(task.id, task.title);
      }
    }
  }

  return labels;
};

const getProposalDependencyLines = (proposal: AIProposal) => {
  const labels = getProposalNodeLabels(proposal);
  const lines: string[] = [];

  for (const operation of proposal.operations) {
    if (operation.type !== 'create_edges') {
      continue;
    }

    for (const edge of operation.edges) {
      const source = labels.get(edge.source) ?? edge.source;
      const target = labels.get(edge.target) ?? edge.target;
      lines.push(`${target} depends on ${source}.`);
    }
  }

  return lines;
};

const ensureUniqueNodeId = (nodes: PlannerNodeRecord[], proposedId: string, prefix: string) => {
  if (!nodes.some((node) => node.id === proposedId)) {
    return proposedId;
  }

  let nextId = proposedId;
  while (nodes.some((node) => node.id === nextId)) {
    nextId = uid(prefix);
  }
  return nextId;
};

const ensureUniqueEdgeId = (edges: PlannerEdgeRecord[], proposedId: string) => {
  if (!edges.some((edge) => edge.id === proposedId)) {
    return proposedId;
  }

  let nextId = proposedId;
  while (edges.some((edge) => edge.id === nextId)) {
    nextId = uid('edge');
  }
  return nextId;
};

const applyAIProposalToSnapshot = (snapshot: PlannerSnapshot, proposal: AIProposal): PlannerSnapshot => {
  let nextSnapshot: PlannerSnapshot = {
    root: { ...snapshot.root, tags: [...snapshot.root.tags] },
    nodes: snapshot.nodes.map((node) => ({ ...node, tags: [...node.tags] })),
    edges: snapshot.edges.map((edge) => ({ ...edge })),
  };

  const idMap = new Map<string, string>();

  for (const operation of proposal.operations) {
    if (operation.type === 'update_node_fields') {
      if (operation.targetType === 'root') {
        nextSnapshot = {
          ...nextSnapshot,
          root: {
            ...nextSnapshot.root,
            ...operation.fields,
          },
        };
      } else {
        nextSnapshot = {
          ...nextSnapshot,
          nodes: nextSnapshot.nodes.map((node) =>
            node.id === operation.targetId
              ? {
                  ...node,
                  ...operation.fields,
                }
              : node,
          ),
        };
      }
      continue;
    }

    if (operation.type === 'create_group') {
      const finalId = ensureUniqueNodeId(nextSnapshot.nodes, operation.group.id, 'group');
      idMap.set(operation.group.id, finalId);
      nextSnapshot = {
        ...nextSnapshot,
        nodes: [
          ...nextSnapshot.nodes,
          {
            id: finalId,
            kind: 'group',
            title: operation.group.title,
            status: 'todo',
            position: operation.group.position,
            description: operation.group.description,
            completionCriteria: operation.group.completionCriteria,
            tags: operation.group.tags ?? [],
            parentId: operation.group.parentId,
            size: operation.group.size ?? { ...groupSize },
          },
        ],
      };
      continue;
    }

    if (operation.type === 'create_tasks') {
      const newTasks = operation.tasks.map((task) => {
        const finalId = ensureUniqueNodeId(nextSnapshot.nodes, task.id, 'task');
        idMap.set(task.id, finalId);
        return {
          id: finalId,
          kind: 'task' as const,
          title: task.title,
          status: 'todo' as const,
          position: task.position,
          description: task.description,
          completionCriteria: task.completionCriteria,
          tags: task.tags ?? [],
          parentId: task.parentId,
        };
      });

      nextSnapshot = {
        ...nextSnapshot,
        nodes: [...nextSnapshot.nodes, ...newTasks],
      };
      continue;
    }

    if (operation.type === 'create_edges') {
      const nextEdges = operation.edges
        .map((edge) => ({
          id: ensureUniqueEdgeId(nextSnapshot.edges, edge.id),
          source: idMap.get(edge.source) ?? edge.source,
          target: idMap.get(edge.target) ?? edge.target,
        }))
        .filter((edge) => !nextSnapshot.edges.some((existing) => existing.source === edge.source && existing.target === edge.target))
        .filter((edge) => !wouldCreateCycle(nextSnapshot.edges, edge.source, edge.target));

      nextSnapshot = {
        ...nextSnapshot,
        edges: [...nextSnapshot.edges, ...nextEdges],
      };
    }
  }

  return nextSnapshot;
};

const buildAgentGraphFlowNodes = (graph: AIGraphResponse): AgentGraphFlowNode[] => {
  const positions: Record<string, { x: number; y: number }> = {
    __start__: { x: 70, y: 180 },
    router: { x: 250, y: 180 },
    context_assembler: { x: 500, y: 180 },
    task_draft: { x: 790, y: 80 },
    memory_edit: { x: 790, y: 280 },
    reviewer: { x: 1080, y: 180 },
    formatter: { x: 1360, y: 180 },
    consolidation: { x: 1620, y: 180 },
    __end__: { x: 1880, y: 180 },
  };

  return graph.nodes.map((node) => ({
    id: node.id,
    type: node.kind === 'entry' || node.kind === 'terminal' ? 'agentPill' : 'agentCard',
    position: positions[node.id] ?? { x: 0, y: 0 },
    data: {
      label: node.label,
      kind: node.kind,
      description: node.description,
    },
    style:
      node.kind === 'entry' || node.kind === 'terminal'
        ? { width: 156, height: 60 }
        : { width: 256, height: 136 },
    draggable: false,
    selectable: true,
  }));
};

const buildAgentGraphFlowEdges = (graph: AIGraphResponse): Edge[] =>
  graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    animated: edge.type === 'conditional',
    style:
      edge.type === 'conditional'
        ? { stroke: '#fd6f85', strokeWidth: 2.2 }
        : edge.type === 'end'
          ? { stroke: '#8bd6b4', strokeWidth: 1.8 }
          : { stroke: '#e1c3ff', strokeWidth: 1.9 },
    labelStyle:
      edge.type === 'conditional'
        ? { fill: '#ffe4e6', fontSize: 11, fontWeight: 700 }
        : { fill: '#cfd3da', fontSize: 11, fontWeight: 600 },
    labelBgPadding: [6, 4],
    labelBgBorderRadius: 999,
    labelBgStyle:
      edge.type === 'conditional'
        ? { fill: '#38131f', fillOpacity: 0.96, stroke: '#fd6f85' }
        : { fill: '#171a1d', fillOpacity: 0.95, stroke: '#44484c' },
  }));

const ToolbarIcon = ({ path }: { path: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={path} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Graph3Icon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="7" cy="6" r="2.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="17" cy="9" r="2.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="10" cy="18" r="2.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M8.9 7.2 15 8.1M15.6 10.9l-4 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const NodeActions = ({ data }: { data: RenderNodeData }) => (
  <div className="node-actions nodrag nopan">
    {data.kind === 'task' ? (
      <>
        <button
          type="button"
          className="node-actions__button is-complete nodrag nopan"
          onClick={(event) => {
            event.stopPropagation();
            data.onToggleComplete();
          }}
          disabled={!data.canToggleComplete}
          aria-label={data.status === 'done' ? 'Mark as incomplete' : 'Mark as complete'}
          title={data.status === 'done' ? 'Mark as incomplete' : 'Mark as complete'}
        >
          <ToolbarIcon path="M5 12.5 9.2 16.5 19 7.5" />
        </button>
        <button
          type="button"
          className="node-actions__button is-split nodrag nopan"
          onClick={(event) => {
            event.stopPropagation();
            data.onSplit();
          }}
          disabled={!data.canSplit}
          aria-label="Split"
          title="Split"
        >
          <ToolbarIcon path="M7 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM8.8 8.2l6.4 6.4M15.2 8.2 8.8 14.6" />
        </button>
      </>
    ) : (
      <button
        type="button"
        className="node-actions__button is-open nodrag nopan"
        onClick={(event) => {
          event.stopPropagation();
          data.onOpen();
        }}
        disabled={!data.canOpen}
        aria-label="Open"
        title="Open"
      >
        <ToolbarIcon path="M4 12h10m0 0-4-4m4 4-4 4M20 5v14" />
      </button>
    )}
    <button
      type="button"
      className="node-actions__button is-delete nodrag nopan"
      onClick={(event) => {
        event.stopPropagation();
        data.onDelete();
      }}
      aria-label="Delete"
      title="Delete"
    >
      <ToolbarIcon path="M7 7 17 17M17 7 7 17" />
    </button>
  </div>
);

const TaskNode = ({ data, selected }: NodeProps<PlannerFlowNode>) => (
  <div
    title={data.title}
    className={[
      'task-node',
      data.status === 'done' ? 'is-complete' : '',
      data.isAvailable ? 'is-available' : '',
      data.isBlocked ? 'is-blocked' : '',
      data.isDropTarget ? 'is-drop-target' : '',
      selected ? 'is-selected' : '',
    ].join(' ')}
  >
    {selected && data.showActions ? <NodeActions data={data} /> : null}
    <Handle type="target" position={Position.Left} className="handle" />
    <div className="task-node__header">
      <div className="task-node__eyebrow">Task</div>
      <span className="task-node__indicator" aria-hidden="true" />
    </div>
    <div className="task-node__title">{data.title}</div>
    <div className="task-node__footer">
      <span>{data.status === 'done' ? 'Completed' : data.isBlocked ? 'Blocked' : 'Available now'}</span>
    </div>
    <Handle type="source" position={Position.Right} className="handle" />
  </div>
);

const GroupNode = ({ data, selected }: NodeProps<PlannerFlowNode>) => (
  <div
    title={data.title}
    className={[
      'group-entry-node',
      data.isAvailable ? 'is-available' : '',
      data.isBlocked ? 'is-blocked' : '',
      selected ? 'is-selected' : '',
      data.status === 'done' ? 'is-complete' : '',
      data.isDropTarget ? 'is-drop-target' : '',
    ].join(' ')}
  >
    {selected && data.showActions ? <NodeActions data={data} /> : null}
    <Handle type="target" position={Position.Left} className="handle" />
    <div className="group-entry-node__header">
      <div className="group-entry-node__eyebrow">Node Group</div>
      <div className="group-entry-node__status">{data.completionLabel}</div>
    </div>
    <div className="group-entry-node__title">{data.title}</div>
    <div className="group-entry-node__progress-row">
      <div className="group-entry-node__progress-bar" aria-hidden="true">
        <div
          className="group-entry-node__progress-fill"
          style={{ width: `${Math.max(0, Math.min(100, data.progressPercent ?? 0))}%` }}
        />
      </div>
      <div className="group-entry-node__metric">{Math.round(data.progressPercent ?? 0)}%</div>
    </div>
    <div className="group-entry-node__hint">{data.childSummary} · Double-click to open</div>
    <Handle type="source" position={Position.Right} className="handle" />
  </div>
);

const DragPreviewFlowEdge = ({ id, markerEnd, data }: EdgeProps<Edge<{ path?: string }>>) => {
  if (!data?.path) {
    return null;
  }

  return <BaseEdge id={id} path={data.path} markerEnd={markerEnd} interactionWidth={0} />;
};

const AgentPillNode = ({ data, selected }: NodeProps<AgentGraphFlowNode>) => (
  <div className={['agent-pill-node', `is-${data.kind}`, selected ? 'is-selected' : ''].join(' ')} data-kind={data.kind}>
    <Handle type="target" position={Position.Left} className="handle handle--agent" />
    <div className="agent-pill-node__label">{data.label}</div>
    <Handle type="source" position={Position.Right} className="handle handle--agent" />
  </div>
);

const AgentCardNode = ({ data, selected }: NodeProps<AgentGraphFlowNode>) => (
  <div className={['agent-card-node', `is-${data.kind}`, selected ? 'is-selected' : ''].join(' ')} data-kind={data.kind}>
    <Handle type="target" position={Position.Left} className="handle handle--agent" />
    <div className="agent-card-node__eyebrow">{data.kind}</div>
    <div className="agent-card-node__title">{data.label}</div>
    <div className="agent-card-node__description">{data.description}</div>
    <Handle type="source" position={Position.Right} className="handle handle--agent" />
  </div>
);

const nodeTypes = {
  plannerTask: TaskNode,
  plannerGroup: GroupNode,
};

const edgeTypes = {
  dragPreview: DragPreviewFlowEdge,
};

const agentGraphNodeTypes = {
  agentPill: AgentPillNode,
  agentCard: AgentCardNode,
};

const TagTree = ({
  nodes,
  selectedTags,
  onToggle,
}: {
  nodes: TagTreeNode[];
  selectedTags: string[];
  onToggle: (tag: string) => void;
}) => (
  <div className="tag-tree">
    {nodes.map((node) => (
      <div key={node.path} className="tag-tree__branch">
        <button
          type="button"
          className={[
            'tag-tree__item',
            selectedTags.includes(node.path) ? 'is-selected' : '',
            node.isTag ? '' : 'is-branch',
          ].join(' ')}
          onClick={() => (node.isTag ? onToggle(node.path) : undefined)}
        >
          <span className="tag-tree__caret">{node.children.length > 0 ? '▾' : '·'}</span>
          <span>{node.label}</span>
        </button>
        {node.children.length > 0 ? (
          <div className="tag-tree__children">
            <TagTree nodes={node.children} selectedTags={selectedTags} onToggle={onToggle} />
          </div>
        ) : null}
      </div>
    ))}
  </div>
);

function PlannerApp() {
  const { screenToFlowPosition, setCenter, getZoom, fitView, getViewport } = useReactFlow();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const aiDocumentInputRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [projectId, setProjectId] = useState<string>(() => getStoredProjectId());
  const [snapshot, setSnapshot] = useState<PlannerSnapshot>(() => getStoredSnapshot());
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredTheme());
  const [openTabs, setOpenTabs] = useState<TabDescriptor[]>([mainTab, aiGraphTab]);
  const [activeTabId, setActiveTabId] = useState<string>('main');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [fileFeedback, setFileFeedback] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [tagQuery, setTagQuery] = useState('');
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(false);
  const [shouldFocusSelectedTitle, setShouldFocusSelectedTitle] = useState(false);
  const [insertionEdgeId, setInsertionEdgeId] = useState<string | null>(null);
  const [pendingCenteredNodeId, setPendingCenteredNodeId] = useState<string | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('properties');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>({
    backendStatus: 'offline',
    openai: {
      hasApiKey: false,
      selectedModel: null,
    },
    notion: {
      tokenConfigured: false,
      notesDatabaseId: null,
      progressDatabaseId: null,
      useNotesForAiContext: false,
      enableProgressSync: false,
      progressFieldMap: {},
      notesFieldMap: {},
    },
  });
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [notionSettingsError, setNotionSettingsError] = useState<string | null>(null);
  const [notionSettingsMessage, setNotionSettingsMessage] = useState<string | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [isModelsLoading, setIsModelsLoading] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [selectedModelDraft, setSelectedModelDraft] = useState<string>('');
  const [notionTokenDraft, setNotionTokenDraft] = useState('');
  const [notionNotesDatabaseIdDraft, setNotionNotesDatabaseIdDraft] = useState('');
  const [notionProgressDatabaseIdDraft, setNotionProgressDatabaseIdDraft] = useState('');
  const [notionProgressFieldMapDraft, setNotionProgressFieldMapDraft] = useState<Record<NotionProgressFieldKey, string>>({
    titleField: '',
    projectNameField: '',
    syncedAtField: '',
    changedCountField: '',
    completedCountField: '',
    scopeField: '',
  });
  const [notionNotesFieldMapDraft, setNotionNotesFieldMapDraft] = useState<Record<NotionNotesFieldKey, string>>({
    titleField: '',
    summaryField: '',
    statusField: '',
    tagsField: '',
    scopeField: '',
  });
  const [notionProgressSchema, setNotionProgressSchema] = useState<NotionDatabaseSchemaResponse | null>(null);
  const [notionNotesSchema, setNotionNotesSchema] = useState<NotionDatabaseSchemaResponse | null>(null);
  const [isNotionProgressSchemaLoading, setIsNotionProgressSchemaLoading] = useState(false);
  const [isNotionNotesSchemaLoading, setIsNotionNotesSchemaLoading] = useState(false);
  const [useNotionNotesForAiContextDraft, setUseNotionNotesForAiContextDraft] = useState(false);
  const [enableNotionProgressSyncDraft, setEnableNotionProgressSyncDraft] = useState(false);
  const [isNotionSyncing, setIsNotionSyncing] = useState(false);
  const [sessionJournal, setSessionJournal] = useState<SessionJournalEntry[]>([]);
  const [aiMessages, setAiMessages] = useState<AIConversationMessage[]>([
    {
      id: 'assistant-welcome',
      role: 'assistant',
      content:
        'Use this assistant to draft graph changes or capture project memory. Graph mutations stay in preview until you apply them, while memory updates are summarized directly in the panel.',
    },
  ]);
  const [aiInput, setAiInput] = useState('');
  const [isAiBusy, setIsAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [pendingProposal, setPendingProposal] = useState<AIProposal | null>(null);
  const [pendingMemoryResult, setPendingMemoryResult] = useState<AIMemoryResult | null>(null);
  const [isApplyingProposal, setIsApplyingProposal] = useState(false);
  const [isProposalRevisionOpen, setIsProposalRevisionOpen] = useState(false);
  const [proposalRevisionDraft, setProposalRevisionDraft] = useState('');
  const [rightPanelWidth, setRightPanelWidth] = useState(() => getStoredRightPanelWidth());
  const [isAiDialogMinimized, setIsAiDialogMinimized] = useState(false);
  const [aiDocuments, setAiDocuments] = useState<AIDocument[]>([]);
  const [isUploadingAiDocuments, setIsUploadingAiDocuments] = useState(false);
  const [isAiDropActive, setIsAiDropActive] = useState(false);
  const [aiGraph, setAiGraph] = useState<AIGraphResponse | null>(null);
  const [isAIGraphLoading, setIsAIGraphLoading] = useState(false);
  const [aiGraphError, setAIGraphError] = useState<string | null>(null);
  const [selectedAIGraphNodeId, setSelectedAIGraphNodeId] = useState<string | null>(null);
  const [dragDropTarget, setDragDropTarget] = useState<NodeDropTarget>(null);
  const [dragPreviewNodeId, setDragPreviewNodeId] = useState<string | null>(null);
  const [flowViewport, setFlowViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [isCanvasPointerDown, setIsCanvasPointerDown] = useState(false);
  const isResizingPanelRef = useRef(false);
  const canvasNodesRef = useRef<PlannerFlowNode[]>([]);

  const isAIGraphTabActive = activeTabId === 'ai-graph';
  const activeScopeId: ScopeId = activeTabId === 'main' || isAIGraphTabActive ? null : activeTabId;
  const isAiAvailable = appSettings.backendStatus === 'online' && appSettings.openai.hasApiKey;
  const isNotionProgressSyncAvailable =
    appSettings.backendStatus === 'online' &&
    appSettings.notion.tokenConfigured &&
    appSettings.notion.enableProgressSync &&
    Boolean(appSettings.notion.progressDatabaseId);

  const appendSessionJournal = useCallback((entry: SessionJournalEntry | SessionJournalEntry[]) => {
    const nextEntries = Array.isArray(entry) ? entry : [entry];
    setSessionJournal((current) => nextEntries.reduce(mergeSessionJournalEntry, current));
  }, []);

  const scopeNodes = useMemo(() => getScopeNodes(snapshot.nodes, activeScopeId), [snapshot.nodes, activeScopeId]);
  const scopeEdges = useMemo(
    () => getScopeEdges(snapshot.nodes, snapshot.edges, activeScopeId),
    [snapshot.nodes, snapshot.edges, activeScopeId],
  );
  const [canvasNodes, setCanvasNodes] = useState<PlannerFlowNode[]>([]);
  const agentGraphFlowNodes = useMemo(() => (aiGraph ? buildAgentGraphFlowNodes(aiGraph) : []), [aiGraph]);
  const agentGraphFlowEdges = useMemo(() => (aiGraph ? buildAgentGraphFlowEdges(aiGraph) : []), [aiGraph]);

  useEffect(() => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(serializeProjectFile(projectId, snapshot, openTabs, activeTabId, selectedNodeId)),
    );
  }, [projectId, snapshot, openTabs, activeTabId, selectedNodeId]);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    window.localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(rightPanelWidth));
  }, [rightPanelWidth]);

  const loadModels = useCallback(
    async (options?: { silentNoKey?: boolean }) => {
      setIsModelsLoading(true);
      setSettingsError(null);

      try {
        const models = await fetchModels();
        setModelOptions(models);
      } catch (error) {
        if (
          options?.silentNoKey &&
          error instanceof ApiError &&
          error.status === 400 &&
          error.message === 'Configure an OpenAI API key first.'
        ) {
          setModelOptions([]);
          return;
        }

        setSettingsError(error instanceof Error ? error.message : 'Could not load available models.');
        setModelOptions([]);
      } finally {
        setIsModelsLoading(false);
      }
    },
    [],
  );

  const loadSettings = useCallback(async () => {
    setIsSettingsLoading(true);
    setSettingsError(null);

    try {
      const settings = await fetchSettings();
      setAppSettings(settings);
      setSelectedModelDraft(settings.openai.selectedModel ?? '');
      setNotionNotesDatabaseIdDraft(settings.notion.notesDatabaseId ?? '');
      setNotionProgressDatabaseIdDraft(settings.notion.progressDatabaseId ?? '');
      setNotionProgressFieldMapDraft({
        titleField: settings.notion.progressFieldMap?.titleField ?? '',
        projectNameField: settings.notion.progressFieldMap?.projectNameField ?? '',
        syncedAtField: settings.notion.progressFieldMap?.syncedAtField ?? '',
        changedCountField: settings.notion.progressFieldMap?.changedCountField ?? '',
        completedCountField: settings.notion.progressFieldMap?.completedCountField ?? '',
        scopeField: settings.notion.progressFieldMap?.scopeField ?? '',
      });
      setNotionNotesFieldMapDraft({
        titleField: settings.notion.notesFieldMap?.titleField ?? '',
        summaryField: settings.notion.notesFieldMap?.summaryField ?? '',
        statusField: settings.notion.notesFieldMap?.statusField ?? '',
        tagsField: settings.notion.notesFieldMap?.tagsField ?? '',
        scopeField: settings.notion.notesFieldMap?.scopeField ?? '',
      });
      setUseNotionNotesForAiContextDraft(settings.notion.useNotesForAiContext);
      setEnableNotionProgressSyncDraft(settings.notion.enableProgressSync);
      if (settings.openai.hasApiKey) {
        await loadModels();
      } else {
        setModelOptions([]);
      }
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : 'Could not reach the AI backend.');
      setAppSettings((current) => ({
        ...current,
        backendStatus: 'offline',
        openai: {
          hasApiKey: false,
          selectedModel: null,
        },
        notion: {
          tokenConfigured: false,
          notesDatabaseId: null,
          progressDatabaseId: null,
          useNotesForAiContext: false,
          enableProgressSync: false,
          progressFieldMap: {},
          notesFieldMap: {},
        },
      }));
      setModelOptions([]);
    } finally {
      setIsSettingsLoading(false);
    }
  }, [loadModels]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const loadAIGraph = useCallback(async () => {
    setIsAIGraphLoading(true);
    setAIGraphError(null);

    try {
      const nextGraph = await fetchAIGraph();
      setAiGraph(nextGraph);
      setSelectedAIGraphNodeId((current) => current ?? nextGraph.nodes[0]?.id ?? null);
    } catch (error) {
      setAIGraphError(error instanceof Error ? error.message : 'Could not load the AI graph overview.');
    } finally {
      setIsAIGraphLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAIGraphTabActive && !aiGraph && !isAIGraphLoading) {
      void loadAIGraph();
    }
  }, [isAIGraphTabActive, aiGraph, isAIGraphLoading, loadAIGraph]);

  useEffect(() => {
    if (!aiGraph) {
      return;
    }
    if (!selectedAIGraphNodeId || !aiGraph.nodes.some((node) => node.id === selectedAIGraphNodeId)) {
      setSelectedAIGraphNodeId(aiGraph.nodes[0]?.id ?? null);
    }
  }, [aiGraph, selectedAIGraphNodeId]);

  useEffect(() => {
    if (!isAIGraphTabActive || !aiGraph || agentGraphFlowNodes.length === 0) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      void fitView({ padding: 0.18, duration: 240, minZoom: 0.45, maxZoom: 1.2 });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [isAIGraphTabActive, aiGraph, agentGraphFlowNodes.length, fitView]);

  useEffect(() => {
    if (selectedNodeId && !scopeNodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [activeTabId, scopeNodes, selectedNodeId]);

  useEffect(() => {
    setSelectedNodeIds((current) => current.filter((nodeId) => scopeNodes.some((node) => node.id === nodeId)));
  }, [scopeNodes]);

  useEffect(() => {
    if (toolbarNodeId && !scopeNodes.some((node) => node.id === toolbarNodeId)) {
      setToolbarNodeId(null);
    }
  }, [activeTabId, scopeNodes, toolbarNodeId]);

  useEffect(() => {
    if (selectedEdgeId && !scopeEdges.some((edge) => edge.id === selectedEdgeId)) {
      setSelectedEdgeId(null);
    }
  }, [scopeEdges, selectedEdgeId]);

  useEffect(() => {
    setTagQuery('');
  }, [activeTabId, selectedNodeId]);

  useEffect(() => {
    if (isSettingsOpen) {
      setSettingsMessage(null);
      setNotionSettingsMessage(null);
    }
  }, [isSettingsOpen]);

  useEffect(() => {
    const handlePointerMove = (event: MouseEvent) => {
      if (!isResizingPanelRef.current) {
        return;
      }

      const nextWidth = clampRightPanelWidth(window.innerWidth - event.clientX);
      setRightPanelWidth(nextWidth);
    };

    const handlePointerUp = () => {
      isResizingPanelRef.current = false;
      document.body.classList.remove('is-panel-resizing');
    };

    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
    return () => {
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', handlePointerUp);
    };
  }, []);

  useEffect(() => {
    const handlePointerUp = () => {
      setIsCanvasPointerDown(false);
    };

    window.addEventListener('mouseup', handlePointerUp);
    return () => window.removeEventListener('mouseup', handlePointerUp);
  }, []);

  const flowEdges = useMemo(
    () => {
      const previewSourceNode = dragPreviewNodeId ? canvasNodes.find((node) => node.id === dragPreviewNodeId) ?? null : null;
      const previewTargetNode = dragDropTarget ? canvasNodes.find((node) => node.id === dragDropTarget.nodeId) ?? null : null;
      const dragPreviewEdge =
        previewSourceNode && previewTargetNode
          ? {
              source: previewSourceNode.id,
              target: previewTargetNode.id,
              path: buildDragPreviewPath(previewSourceNode, previewTargetNode),
            }
          : null;

      return buildFlowEdges(scopeEdges, selectedEdgeId, insertionEdgeId, dragPreviewEdge);
    },
    [scopeEdges, selectedEdgeId, insertionEdgeId, dragDropTarget, dragPreviewNodeId, canvasNodes],
  );

  const selectedNode = snapshot.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedCanvasNode = canvasNodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedCanvasNodes = useMemo(() => canvasNodes.filter((node) => node.selected), [canvasNodes]);
  const multiSelectedCanvasNodes = useMemo(() => selectedCanvasNodes.filter((node) => scopeNodes.some((scopeNode) => scopeNode.id === node.id)), [selectedCanvasNodes, scopeNodes]);
  const multiSelectedNodeIds = useMemo(() => multiSelectedCanvasNodes.map((node) => node.id), [multiSelectedCanvasNodes]);
  const multiSelectionBounds = useMemo(() => {
    if (multiSelectedCanvasNodes.length < 2) {
      return null;
    }

    const left = Math.min(...multiSelectedCanvasNodes.map((node) => node.position.x));
    const top = Math.min(...multiSelectedCanvasNodes.map((node) => node.position.y));
    const right = Math.max(
      ...multiSelectedCanvasNodes.map((node) => node.position.x + getFlowNodeDimensions(node).width),
    );
    const bottom = Math.max(
      ...multiSelectedCanvasNodes.map((node) => node.position.y + getFlowNodeDimensions(node).height),
    );

    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  }, [multiSelectedCanvasNodes]);
  const multiSelectionButtonStyle = useMemo<CSSProperties | null>(() => {
    if (!multiSelectionBounds) {
      return null;
    }

    return {
      left: flowViewport.x + (multiSelectionBounds.left + multiSelectionBounds.width / 2) * flowViewport.zoom,
      top: flowViewport.y + multiSelectionBounds.top * flowViewport.zoom,
      transform: 'translate(-50%, calc(-100% - 0.75rem))',
    };
  }, [multiSelectionBounds, flowViewport]);
  const activeScopeNode = activeScopeId ? snapshot.nodes.find((node) => node.id === activeScopeId) ?? null : null;
  const panelItem = selectedNode ?? activeScopeNode ?? null;
  const panelMode: 'selected' | 'scope-group' | 'root' =
    selectedNode ? 'selected' : activeScopeNode ? 'scope-group' : 'root';

  useEffect(() => {
    if (!shouldFocusSelectedTitle || panelMode !== 'selected' || !selectedNode || isLeftPanelCollapsed) {
      return;
    }

    const input = titleInputRef.current;
    if (!input) {
      return;
    }

    input.focus();
    input.select();
    setShouldFocusSelectedTitle(false);
  }, [shouldFocusSelectedTitle, panelMode, selectedNode, isLeftPanelCollapsed]);

  useEffect(() => {
    if (!pendingCenteredNodeId) {
      return;
    }

    const canvasNode = canvasNodes.find((node) => node.id === pendingCenteredNodeId);
    if (!canvasNode) {
      return;
    }

    const width = Number(canvasNode.style?.width) || 0;
    const height = Number(canvasNode.style?.height) || 0;
    const centerX = canvasNode.position.x + width / 2;
    const centerY = canvasNode.position.y + height / 2;

    setCenter(centerX, centerY, { duration: 260, zoom: getZoom() });
    setPendingCenteredNodeId(null);
  }, [pendingCenteredNodeId, canvasNodes, setCenter, getZoom]);

  useEffect(() => {
    setFlowViewport(getViewport());
  }, [getViewport, canvasNodes.length, activeTabId]);

  const availableTasks = useMemo(
    () => snapshot.nodes.filter((node) => isTaskAvailable(snapshot.nodes, snapshot.edges, node)),
    [snapshot.nodes, snapshot.edges],
  );

  const groupSelectedItems = useCallback(
    (nodeIds: string[]) => {
      if (nodeIds.length < 2) {
        return;
      }

      const selectedNodes = snapshot.nodes.filter((node) => nodeIds.includes(node.id));
      if (selectedNodes.length < 2) {
        return;
      }

      const commonParentId = selectedNodes[0]?.parentId;
      if (!selectedNodes.every((node) => node.parentId === commonParentId)) {
        return;
      }

      const selectedSet = new Set(nodeIds);
      const newGroupId = ensureUniqueNodeId(snapshot.nodes, slugify(selectedNodes[0]?.title || 'group'), 'group');
      const groupPosition = {
        x: Math.min(...selectedNodes.map((node) => node.position.x)),
        y: Math.min(...selectedNodes.map((node) => node.position.y)) - 16,
      };

      setSnapshot((current) => {
        const unaffectedEdges = current.edges.filter((edge) => !selectedSet.has(edge.source) && !selectedSet.has(edge.target));
        const internalEdges = current.edges.filter((edge) => selectedSet.has(edge.source) && selectedSet.has(edge.target));
        const incomingSources = [...new Set(current.edges.filter((edge) => !selectedSet.has(edge.source) && selectedSet.has(edge.target)).map((edge) => edge.source))];
        const outgoingTargets = [...new Set(current.edges.filter((edge) => selectedSet.has(edge.source) && !selectedSet.has(edge.target)).map((edge) => edge.target))];

        const remappedEdges = [...unaffectedEdges, ...internalEdges];

        for (const source of incomingSources) {
          if (!remappedEdges.some((edge) => edge.source === source && edge.target === newGroupId) && !wouldCreateCycle(remappedEdges, source, newGroupId)) {
            remappedEdges.push({ id: uid('edge'), source, target: newGroupId });
          }
        }

        for (const target of outgoingTargets) {
          if (!remappedEdges.some((edge) => edge.source === newGroupId && edge.target === target) && !wouldCreateCycle(remappedEdges, newGroupId, target)) {
            remappedEdges.push({ id: uid('edge'), source: newGroupId, target });
          }
        }

        return {
          ...current,
          nodes: [
            ...current.nodes.map((node) =>
              selectedSet.has(node.id)
                ? {
                    ...node,
                    parentId: newGroupId,
                    position: getRelativeChildPosition(node.position, groupPosition),
                  }
                : node,
            ),
            {
              id: newGroupId,
              kind: 'group',
              title: 'New group',
              status: 'todo',
              position: groupPosition,
              description: '',
              completionCriteria: '',
              tags: [],
              parentId: commonParentId,
              size: { ...groupSize },
            },
          ],
          edges: remappedEdges,
        };
      });

      appendSessionJournal({
        type: 'create_node',
        title: `Grouped ${selectedNodes.length} selected items`,
        detail: `Created a new node group from ${selectedNodes.map((node) => node.title).join(', ')}.`,
        scopeTitle: formatScopeTitle(snapshot, commonParentId),
      });

      setSelectedNodeId(newGroupId);
      setSelectedNodeIds([newGroupId]);
      setToolbarNodeId(null);
      setSelectedEdgeId(null);
    },
    [appendSessionJournal, snapshot],
  );

  const normalizedSearchQuery = searchQuery.trim();
  const isTagSearch = normalizedSearchQuery.startsWith('#');
  const normalizedTagSearch = normalizeTag(normalizedSearchQuery.slice(1));
  const normalizedTextSearch = normalizedSearchQuery.toLowerCase();

  const searchResults = useMemo(() => {
    if (!normalizedSearchQuery) {
      return [];
    }

    return snapshot.nodes.filter((node) => {
      if (isTagSearch) {
        if (!normalizedTagSearch) {
          return false;
        }
        return node.tags.some((tag) => matchesTagQuery(tag, normalizedTagSearch));
      }

      return [node.title, node.description, node.completionCriteria].some((value) =>
        value.toLowerCase().includes(normalizedTextSearch),
      );
    });
  }, [snapshot.nodes, normalizedSearchQuery, isTagSearch, normalizedTagSearch, normalizedTextSearch]);

  const openGroupTab = useCallback((groupId: string) => {
    setOpenTabs((current) => {
      if (current.some((tab) => tab.id === groupId)) {
        return current;
      }
      return [...current, { id: groupId, kind: 'group' }];
    });
    setActiveTabId(groupId);
  }, []);

  const focusNodeInWorkspace = useCallback(
    (node: PlannerNodeRecord) => {
      const scopeId = getNodeScope(node);
      if (scopeId) {
        openGroupTab(scopeId);
      } else {
        setActiveTabId('main');
      }
      setSelectedNodeId(node.id);
      setSelectedNodeIds([node.id]);
      setToolbarNodeId(null);
      setPendingCenteredNodeId(node.id);
    },
    [openGroupTab],
  );

  const openNodeGroup = useCallback(
    (nodeId: string) => {
      const node = snapshot.nodes.find((entry) => entry.id === nodeId);
      if (!node || node.kind !== 'group') {
        return;
      }
      openGroupTab(nodeId);
      setSelectedNodeId(nodeId);
      setSelectedNodeIds([nodeId]);
      setToolbarNodeId(null);
    },
    [snapshot.nodes, openGroupTab],
  );

  const closeGroupTab = useCallback((groupId: string) => {
    setOpenTabs((current) => current.filter((tab) => tab.id !== groupId));
    setActiveTabId((current) => (current === groupId ? 'main' : current));
    setSelectedNodeId((current) => (current === groupId ? null : current));
    setSelectedNodeIds((current) => current.filter((nodeId) => nodeId !== groupId));
    setToolbarNodeId((current) => (current === groupId ? null : current));
  }, []);

  const findEdgeIdAtPoint = useCallback((clientX: number, clientY: number) => {
    const elements = document.elementsFromPoint(clientX, clientY);
    for (const element of elements) {
      if (element.closest('.react-flow__node')) {
        continue;
      }

      const edgeId = getEdgeIdFromDomElement(element);
      if (edgeId) {
        return edgeId;
      }
    }

    return null;
  }, []);

  const resolveNodeDropTarget = useCallback(
    (draggedNodeId: string, draggedPosition: { x: number; y: number }): NodeDropTarget => {
      const draggedCanvasNode = canvasNodesRef.current.find((node) => node.id === draggedNodeId);
      if (!draggedCanvasNode) {
        return null;
      }

      const draggedRecord = snapshot.nodes.find((node) => node.id === draggedNodeId);
      if (!draggedRecord) {
        return null;
      }

      const draggedDimensions = getFlowNodeDimensions(draggedCanvasNode);
      const draggedCenterX = draggedPosition.x + draggedDimensions.width / 2;
      const draggedCenterY = draggedPosition.y + draggedDimensions.height / 2;
      const draggedDescendants = draggedRecord.kind === 'group' ? new Set(getDescendantNodeIds(snapshot.nodes, draggedNodeId)) : null;

      for (const candidate of canvasNodesRef.current) {
        if (candidate.id === draggedNodeId) {
          continue;
        }

        const candidateRecord = snapshot.nodes.find((node) => node.id === candidate.id);
        if (!candidateRecord) {
          continue;
        }

        if (candidateRecord.kind === 'group' && draggedDescendants?.has(candidate.id)) {
          continue;
        }

        const candidateDimensions = getFlowNodeDimensions(candidate);
        const withinBounds =
          draggedCenterX >= candidate.position.x &&
          draggedCenterX <= candidate.position.x + candidateDimensions.width &&
          draggedCenterY >= candidate.position.y &&
          draggedCenterY <= candidate.position.y + candidateDimensions.height;

        if (!withinBounds) {
          continue;
        }

        if (candidateRecord.kind === 'group') {
          return { mode: 'group', nodeId: candidate.id };
        }

        return { mode: 'combine', nodeId: candidate.id };
      }

      return null;
    },
    [snapshot.nodes],
  );

  const deleteSelectedEdge = useCallback((edgeId: string) => {
    const edge = snapshot.edges.find((entry) => entry.id === edgeId);
    setSnapshot((current) => ({
      ...current,
      edges: current.edges.filter((edge) => edge.id !== edgeId),
    }));
    if (edge) {
      const sourceTitle = snapshot.nodes.find((node) => node.id === edge.source)?.title ?? edge.source;
      const targetTitle = snapshot.nodes.find((node) => node.id === edge.target)?.title ?? edge.target;
      appendSessionJournal({
        type: 'delete_edge',
        title: `Removed dependency from ${sourceTitle} to ${targetTitle}`,
        detail: `${targetTitle} no longer depends on ${sourceTitle}.`,
        scopeTitle: formatScopeTitle(snapshot, activeScopeId),
      });
    }
    setSelectedEdgeId((current) => (current === edgeId ? null : current));
    setInsertionEdgeId((current) => (current === edgeId ? null : current));
  }, [activeScopeId, appendSessionJournal, snapshot.edges, snapshot.nodes, snapshot]);

  const deleteItems = useCallback(
    (nodeIds: string[]) => {
      const deleteSet = new Set<string>();
      for (const nodeId of nodeIds) {
        deleteSet.add(nodeId);
        for (const descendantId of getDescendantNodeIds(snapshot.nodes, nodeId)) {
          deleteSet.add(descendantId);
        }
      }

      const removedNodes = snapshot.nodes.filter((node) => deleteSet.has(node.id));

      setSnapshot((current) => ({
        root: current.root,
        nodes: current.nodes.filter((node) => !deleteSet.has(node.id)),
        edges: current.edges.filter((edge) => !deleteSet.has(edge.source) && !deleteSet.has(edge.target)),
      }));
      appendSessionJournal(
        removedNodes.map((node) => ({
          type: 'delete_node' as const,
          entityKey: `node:${node.id}`,
          initialNodeState: nodeJournalStateFromNode(node, formatScopeTitle(snapshot, node.parentId)),
          finalNodeState: nodeJournalStateFromNode(node, formatScopeTitle(snapshot, node.parentId)),
          nodeAction: 'deleted' as const,
          title: `Deleted ${node.kind} ${node.title}`,
          detail: `Removed ${node.kind} from ${formatScopeTitle(snapshot, node.parentId)}.`,
          scopeTitle: formatScopeTitle(snapshot, node.parentId),
        })),
      );
      setOpenTabs((current) => current.filter((tab) => tab.kind === 'main' || !deleteSet.has(tab.id)));
      setActiveTabId((current) => (deleteSet.has(current) ? 'main' : current));
      setSelectedNodeId((current) => (current && deleteSet.has(current) ? null : current));
      setSelectedNodeIds((current) => current.filter((nodeId) => !deleteSet.has(nodeId)));
      setToolbarNodeId((current) => (current && deleteSet.has(current) ? null : current));
    },
    [appendSessionJournal, snapshot],
  );

  const setNodeTitle = useCallback((nodeId: string, title: string) => {
    const node = snapshot.nodes.find((entry) => entry.id === nodeId);
    setSnapshot((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === nodeId ? { ...node, title } : node)),
    }));
    if (node && node.title !== title) {
      const finalNode = { ...node, title };
      appendSessionJournal({
        type: 'update_node',
        entityKey: `node:${node.id}`,
        initialNodeState: nodeJournalStateFromNode(node, formatScopeTitle(snapshot, node.parentId)),
        finalNodeState: nodeJournalStateFromNode(finalNode, formatScopeTitle(snapshot, node.parentId)),
        nodeAction: 'updated',
        title: `Renamed ${node.kind} to ${title || 'Untitled'}`,
        detail: `Previous title: ${node.title}`,
        scopeTitle: formatScopeTitle(snapshot, node.parentId),
      });
    }
  }, [appendSessionJournal, snapshot]);

  const setNodeField = useCallback(
    (nodeId: string, field: EditableNodeField, value: string) => {
      const node = snapshot.nodes.find((entry) => entry.id === nodeId);
      setSnapshot((current) => ({
        ...current,
        nodes: current.nodes.map((node) => (node.id === nodeId ? { ...node, [field]: value } : node)),
      }));
      if (node && node[field] !== value) {
        const finalNode = { ...node, [field]: value };
        appendSessionJournal({
          type: 'update_node',
          entityKey: `node:${node.id}`,
          initialNodeState: nodeJournalStateFromNode(node, formatScopeTitle(snapshot, node.parentId)),
          finalNodeState: nodeJournalStateFromNode(finalNode, formatScopeTitle(snapshot, node.parentId)),
          nodeAction: 'updated',
          title: `Updated ${field === 'description' ? 'description' : 'completion criteria'} for ${node.title}`,
          detail: value.trim() ? value.trim().slice(0, 180) : 'Cleared field.',
          scopeTitle: formatScopeTitle(snapshot, node.parentId),
        });
      }
    },
    [appendSessionJournal, snapshot],
  );

  const setRootField = useCallback(
    (field: EditableRootField, value: string) => {
      const previous = snapshot.root[field];
      setSnapshot((current) => ({
        ...current,
        root: {
          ...current.root,
          [field]: value,
        },
      }));
      if (previous !== value) {
        appendSessionJournal({
          type: 'update_root',
          title: `Updated project ${field === 'completionCriteria' ? 'completion criteria' : field}`,
          detail: value.trim() ? value.trim().slice(0, 180) : 'Cleared field.',
          scopeTitle: snapshot.root.title,
        });
      }
    },
    [appendSessionJournal, snapshot.root],
  );

  const setRootTags = useCallback((updater: (currentTags: string[]) => string[]) => {
    setSnapshot((current) => ({
      ...current,
      root: {
        ...current.root,
        tags: updater(current.root.tags).map(normalizeTag).filter(Boolean),
      },
    }));
  }, []);

  const setNodeTags = useCallback((nodeId: string, updater: (currentTags: string[]) => string[]) => {
    setSnapshot((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId ? { ...node, tags: updater(node.tags).map(normalizeTag).filter(Boolean) } : node,
      ),
    }));
  }, []);

  const setTaskStatus = useCallback((nodeId: string, status: TaskStatus) => {
    const node = snapshot.nodes.find((entry) => entry.id === nodeId);
    setSnapshot((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === nodeId && node.kind === 'task' ? { ...node, status } : node)),
    }));
    if (node && node.status !== status) {
      const finalNode = { ...node, status };
      appendSessionJournal({
        type: 'status_change',
        entityKey: `node:${node.id}`,
        initialNodeState: nodeJournalStateFromNode(node, formatScopeTitle(snapshot, node.parentId)),
        finalNodeState: nodeJournalStateFromNode(finalNode, formatScopeTitle(snapshot, node.parentId)),
        nodeAction: 'updated',
        title: `${status === 'done' ? 'Completed' : 'Reopened'} ${node.title}`,
        detail: `Task is now marked ${status}.`,
        scopeTitle: formatScopeTitle(snapshot, node.parentId),
        completed: status === 'done',
      });
    }
  }, [appendSessionJournal, snapshot]);

  const toggleTaskStatus = useCallback(
    (nodeId: string) => {
      const node = snapshot.nodes.find((entry) => entry.id === nodeId);
      if (!node || node.kind !== 'task') {
        return;
      }
      setTaskStatus(nodeId, node.status === 'done' ? 'todo' : 'done');
    },
    [snapshot.nodes, setTaskStatus],
  );

  const addTask = useCallback(
    (position?: { x: number; y: number }) => {
      const newNodeId = uid('task');
      let newNodeTitle = '';
      setSnapshot((current) => {
        const scopedNodes = getScopeNodes(current.nodes, activeScopeId);
        const nextIndex = scopedNodes.length;
        const newNode: PlannerNodeRecord = {
          id: newNodeId,
          kind: 'task',
          title: `New task ${nextIndex + 1}`,
          status: 'todo',
          position: position ?? { x: 80 + (nextIndex % 4) * 80, y: 120 + Math.floor(nextIndex / 4) * 110 },
          description: '',
          completionCriteria: '',
          tags: [],
          parentId: activeScopeId ?? undefined,
        };
        newNodeTitle = newNode.title;
        return { ...current, nodes: [...current.nodes, newNode] };
      });
      appendSessionJournal({
        type: 'create_node',
        entityKey: `node:${newNodeId}`,
        initialNodeState: {
          id: newNodeId,
          kind: 'task',
          title: newNodeTitle,
          description: '',
          completionCriteria: '',
          status: 'todo',
          scopeTitle: formatScopeTitle(snapshot, activeScopeId),
        },
        finalNodeState: {
          id: newNodeId,
          kind: 'task',
          title: newNodeTitle,
          description: '',
          completionCriteria: '',
          status: 'todo',
          scopeTitle: formatScopeTitle(snapshot, activeScopeId),
        },
        nodeAction: 'created',
        title: `Created task ${newNodeTitle}`,
        detail: `Added to ${formatScopeTitle(snapshot, activeScopeId)}.`,
        scopeTitle: formatScopeTitle(snapshot, activeScopeId),
      });
      setSelectedNodeId(newNodeId);
      setToolbarNodeId(null);
      setShouldFocusSelectedTitle(true);
    },
    [activeScopeId, appendSessionJournal, snapshot],
  );

  const addDependency = useCallback(
    (source: string, target: string) => {
      if (!source || !target) {
        return;
      }
      const sourceNode = snapshot.nodes.find((node) => node.id === source);
      if (!sourceNode) {
        return;
      }
      if (!isSameScope(snapshot.nodes, source, target) || getNodeScope(sourceNode) !== activeScopeId) {
        return;
      }
      if (wouldCreateCycle(snapshot.edges, source, target)) {
        return;
      }
      if (snapshot.edges.some((edge) => edge.source === source && edge.target === target)) {
        return;
      }
      setSnapshot((current) => ({
        ...current,
        edges: [...current.edges, { id: uid('edge'), source, target }],
      }));
      const targetTitle = snapshot.nodes.find((node) => node.id === target)?.title ?? target;
      appendSessionJournal({
        type: 'create_edge',
        title: `Added dependency to ${targetTitle}`,
        detail: `${targetTitle} now depends on ${sourceNode.title}.`,
        scopeTitle: formatScopeTitle(snapshot, activeScopeId),
      });
    },
    [activeScopeId, appendSessionJournal, snapshot],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) {
        return;
      }
      addDependency(connection.source, connection.target);
    },
    [addDependency],
  );

  const splitTask = useCallback((nodeId: string) => {
    const node = snapshot.nodes.find((entry) => entry.id === nodeId);
    setSnapshot((current) => {
      const node = current.nodes.find((entry) => entry.id === nodeId);
      if (!node || node.kind !== 'task') {
        return current;
      }

      const childTitles = ['Plan subtask', 'Build subtask', 'Review subtask'];
      const childNodes: PlannerNodeRecord[] = childTitles.map((title, index) => ({
        id: uid('task'),
        kind: 'task',
        title,
        status: 'todo',
        position: { x: 80 + index * 110, y: 120 },
        description: '',
        completionCriteria: '',
        tags: [],
        parentId: node.id,
      }));

      return {
        ...current,
        nodes: current.nodes.flatMap((entry) =>
          entry.id !== nodeId
            ? [entry]
            : [
                {
                  ...entry,
                  kind: 'group',
                  size: { ...groupSize },
                  tags: entry.tags ?? [],
                },
                ...childNodes,
              ],
        ),
      };
    });
    if (node) {
      appendSessionJournal({
        type: 'create_node',
        title: `Split ${node.title} into a group`,
        detail: 'Created a breakdown group with three starter subtasks.',
        scopeTitle: formatScopeTitle(snapshot, node.parentId),
      });
    }
    setSelectedNodeId(nodeId);
  }, [appendSessionJournal, snapshot]);

  const moveNodeIntoGroup = useCallback(
    (draggedNodeId: string, targetGroupId: string, draggedPosition: { x: number; y: number }) => {
      const draggedNode = snapshot.nodes.find((node) => node.id === draggedNodeId);
      const targetGroup = snapshot.nodes.find((node) => node.id === targetGroupId);
      if (!draggedNode || !targetGroup || targetGroup.kind !== 'group' || draggedNode.id === targetGroup.id) {
        return;
      }

      const descendantIds = draggedNode.kind === 'group' ? new Set(getDescendantNodeIds(snapshot.nodes, draggedNodeId)) : new Set<string>();
      if (descendantIds.has(targetGroupId)) {
        return;
      }

      setSnapshot((current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === draggedNodeId
            ? {
                ...node,
                parentId: targetGroupId,
                position: getRelativeChildPosition(draggedPosition, targetGroup.position),
              }
            : node,
        ),
        edges: current.edges.filter((edge) => edge.source !== draggedNodeId && edge.target !== draggedNodeId),
      }));

      appendSessionJournal({
        type: 'update_node',
        entityKey: `node:${draggedNode.id}`,
        initialNodeState: nodeJournalStateFromNode(draggedNode, formatScopeTitle(snapshot, draggedNode.parentId)),
        finalNodeState: nodeJournalStateFromNode(
          {
            ...draggedNode,
            parentId: targetGroupId,
            position: getRelativeChildPosition(draggedPosition, targetGroup.position),
          },
          formatScopeTitle(snapshot, targetGroupId),
        ),
        nodeAction: 'updated',
        title: `Moved ${draggedNode.title} into ${targetGroup.title}`,
        detail: `Moved ${draggedNode.kind} into node group ${targetGroup.title}.`,
        scopeTitle: formatScopeTitle(snapshot, targetGroupId),
      });

      setSelectedNodeId(null);
      setToolbarNodeId(null);
      setSelectedEdgeId(null);
    },
    [appendSessionJournal, snapshot],
  );

  const combineNodesIntoGroup = useCallback(
    (draggedNodeId: string, targetNodeId: string, draggedPosition: { x: number; y: number }) => {
      const draggedNode = snapshot.nodes.find((node) => node.id === draggedNodeId);
      const targetNode = snapshot.nodes.find((node) => node.id === targetNodeId);
      if (!draggedNode || !targetNode || draggedNode.id === targetNode.id) {
        return;
      }

      const sharedParentId = targetNode.parentId;
      if (draggedNode.parentId !== sharedParentId) {
        return;
      }

      const newGroupId = ensureUniqueNodeId(snapshot.nodes, slugify(targetNode.title || 'group'), 'group');
      const groupPosition = {
        x: Math.min(draggedPosition.x, targetNode.position.x),
        y: Math.min(draggedPosition.y, targetNode.position.y) - 16,
      };
      const movedNodeIds = new Set([draggedNodeId, targetNodeId]);
      const newGroup: PlannerNodeRecord = {
        id: newGroupId,
        kind: 'group',
        title: targetNode.title || 'New group',
        status: 'todo',
        position: groupPosition,
        description: '',
        completionCriteria: '',
        tags: [],
        parentId: sharedParentId,
        size: { ...groupSize },
      };

      setSnapshot((current) => ({
        ...current,
        nodes: [
          ...current.nodes.map((node) => {
            if (!movedNodeIds.has(node.id)) {
              return node;
            }

            const nextPosition = node.id === draggedNodeId ? draggedPosition : targetNode.position;
            return {
              ...node,
              parentId: newGroupId,
              position: getRelativeChildPosition(nextPosition, groupPosition),
            };
          }),
          newGroup,
        ],
        edges: current.edges.filter(
          (edge) =>
            (!movedNodeIds.has(edge.source) && !movedNodeIds.has(edge.target)) ||
            (movedNodeIds.has(edge.source) && movedNodeIds.has(edge.target)),
        ),
      }));

      appendSessionJournal({
        type: 'create_node',
        title: `Grouped ${targetNode.title} with ${draggedNode.title}`,
        detail: `Created node group ${newGroup.title} from two nodes.`,
        scopeTitle: formatScopeTitle(snapshot, sharedParentId),
      });

      setSelectedNodeId(newGroupId);
      setSelectedNodeIds([newGroupId]);
      setToolbarNodeId(null);
      setSelectedEdgeId(null);
    },
    [appendSessionJournal, snapshot],
  );

  const resetDemo = useCallback(() => {
    setSnapshot(seedSnapshot());
    setProjectId(createProjectId());
    setSessionJournal([]);
    setOpenTabs([mainTab, aiGraphTab]);
    setActiveTabId('main');
    setSelectedNodeId(null);
    setSelectedNodeIds([]);
    setToolbarNodeId(null);
    setPendingProposal(null);
    setPendingMemoryResult(null);
    setAiMessages((current) => current.slice(0, 1));
    setFileFeedback('Demo project restored.');
  }, []);

  const createNewProject = useCallback(() => {
    const shouldReplace = window.confirm('Create a new blank project and replace the current project?');
    if (!shouldReplace) {
      return;
    }

    setSnapshot(blankSnapshot());
    setProjectId(createProjectId());
    setSessionJournal([]);
    setOpenTabs([mainTab, aiGraphTab]);
    setActiveTabId('main');
    setSelectedNodeId(null);
    setSelectedNodeIds([]);
    setToolbarNodeId(null);
    setPendingProposal(null);
    setPendingMemoryResult(null);
    setFileFeedback('Started a new blank project.');
  }, []);

  const handleNodesChange = useCallback((changes: NodeChange<PlannerFlowNode>[]) => {
    setCanvasNodes((current) => {
      const next = applyNodeChanges(changes, current) as PlannerFlowNode[];
      const selectionChanges = changes.filter((change): change is NodeChange<PlannerFlowNode> & { type: 'select'; selected: boolean } => change.type === 'select');
      if (selectionChanges.length > 0) {
        const nextSelectedNodeIds = next.filter((node) => node.selected).map((node) => node.id);
        setSelectedNodeIds(nextSelectedNodeIds);
        setSelectedNodeId(nextSelectedNodeIds.length === 1 ? nextSelectedNodeIds[0] : null);
      }
      canvasNodesRef.current = next;
      return next;
    });
  }, []);

  const deleteItem = useCallback(
    (nodeId: string) => {
      deleteItems([nodeId]);
    },
    [deleteItems],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isAIGraphTabActive || !selectedEdgeId || (event.key !== 'Backspace' && event.key !== 'Delete')) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) {
        return;
      }

      event.preventDefault();
      deleteSelectedEdge(selectedEdgeId);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isAIGraphTabActive, selectedEdgeId, deleteSelectedEdge]);

  useEffect(() => {
    const nextCanvasNodes = buildFlowNodes(
      snapshot.nodes,
      scopeNodes,
      snapshot.edges,
      selectedNodeId,
      selectedNodeIds,
      toolbarNodeId,
      dragDropTarget?.nodeId ?? null,
      toggleTaskStatus,
      splitTask,
      openNodeGroup,
      deleteItem,
    );
    canvasNodesRef.current = nextCanvasNodes;
    setCanvasNodes(nextCanvasNodes);
  }, [snapshot.nodes, scopeNodes, snapshot.edges, selectedNodeId, selectedNodeIds, toolbarNodeId, dragDropTarget, toggleTaskStatus, splitTask, openNodeGroup, deleteItem]);

  const insertNodeIntoEdge = useCallback((edgeId: string, nodeId: string) => {
    const edge = snapshot.edges.find((entry) => entry.id === edgeId);
    const node = snapshot.nodes.find((entry) => entry.id === nodeId);
    setSnapshot((current) => {
      const edge = current.edges.find((entry) => entry.id === edgeId);
      const node = current.nodes.find((entry) => entry.id === nodeId);
      if (!edge || !node || edge.source === nodeId || edge.target === nodeId) {
        return current;
      }

      if (!isSameScope(current.nodes, edge.source, nodeId) || !isSameScope(current.nodes, nodeId, edge.target)) {
        return current;
      }

      const remainingEdges = current.edges.filter((entry) => entry.id !== edgeId);
      const hasSourceInsert = remainingEdges.some((entry) => entry.source === edge.source && entry.target === nodeId);
      const hasInsertTarget = remainingEdges.some((entry) => entry.source === nodeId && entry.target === edge.target);

      if (
        (!hasSourceInsert && wouldCreateCycle(remainingEdges, edge.source, nodeId)) ||
        (!hasInsertTarget && wouldCreateCycle(remainingEdges, nodeId, edge.target))
      ) {
        return current;
      }

      return {
        ...current,
        edges: [
          ...remainingEdges,
          ...(!hasSourceInsert ? [{ id: uid('edge'), source: edge.source, target: nodeId }] : []),
          ...(!hasInsertTarget ? [{ id: uid('edge'), source: nodeId, target: edge.target }] : []),
        ],
      };
    });

    if (edge && node) {
      const sourceTitle = snapshot.nodes.find((entry) => entry.id === edge.source)?.title ?? edge.source;
      const targetTitle = snapshot.nodes.find((entry) => entry.id === edge.target)?.title ?? edge.target;
      appendSessionJournal({
        type: 'create_edge',
        title: `Inserted ${node.title} into dependency flow`,
        detail: `${sourceTitle} now leads into ${node.title}, then ${targetTitle}.`,
        scopeTitle: formatScopeTitle(snapshot, node.parentId),
      });
    }

    setSelectedEdgeId(null);
    setInsertionEdgeId(null);
  }, [appendSessionJournal, snapshot]);

  const tabTitle = useCallback(
    (tab: TabDescriptor) => {
      if (tab.kind === 'main') {
        return snapshot.root.title;
      }
      if (tab.kind === 'system') {
        return 'AI Graph';
      }
      return snapshot.nodes.find((node) => node.id === tab.id)?.title ?? 'Group';
    },
    [snapshot.nodes, snapshot.root.title],
  );

  const selectedAIGraphNode = useMemo(
    () => aiGraph?.nodes.find((node) => node.id === selectedAIGraphNodeId) ?? null,
    [aiGraph, selectedAIGraphNodeId],
  );
  const aiGraphNodeLabels = useMemo(
    () => new Map((aiGraph?.nodes ?? []).map((node) => [node.id, node.label])),
    [aiGraph],
  );

  const panelGroupProgress = panelItem?.kind === 'group' ? countGroupProgress(snapshot.nodes, panelItem.id) : null;
  const panelTags = panelMode === 'root' ? snapshot.root.tags : panelItem?.tags ?? [];
  const normalizedTagQuery = normalizeTag(tagQuery);
  const knownTags = useMemo(() => getAllKnownTags(snapshot), [snapshot]);
  const visibleTags = useMemo(
    () => knownTags.filter((tag) => matchesTagQuery(tag, normalizedTagQuery)),
    [knownTags, normalizedTagQuery],
  );
  const visibleTagTree = useMemo(() => buildTagTree(visibleTags), [visibleTags]);
  const canCreateTag =
    Boolean(normalizedTagQuery) &&
    !knownTags.includes(normalizedTagQuery) &&
    !panelTags.includes(normalizedTagQuery);

  const togglePanelTag = useCallback(
    (tag: string) => {
      const normalizedTag = normalizeTag(tag);
      if (!normalizedTag) {
        return;
      }

      const toggle = (currentTags: string[]) =>
        currentTags.includes(normalizedTag)
          ? currentTags.filter((entry) => entry !== normalizedTag)
          : [...currentTags, normalizedTag].sort((left, right) => left.localeCompare(right));

      if (panelMode === 'root') {
        setRootTags(toggle);
        return;
      }

      if (panelItem) {
        setNodeTags(panelItem.id, toggle);
      }
    },
    [panelMode, panelItem, setNodeTags, setRootTags],
  );

  const createTagFromQuery = useCallback(() => {
    if (!normalizedTagQuery) {
      return;
    }
    togglePanelTag(normalizedTagQuery);
    setTagQuery('');
  }, [normalizedTagQuery, togglePanelTag]);

  const saveProject = useCallback(() => {
    const file = serializeProjectFile(projectId, snapshot, openTabs, activeTabId, selectedNodeId);
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileNameFromTitle(snapshot.root.title);
    anchor.click();
    URL.revokeObjectURL(url);
  }, [projectId, snapshot, openTabs, activeTabId, selectedNodeId]);

  const applyLoadedProject = useCallback((projectFile: ProjectFileV1) => {
    const normalized = sanitizeProjectFile(projectFile);
    setProjectId(normalized.projectId ?? createProjectId());
    setSnapshot(normalized.project);
    setSessionJournal([]);
    setOpenTabs(normalized.ui.openTabs);
    setActiveTabId(normalized.ui.activeTabId);
    setSelectedNodeId(normalized.ui.selectedNodeId);
    setSelectedNodeIds(normalized.ui.selectedNodeId ? [normalized.ui.selectedNodeId] : []);
    setToolbarNodeId(null);
    setPendingProposal(null);
    setPendingMemoryResult(null);
    setFileFeedback('Project loaded from file.');
  }, []);

  const handleLoadFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      try {
        const content = await file.text();
        const parsed = JSON.parse(content) as ProjectFileV1;
        if ((parsed.version !== 1 && parsed.version !== 2) || !parsed.project || !parsed.ui) {
          throw new Error('Invalid project file format.');
        }

        const shouldReplace = window.confirm('Load this project file and replace the current project?');
        if (!shouldReplace) {
          event.target.value = '';
          return;
        }

        applyLoadedProject(parsed);
      } catch {
        setFileFeedback('Could not load that file. Please choose a valid project JSON file.');
      } finally {
        event.target.value = '';
      }
    },
    [applyLoadedProject],
  );

  const saveSettings = useCallback(async () => {
    setSettingsError(null);
    setSettingsMessage(null);

    try {
      const settings = await saveOpenAISettings({
        apiKey: apiKeyDraft.trim() ? apiKeyDraft.trim() : undefined,
        selectedModel: selectedModelDraft || null,
      });
      setAppSettings(settings);
      setApiKeyDraft('');
      setSettingsMessage('OpenAI settings saved on the backend.');
      if (settings.openai.selectedModel) {
        setSelectedModelDraft(settings.openai.selectedModel);
      }
      await loadModels();
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : 'Could not save OpenAI settings.');
    }
  }, [apiKeyDraft, selectedModelDraft, loadModels]);

  const saveNotionConfiguration = useCallback(async () => {
    setNotionSettingsError(null);
    setNotionSettingsMessage(null);

    try {
      const settings = await saveNotionSettings({
        token: notionTokenDraft.trim() ? notionTokenDraft.trim() : undefined,
        notesDatabaseId: notionNotesDatabaseIdDraft.trim() || null,
        progressDatabaseId: notionProgressDatabaseIdDraft.trim() || null,
        useNotesForAiContext: useNotionNotesForAiContextDraft,
        enableProgressSync: enableNotionProgressSyncDraft,
        progressFieldMap: notionProgressFieldMapDraft,
        notesFieldMap: notionNotesFieldMapDraft,
      });
      setAppSettings(settings);
      setNotionTokenDraft('');
      setNotionNotesDatabaseIdDraft(settings.notion.notesDatabaseId ?? '');
      setNotionProgressDatabaseIdDraft(settings.notion.progressDatabaseId ?? '');
      setNotionProgressFieldMapDraft({
        titleField: settings.notion.progressFieldMap?.titleField ?? '',
        projectNameField: settings.notion.progressFieldMap?.projectNameField ?? '',
        syncedAtField: settings.notion.progressFieldMap?.syncedAtField ?? '',
        changedCountField: settings.notion.progressFieldMap?.changedCountField ?? '',
        completedCountField: settings.notion.progressFieldMap?.completedCountField ?? '',
        scopeField: settings.notion.progressFieldMap?.scopeField ?? '',
      });
      setNotionNotesFieldMapDraft({
        titleField: settings.notion.notesFieldMap?.titleField ?? '',
        summaryField: settings.notion.notesFieldMap?.summaryField ?? '',
        statusField: settings.notion.notesFieldMap?.statusField ?? '',
        tagsField: settings.notion.notesFieldMap?.tagsField ?? '',
        scopeField: settings.notion.notesFieldMap?.scopeField ?? '',
      });
      setUseNotionNotesForAiContextDraft(settings.notion.useNotesForAiContext);
      setEnableNotionProgressSyncDraft(settings.notion.enableProgressSync);
      setNotionSettingsMessage('Notion settings saved on the backend.');
    } catch (error) {
      setNotionSettingsError(error instanceof Error ? error.message : 'Could not save Notion settings.');
    }
  }, [
    notionTokenDraft,
    notionNotesDatabaseIdDraft,
    notionProgressDatabaseIdDraft,
    notionProgressFieldMapDraft,
    notionNotesFieldMapDraft,
    useNotionNotesForAiContextDraft,
    enableNotionProgressSyncDraft,
  ]);

  const loadNotionProgressSchema = useCallback(async () => {
    const databaseId = notionProgressDatabaseIdDraft.trim();
    if (!databaseId) {
      setNotionSettingsError('Enter a progress database ID before loading the schema.');
      return;
    }

    setIsNotionProgressSchemaLoading(true);
    setNotionSettingsError(null);
    setNotionSettingsMessage(null);

    try {
      const schema = await fetchNotionDatabaseSchema({
        databaseId,
        token: notionTokenDraft.trim() ? notionTokenDraft.trim() : undefined,
      });
      setNotionProgressSchema(schema);
      if (schema.properties.length === 0) {
        setNotionSettingsError('The selected progress database returned no mappable properties. Check the integration access and try again.');
      }
      setNotionSettingsMessage(`Loaded ${schema.properties.length} properties from ${schema.title || 'the selected database'}.`);
      setNotionProgressFieldMapDraft((current) => {
        const byType = (type: string) => schema.properties.filter((property) => property.type === type).map((property) => property.name);
        const maybeDefault = (currentValue: string, options: string[]) =>
          currentValue && options.includes(currentValue) ? currentValue : options.length === 1 ? options[0] : '';

        return {
          titleField: maybeDefault(current.titleField, byType('title')),
          projectNameField: maybeDefault(current.projectNameField, byType('rich_text')),
          syncedAtField: maybeDefault(current.syncedAtField, byType('date')),
          changedCountField: maybeDefault(current.changedCountField, byType('number')),
          completedCountField: maybeDefault(current.completedCountField, byType('number')),
          scopeField: maybeDefault(current.scopeField, byType('rich_text')),
        };
      });
    } catch (error) {
      setNotionSettingsError(error instanceof Error ? error.message : 'Could not load the Notion database schema.');
      setNotionProgressSchema(null);
    } finally {
      setIsNotionProgressSchemaLoading(false);
    }
  }, [notionProgressDatabaseIdDraft, notionTokenDraft]);

  const loadNotionNotesSchema = useCallback(async () => {
    const databaseId = notionNotesDatabaseIdDraft.trim();
    if (!databaseId) {
      setNotionSettingsError('Enter a notes database ID before loading the schema.');
      return;
    }

    setIsNotionNotesSchemaLoading(true);
    setNotionSettingsError(null);
    setNotionSettingsMessage(null);

    try {
      const schema = await fetchNotionDatabaseSchema({
        databaseId,
        token: notionTokenDraft.trim() ? notionTokenDraft.trim() : undefined,
      });
      setNotionNotesSchema(schema);
      if (schema.properties.length === 0) {
        setNotionSettingsError('The selected notes database returned no mappable properties. Check the integration access and try again.');
      }
      setNotionSettingsMessage(`Loaded ${schema.properties.length} properties from ${schema.title || 'the selected database'}.`);
      setNotionNotesFieldMapDraft((current) => {
        const byTypes = (types: string[]) =>
          schema.properties.filter((property) => types.includes(property.type)).map((property) => property.name);
        const maybeDefault = (currentValue: string, options: string[]) =>
          currentValue && options.includes(currentValue) ? currentValue : options.length === 1 ? options[0] : '';

        return {
          titleField: maybeDefault(current.titleField, byTypes(['title'])),
          summaryField: maybeDefault(current.summaryField, byTypes(['rich_text'])),
          statusField: maybeDefault(current.statusField, byTypes(['status', 'select'])),
          tagsField: maybeDefault(current.tagsField, byTypes(['multi_select'])),
          scopeField: maybeDefault(current.scopeField, byTypes(['rich_text', 'select', 'multi_select'])),
        };
      });
    } catch (error) {
      setNotionSettingsError(error instanceof Error ? error.message : 'Could not load the Notion notes schema.');
      setNotionNotesSchema(null);
    } finally {
      setIsNotionNotesSchemaLoading(false);
    }
  }, [notionNotesDatabaseIdDraft, notionTokenDraft]);

  const aiContext = useMemo(() => getAIContext(snapshot, selectedNodeId, activeScopeId), [snapshot, selectedNodeId, activeScopeId]);
  const aiScopeTitle = useMemo(() => {
    if (!aiContext.scopeId) {
      return snapshot.root.title;
    }
    return snapshot.nodes.find((node) => node.id === aiContext.scopeId)?.title ?? snapshot.root.title;
  }, [aiContext.scopeId, snapshot.nodes, snapshot.root.title]);
  const proposalDependencyLines = useMemo(
    () => (pendingProposal ? getProposalDependencyLines(pendingProposal) : []),
    [pendingProposal],
  );

  const syncCurrentSessionToNotion = useCallback(async () => {
    if (isNotionSyncing) {
      return;
    }

    setNotionSettingsError(null);
    setNotionSettingsMessage(null);
    setIsNotionSyncing(true);

    try {
      const result = await syncNotionProgress({
        project: snapshot,
        context: aiContext,
        entries: sessionJournal,
      });
      setSessionJournal([]);
      setNotionSettingsMessage(`Synced ${result.syncedEntries} session changes to Notion.`);
    } catch (error) {
      setNotionSettingsError(error instanceof Error ? error.message : 'Could not sync progress to Notion.');
    } finally {
      setIsNotionSyncing(false);
    }
  }, [aiContext, isNotionSyncing, sessionJournal, snapshot]);

  const sendAiPrompt = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || isAiBusy) {
        return;
      }

      const userMessage: AIConversationMessage = {
        id: uid('msg'),
        role: 'user',
        content: trimmed,
      };

      const nextConversation = [...aiMessages, userMessage];

      setRightPanelTab('ai');
      setAiMessages(nextConversation);
      setAiError(null);
      setIsAiBusy(true);

      try {
        const response = await sendAIChat({
          projectId,
          message: trimmed,
          context: aiContext,
          project: snapshot,
          conversation: nextConversation,
          documents: aiDocuments,
        });

        setAiMessages((current) => [
          ...current,
          {
            id: uid('msg'),
            role: 'assistant',
            content: response.message,
          },
        ]);

        setPendingProposal(response.proposal ?? null);
        setPendingMemoryResult(response.memoryResult ?? null);
      } catch (error) {
        setAiError(error instanceof Error ? error.message : 'The AI assistant could not process that request.');
      } finally {
        setIsAiBusy(false);
      }
    },
    [aiContext, aiDocuments, aiMessages, isAiBusy, projectId, snapshot],
  );

  const sendAiMessage = useCallback(async () => {
    const trimmed = aiInput.trim();
    if (!trimmed) {
      return;
    }

    setAiInput('');
    await sendAiPrompt(trimmed);
  }, [aiInput, sendAiPrompt]);

  const applyPendingProposal = useCallback(async () => {
    if (!pendingProposal || isApplyingProposal) {
      return;
    }

    setIsApplyingProposal(true);
    setAiError(null);

    try {
      setSnapshot((current) => applyAIProposalToSnapshot(current, pendingProposal));
      appendSessionJournal({
        type: 'apply_proposal',
        title: `Applied AI proposal for ${pendingProposal.context.targetTitle}`,
        detail: summarizeProposalOperations(pendingProposal),
        scopeTitle: pendingProposal.context.scopeId
          ? formatScopeTitle(snapshot, pendingProposal.context.scopeId)
          : pendingProposal.context.targetTitle,
      });
      setAiMessages((current) => [
        ...current,
        {
          id: uid('msg'),
          role: 'assistant',
          content: 'Proposal applied to the graph.',
        },
      ]);
      setPendingProposal(null);
      setPendingMemoryResult(null);
      setIsProposalRevisionOpen(false);
      setProposalRevisionDraft('');
    } catch (error) {
      setAiError(error instanceof Error ? error.message : 'Could not apply that proposal.');
    } finally {
      setIsApplyingProposal(false);
    }
  }, [appendSessionJournal, isApplyingProposal, pendingProposal, snapshot]);

  const rejectPendingProposal = useCallback(() => {
    setPendingProposal(null);
    setPendingMemoryResult(null);
    setIsProposalRevisionOpen(false);
    setProposalRevisionDraft('');
    setAiError(null);
  }, []);

  const revisePendingProposal = useCallback(async () => {
    const trimmed = proposalRevisionDraft.trim();
    if (!trimmed || isAiBusy) {
      return;
    }

    await sendAiPrompt(`Revise the current proposal with this adjustment: ${trimmed}`);
    setProposalRevisionDraft('');
    setIsProposalRevisionOpen(false);
  }, [proposalRevisionDraft, isAiBusy, sendAiPrompt]);

  const uploadAIDocumentFiles = useCallback(async (files: File[]) => {
    const pdfFiles = files.filter((file) => file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf');
    if (pdfFiles.length === 0) {
      setAiError('Only PDF files can be used as AI context.');
      return;
    }

    setAiError(null);
    setIsUploadingAiDocuments(true);

    try {
      const documents = await uploadAIDocuments(pdfFiles);
      setAiDocuments((current) => [...current, ...documents]);
    } catch (error) {
      setAiError(error instanceof Error ? error.message : 'Could not upload those PDF files.');
    } finally {
      setIsUploadingAiDocuments(false);
    }
  }, []);

  const handleAIDocumentUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      if (files.length === 0) {
        return;
      }

      await uploadAIDocumentFiles(files);
      event.target.value = '';
    },
    [uploadAIDocumentFiles],
  );

  const removeAIDocument = useCallback((documentId: string) => {
    setAiDocuments((current) => current.filter((document) => document.id !== documentId));
  }, []);

  const breadcrumbs =
    activeTabId === 'main'
      ? [{ id: 'main', label: snapshot.root.title }]
      : [
          { id: 'main', label: snapshot.root.title },
          ...getGroupPath(snapshot.nodes, activeTabId).map((node) => ({
            id: node.id,
            label: node.title,
          })),
        ];

  const activeTabDescriptor = openTabs.find((tab) => tab.id === activeTabId) ?? mainTab;
  const activeTabLabel = tabTitle(activeTabDescriptor);
  const canSyncSessionChanges = sessionJournal.length > 0 && isNotionProgressSyncAvailable && !isNotionSyncing;
  const syncButtonLabel = isNotionSyncing ? 'Syncing Changes...' : `Sync Changes • ${sessionJournal.length} pending`;

  return (
    <>
      <div className="app-frame" style={{ '--properties-width': `${rightPanelWidth}px` } as CSSProperties}>
        <header className="topbar">
          <div className="topbar__brand">
            <div className="topbar__brand-icon" aria-label="Project graph">
              <Graph3Icon />
            </div>
          </div>

          <div className="topbar__search-stack">
            <label className="topbar__search" aria-label="Search workspace">
              <span className="topbar__search-icon" aria-hidden="true">
                <ToolbarIcon path="M10.5 18a7.5 7.5 0 1 1 5.3-2.2L21 21" />
              </span>
              <input
                value={searchQuery}
                placeholder="Search workspace or use #Tag.Path"
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </label>

            {normalizedSearchQuery ? (
              <div className="search-overlay" role="listbox" aria-label="Search results">
                <div className="search-overlay__header">
                  <span>{isTagSearch ? 'Tag Search' : 'Workspace Search'}</span>
                  <strong>{searchResults.length} results</strong>
                </div>
                <div className="search-overlay__results">
                  {searchResults.length > 0 ? (
                    searchResults.map((node) => (
                      <button
                        key={node.id}
                        className="search-result-item"
                        onClick={() => {
                          focusNodeInWorkspace(node);
                          setSearchQuery('');
                        }}
                      >
                        <span className="search-result-item__title">{node.title}</span>
                        <span className="search-result-item__meta">
                          {node.kind === 'group' ? 'Group' : 'Node'}
                          {node.tags.length > 0 ? ` · ${node.tags[0]}` : ''}
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="muted search-overlay__empty">
                      {isTagSearch
                        ? 'No nodes matched that tag path.'
                        : 'No nodes matched title, description, or completion criteria.'}
                    </p>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <nav className="topbar__nav" aria-label="Workspace views">
            {[mainTab, aiGraphTab].map((tab) => (
              <div key={tab.id} className={['topbar__tab', activeTabId === tab.id ? 'is-active' : ''].join(' ')}>
                <button
                  type="button"
                  className="topbar__tab-button"
                  onClick={() => setActiveTabId(tab.id)}
                  aria-current={activeTabId === tab.id ? 'page' : undefined}
                >
                  {tab.id === 'main' ? 'Echo' : 'AI Graph'}
                </button>
              </div>
            ))}
          </nav>

          <div className="topbar__actions">
            {!isAIGraphTabActive ? (
              <button type="button" className="primary-action" onClick={() => addTask()}>
                New Node
              </button>
            ) : null}
            <button type="button" className="secondary" onClick={createNewProject}>
              New Project
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Load project"
              title="Load project"
            >
              Load
            </button>
            <button type="button" className="secondary" onClick={saveProject}>
              Save
            </button>
            <button
              type="button"
              className={['secondary', isSettingsOpen ? 'is-active' : ''].join(' ')}
              onClick={() => setIsSettingsOpen((current) => !current)}
              aria-label="Open settings"
              title="Settings"
            >
              Settings
            </button>
          </div>
        </header>

        <div className="app-shell app-shell--floating">
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="application/json,.json"
            onChange={handleLoadFile}
          />

          <section className="workspace workspace--floating">
            {fileFeedback ? <p className="feedback floating-feedback">{fileFeedback}</p> : null}

            {!isAIGraphTabActive ? (
              <aside className="floating-available-panel" aria-label="Available work">
                <div className="panel-header floating-panel-header">
                  <h2>Available Work</h2>
                  <span>{availableTasks.length}</span>
                </div>
                <div className="floating-task-list">
                  {availableTasks.length === 0 ? (
                    <p className="muted">No tasks are available yet. Complete a blocker to unlock the next path.</p>
                  ) : (
                    availableTasks.map((task) => (
                      <button key={task.id} className="floating-task-card" onClick={() => focusNodeInWorkspace(task)}>
                        <span>{task.title}</span>
                      </button>
                    ))
                  )}
                </div>
              </aside>
            ) : null}

            {!isAIGraphTabActive ? (
              <button
                type="button"
                className="canvas-glass-button floating-sync-button"
                onClick={() => void syncCurrentSessionToNotion()}
                disabled={!canSyncSessionChanges}
                title={syncButtonLabel}
              >
                <span className="floating-sync-button__label">{syncButtonLabel}</span>
              </button>
            ) : null}

            {!isAIGraphTabActive ? (
              <main
                className="canvas-shell"
                onMouseDownCapture={(event) => {
                  const target = event.target as HTMLElement;
                  if (
                    event.button !== 0 ||
                    target.closest('.multi-selection-actions, .node-actions, .canvas-glass-button, button, input, textarea')
                  ) {
                    return;
                  }
                  setIsCanvasPointerDown(true);
                }}
                onDoubleClick={(event: ReactMouseEvent<HTMLElement>) => {
                  const target = event.target as HTMLElement;
                  if (target.closest('.react-flow__node') || !target.closest('.react-flow__pane')) {
                    return;
                  }

                  const position = screenToFlowPosition({
                    x: event.clientX,
                    y: event.clientY,
                  });
                  addTask(position);
                }}
              >
                <ParticleGridBackground />
                <div className="canvas-shell__overlay">
                  {multiSelectionButtonStyle && !isCanvasPointerDown ? (
                    <div className="multi-selection-actions" style={multiSelectionButtonStyle}>
                      <button
                        type="button"
                        className="multi-selection-actions__button nodrag nopan"
                        onClick={() => groupSelectedItems(multiSelectedNodeIds)}
                        aria-label="Group selection"
                        title="Group selection"
                      >
                        <ToolbarIcon path="M6 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM12 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4M8 9h8M8.7 10.5l2.3 4M15.3 10.5 13 14.5" />
                      </button>
                      <button
                        type="button"
                        className="multi-selection-actions__button is-delete nodrag nopan"
                        onClick={() => deleteItems(multiSelectedNodeIds)}
                        aria-label="Delete selection"
                        title="Delete selection"
                      >
                        <ToolbarIcon path="M7 7 17 17M17 7 7 17" />
                      </button>
                    </div>
                  ) : null}
                  <div className="breadcrumbs canvas-shell__breadcrumbs" aria-label="Node group path">
                    {breadcrumbs.map((crumb, index) => (
                      <div key={crumb.id} className="breadcrumbs__item">
                        <button
                          className={['breadcrumbs__button', activeTabId === crumb.id ? 'is-active' : ''].join(' ')}
                          onClick={() => setActiveTabId(crumb.id)}
                        >
                          {crumb.label}
                        </button>
                        {index < breadcrumbs.length - 1 ? <span className="breadcrumbs__separator">/</span> : null}
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="canvas-glass-button"
                    onClick={() => void fitView({ duration: 350, padding: 0.18 })}
                  >
                    Fit View
                  </button>
                </div>
                <ReactFlow
                  nodes={canvasNodes}
                  edges={flowEdges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  fitView
                  snapToGrid
                  snapGrid={[18, 18]}
                  panOnScroll
                  panOnScrollMode={PanOnScrollMode.Free}
                  panOnDrag={[1, 2]}
                  selectionOnDrag
                  selectionMode={SelectionMode.Full}
                  zoomOnScroll={false}
                  zoomOnPinch
                  zoomOnDoubleClick={false}
                  deleteKeyCode={['Backspace', 'Delete']}
                  onConnect={handleConnect}
                  onNodeClick={(_, node) => {
                    setSelectedNodeId(node.id);
                    setSelectedNodeIds([node.id]);
                    setToolbarNodeId(node.id);
                    setSelectedEdgeId(null);
                  }}
                  onNodeDoubleClick={(_, node) => {
                    const plannerNode = snapshot.nodes.find((entry) => entry.id === node.id);
                    if (plannerNode?.kind === 'group') {
                      openGroupTab(plannerNode.id);
                      setSelectedNodeId(plannerNode.id);
                      setSelectedNodeIds([plannerNode.id]);
                      setToolbarNodeId(null);
                    }
                  }}
                  onEdgeClick={(_, edge) => {
                    setSelectedEdgeId(edge.id);
                    setSelectedNodeId(null);
                    setSelectedNodeIds([]);
                    setToolbarNodeId(null);
                  }}
                  onNodesChange={handleNodesChange}
                  onNodesDelete={(nodes) => deleteItems(nodes.map((node) => node.id))}
                  onNodeDrag={(event, node) => {
                    setToolbarNodeId(null);
                    const nextDropTarget = resolveNodeDropTarget(node.id, node.position);
                    setDragDropTarget(nextDropTarget);
                    setDragPreviewNodeId(node.id);
                    if (nextDropTarget) {
                      setInsertionEdgeId(null);
                    } else {
                      setInsertionEdgeId(findEdgeIdAtPoint(event.clientX, event.clientY));
                    }
                  }}
                  onNodeDragStop={(event, node) => {
                    const positionsById = new Map(
                      canvasNodesRef.current.map((canvasNode) => [canvasNode.id, canvasNode.position] as const),
                    );
                    const finalPosition = positionsById.get(node.id) ?? node.position;
                    const finalDropTarget = resolveNodeDropTarget(node.id, finalPosition);
                    setSnapshot((current) => ({
                      ...current,
                      nodes: current.nodes.map((entry) =>
                        positionsById.has(entry.id)
                          ? { ...entry, position: positionsById.get(entry.id) ?? entry.position }
                          : entry,
                      ),
                    }));
                    if (finalDropTarget?.mode === 'group') {
                      moveNodeIntoGroup(node.id, finalDropTarget.nodeId, finalPosition);
                    } else if (finalDropTarget?.mode === 'combine') {
                      combineNodesIntoGroup(node.id, finalDropTarget.nodeId, finalPosition);
                    } else {
                      const hoveredEdgeId = findEdgeIdAtPoint(event.clientX, event.clientY);
                      if (hoveredEdgeId) {
                        insertNodeIntoEdge(hoveredEdgeId, node.id);
                      } else {
                        setInsertionEdgeId(null);
                      }
                    }
                    setDragDropTarget(null);
                    setDragPreviewNodeId(null);
                  }}
                  onMove={(_, viewport) => setFlowViewport(viewport)}
                  onPaneClick={() => {
                    setSelectedNodeId(null);
                    setSelectedNodeIds([]);
                    setToolbarNodeId(null);
                    setSelectedEdgeId(null);
                    setDragDropTarget(null);
                    setDragPreviewNodeId(null);
                  }}
                  proOptions={{ hideAttribution: true }}
                >
                  <Controls />
                </ReactFlow>
              </main>
            ) : (
              <main className="canvas-shell canvas-shell--ai-graph">
                {aiGraphError ? <p className="feedback feedback--error">{aiGraphError}</p> : null}
                <div className="ai-graph-canvas">
                  <ParticleGridBackground />
                  <div className="ai-graph-canvas__toolbar">
                    <button type="button" className="secondary" onClick={() => void loadAIGraph()} disabled={isAIGraphLoading}>
                      {isAIGraphLoading ? 'Refreshing...' : 'Refresh graph'}
                    </button>
                  </div>
                  <ReactFlow
                    nodes={agentGraphFlowNodes}
                    edges={agentGraphFlowEdges}
                    nodeTypes={agentGraphNodeTypes}
                    fitView
                    minZoom={0.45}
                    maxZoom={1.6}
                    panOnScroll
                    panOnScrollMode={PanOnScrollMode.Free}
                    panOnDrag={[1, 2]}
                    selectionOnDrag
                    selectionMode={SelectionMode.Full}
                    zoomOnScroll={false}
                    zoomOnPinch
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable
                    zoomOnDoubleClick={false}
                    onNodeClick={(_, node) => setSelectedAIGraphNodeId(node.id)}
                    onPaneClick={() => setSelectedAIGraphNodeId(null)}
                    proOptions={{ hideAttribution: true }}
                  >
                    <Controls />
                  </ReactFlow>
                </div>
              </main>
            )}
            {isAIGraphTabActive ? (
              <aside className="floating-properties-panel floating-properties-panel--graph">
                <div className="glass-panel glass-panel--stack">
                  {selectedAIGraphNode ? (
                    <>
                      <div className="glass-card">
                        <div className="ai-graph-details-card__eyebrow">{selectedAIGraphNode.kind}</div>
                        <h3>{selectedAIGraphNode.label}</h3>
                        <p>{selectedAIGraphNode.description}</p>
                      </div>
                      <div className="glass-card">
                        <span className="proposal-section__label">Inputs</span>
                        <div className="proposal-list">
                          {selectedAIGraphNode.inputs.map((input, index) => (
                            <div key={`${selectedAIGraphNode.id}-input-${index}`} className="proposal-item">
                              {input}
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="glass-card">
                        <span className="proposal-section__label">Outputs</span>
                        <div className="proposal-list">
                          {selectedAIGraphNode.outputs.map((output, index) => (
                            <div key={`${selectedAIGraphNode.id}-output-${index}`} className="proposal-item">
                              {output}
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="glass-card">
                      <h3>Architecture overview</h3>
                      <p className="muted">Select a node in the graph to inspect what it does, what data it consumes, and what it emits.</p>
                    </div>
                  )}
                </div>
              </aside>
            ) : (
              <>
                <aside className="floating-properties-panel">
                  <div className="glass-panel glass-panel--stack">
                    {panelMode === 'root' ? (
                      <>
                        <label className="glass-field">
                          Title
                          <input value={snapshot.root.title} onChange={(event) => setRootField('title', event.target.value)} />
                        </label>
                        <label className="glass-field">
                          Description
                          <textarea
                            rows={5}
                            value={snapshot.root.description}
                            onChange={(event) => setRootField('description', event.target.value)}
                          />
                        </label>
                        <label className="glass-field">
                          Completion Criteria
                          <textarea
                            rows={5}
                            value={snapshot.root.completionCriteria}
                            onChange={(event) => setRootField('completionCriteria', event.target.value)}
                          />
                        </label>
                      </>
                    ) : panelItem ? (
                      <>
                        <label className="glass-field">
                          Title
                          <input ref={titleInputRef} value={panelItem.title} onChange={(event) => setNodeTitle(panelItem.id, event.target.value)} />
                        </label>
                        <label className="glass-field">
                          Description
                          <textarea
                            rows={5}
                            value={panelItem.description}
                            onChange={(event) => setNodeField(panelItem.id, 'description', event.target.value)}
                          />
                        </label>
                        <label className="glass-field">
                          Completion Criteria
                          <textarea
                            rows={5}
                            value={panelItem.completionCriteria}
                            onChange={(event) => setNodeField(panelItem.id, 'completionCriteria', event.target.value)}
                          />
                        </label>
                      </>
                    ) : (
                      <div className="glass-card">
                        <p className="muted">Select an item in the active tab to edit its title, description, and completion criteria.</p>
                      </div>
                    )}
                  </div>
                </aside>

                <aside
                  className={[
                    'floating-ai-dialog',
                    isAiDropActive ? 'is-drop-active' : '',
                    isAiDialogMinimized ? 'is-minimized' : '',
                  ].join(' ')}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (!isAiDropActive) {
                      setIsAiDropActive(true);
                    }
                  }}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setIsAiDropActive(true);
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget === event.target) {
                      setIsAiDropActive(false);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setIsAiDropActive(false);
                    void uploadAIDocumentFiles(Array.from(event.dataTransfer.files ?? []));
                  }}
                >
                  {isAiDialogMinimized ? (
                    <button
                      type="button"
                      className="canvas-glass-button floating-ai-dialog__collapsed-button"
                      onClick={() => setIsAiDialogMinimized(false)}
                      aria-label="Expand AI assistant"
                      title="Expand AI assistant"
                    >
                      <span className="floating-ai-dialog__collapsed-title">AI Assistant</span>
                      <span className="floating-ai-dialog__collapsed-meta">{aiContext.targetType}</span>
                    </button>
                  ) : (
                    <div className="glass-panel glass-panel--stack ai-dialog-panel">
                      <div className="panel-header floating-panel-header">
                        <h2>AI Assistant</h2>
                        <div className="floating-ai-dialog__header-actions">
                          <span>{aiContext.targetType}</span>
                          <button
                            type="button"
                            className="canvas-glass-button ai-dialog-button ai-dialog-button--icon"
                            onClick={() => setIsAiDialogMinimized(true)}
                            aria-label="Minimize AI assistant"
                            title="Minimize"
                          >
                            <ToolbarIcon path="M6 12h12" />
                          </button>
                        </div>
                      </div>

                      <div className="ai-dialog-panel__context">
                        <div className="glass-card">
                          <strong>{aiContext.targetTitle}</strong>
                          <p className="muted">
                            Context: {aiContext.targetType}
                            {aiContext.targetId ? ` · ${aiContext.targetId}` : ''}
                          </p>
                          {aiContext.scopeId ? <p className="muted">Within group: {aiScopeTitle}</p> : null}
                        </div>

                        <div className="glass-card">
                          <div className="panel-header floating-panel-header">
                            <h2>PDF Context</h2>
                          </div>
                          <input
                            ref={aiDocumentInputRef}
                            className="sr-only"
                            type="file"
                            accept="application/pdf,.pdf"
                            multiple
                            onChange={handleAIDocumentUpload}
                          />
                          {aiDocuments.length > 0 ? (
                            <div className="ai-document-list">
                              {aiDocuments.map((document) => (
                                <div key={document.id} className="ai-document-item">
                                  <div>
                                    <strong>{document.name}</strong>
                                    <p className="muted">
                                      {document.pageCount} page{document.pageCount === 1 ? '' : 's'} · {document.excerpt}
                                    </p>
                                  </div>
                                  <button type="button" className="ghost" onClick={() => removeAIDocument(document.id)}>
                                    Remove
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="muted">Upload one or more PDFs to give the assistant extra context.</p>
                          )}
                          {!isAiAvailable ? (
                            <p className="muted">
                              {appSettings.backendStatus === 'offline'
                                ? 'AI backend unavailable. Manual graph editing still works normally.'
                                : 'Configure an OpenAI API key in Settings to enable AI assistance.'}
                            </p>
                          ) : null}
                        </div>
                      </div>

                      <div className="ai-dialog-panel__scroll">
                        <div className="ai-message-list">
                          {aiMessages.map((message) => (
                            <div key={message.id} className={['ai-message', `is-${message.role}`].join(' ')}>
                              <span className="ai-message__role">{message.role}</span>
                              <p>{message.content}</p>
                            </div>
                          ))}
                          {isAiBusy ? <p className="muted">AI assistant is preparing a response...</p> : null}
                        </div>

                        {pendingProposal ? (
                          <div className="proposal-card proposal-card--review">
                            <div className="panel-header floating-panel-header">
                              <h2>Review Proposal</h2>
                              <span>{pendingProposal.operations.length} ops</span>
                            </div>
                            <div className="proposal-section">
                              <span className="proposal-section__label">Intent</span>
                              <p>{pendingProposal.intentSummary}</p>
                            </div>
                            <div className="proposal-section">
                              <span className="proposal-section__label">Context</span>
                              <p>{pendingProposal.contextSummary}</p>
                            </div>
                            <div className="proposal-section">
                              <span className="proposal-section__label">Plan</span>
                              <div className="proposal-list">
                                {pendingProposal.changePlan.map((step, index) => (
                                  <div key={`${pendingProposal.proposalId}-plan-${index}`} className="proposal-item">
                                    {step}
                                  </div>
                                ))}
                              </div>
                            </div>
                            {proposalDependencyLines.length > 0 ? (
                              <div className="proposal-section">
                                <span className="proposal-section__label">Dependencies</span>
                                <div className="proposal-list">
                                  {proposalDependencyLines.map((line, index) => (
                                    <div key={`${pendingProposal.proposalId}-dependency-${index}`} className="proposal-item">
                                      {line}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                            <div className="proposal-section">
                              <span className="proposal-section__label">Affected targets</span>
                              <div className="proposal-targets">
                                {pendingProposal.affectedTargets.map((target) => (
                                  <span key={`${pendingProposal.proposalId}-${target}`} className="proposal-target-chip">
                                    {formatProposalTarget(target)}
                                  </span>
                                ))}
                              </div>
                            </div>
                            {pendingProposal.openQuestions.length > 0 ? (
                              <div className="proposal-section">
                                <span className="proposal-section__label">Open questions</span>
                                <div className="proposal-list">
                                  {pendingProposal.openQuestions.map((question, index) => (
                                    <div key={`${pendingProposal.proposalId}-question-${index}`} className="proposal-item">
                                      {question}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                            <div className="proposal-section">
                              <span className="proposal-section__label">Mutation preview</span>
                              <div className="proposal-list">
                                {pendingProposal.operations.map((operation, index) => (
                                  <div key={`${pendingProposal.proposalId}-${index}`} className="proposal-item">
                                    {describeOperation(operation)}
                                  </div>
                                ))}
                              </div>
                            </div>
                            <div className="proposal-actions">
                              <button type="button" onClick={() => void applyPendingProposal()} disabled={isApplyingProposal}>
                                {isApplyingProposal ? 'Applying...' : 'Yes'}
                              </button>
                              <button type="button" className="secondary" onClick={rejectPendingProposal} disabled={isApplyingProposal}>
                                No
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => setIsProposalRevisionOpen((current) => !current)}
                                disabled={isApplyingProposal}
                              >
                                Yes, but change this
                              </button>
                            </div>
                            {isProposalRevisionOpen ? (
                              <div className="proposal-refinement">
                                <textarea
                                  rows={3}
                                  value={proposalRevisionDraft}
                                  placeholder="Describe the adjustment you want in the proposal."
                                  onChange={(event) => setProposalRevisionDraft(event.target.value)}
                                />
                                <button
                                  type="button"
                                  onClick={() => void revisePendingProposal()}
                                  disabled={!proposalRevisionDraft.trim() || isAiBusy}
                                >
                                  {isAiBusy ? 'Revising...' : 'Send adjustment'}
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}

                        {!pendingProposal && pendingMemoryResult ? (
                          <div className="proposal-card proposal-card--review">
                            <div className="panel-header floating-panel-header">
                              <h2>Memory Result</h2>
                              <span>{pendingMemoryResult.actionType.replace(/_/g, ' ')}</span>
                            </div>
                            <div className="proposal-section">
                              <span className="proposal-section__label">Summary</span>
                              <p>{pendingMemoryResult.summary}</p>
                            </div>
                            {pendingMemoryResult.createdItems.length > 0 ? (
                              <div className="proposal-section">
                                <span className="proposal-section__label">Created memory</span>
                                <div className="proposal-list">
                                  {pendingMemoryResult.createdItems.map((item) => (
                                    <div key={item.id} className="proposal-item">
                                      <strong>{item.kind}</strong>: {item.content}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                            {pendingMemoryResult.updatedItems.length > 0 ? (
                              <div className="proposal-section">
                                <span className="proposal-section__label">Updated memory</span>
                                <div className="proposal-list">
                                  {pendingMemoryResult.updatedItems.map((item) => (
                                    <div key={item.id} className="proposal-item">
                                      <strong>{item.kind}</strong>: {item.content} · status {item.status}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                            {pendingMemoryResult.reviewIssues.length > 0 ? (
                              <div className="proposal-section">
                                <span className="proposal-section__label">Review issues</span>
                                <div className="proposal-list">
                                  {pendingMemoryResult.reviewIssues.map((issue) => (
                                    <div key={issue.id} className="proposal-item">
                                      <strong>{issue.type}</strong>: {issue.summary}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                            {pendingMemoryResult.preferenceProposals.length > 0 ? (
                              <div className="proposal-section">
                                <span className="proposal-section__label">Preference proposals</span>
                                <div className="proposal-list">
                                  {pendingMemoryResult.preferenceProposals.map((proposal) => (
                                    <div key={proposal.id} className="proposal-item">
                                      <strong>{proposal.type}</strong>: {proposal.proposed_rule}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                            {pendingMemoryResult.warnings.length > 0 ? (
                              <div className="proposal-section">
                                <span className="proposal-section__label">Warnings</span>
                                <div className="proposal-list">
                                  {pendingMemoryResult.warnings.map((warning, index) => (
                                    <div key={`${pendingMemoryResult.actionType}-warning-${index}`} className="proposal-item">
                                      {warning}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                            {pendingMemoryResult.sessionSummary ? (
                              <div className="proposal-section">
                                <span className="proposal-section__label">Session summary</span>
                                <div className="proposal-list">
                                  <div className="proposal-item">{pendingMemoryResult.sessionSummary.summary}</div>
                                  <div className="proposal-item">
                                    Touched memory items: {pendingMemoryResult.sessionSummary.touched_memory_item_ids.length}
                                  </div>
                                </div>
                              </div>
                            ) : null}
                            <div className="proposal-actions">
                              <button type="button" onClick={rejectPendingProposal}>
                                Clear
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <div className="ai-dialog-panel__composer">
                        <div className="ai-composer">
                          <textarea
                            rows={4}
                            value={aiInput}
                            placeholder="Ask the AI to draft graph changes or remember project context, decisions, notes, and preferences."
                            onChange={(event) => setAiInput(event.target.value)}
                          />
                          <div className="ai-composer__actions">
                            <button
                              type="button"
                              className="canvas-glass-button ai-dialog-button ai-dialog-button--icon"
                              onClick={() => aiDocumentInputRef.current?.click()}
                              disabled={isUploadingAiDocuments}
                              aria-label="Add PDF context"
                              title={isUploadingAiDocuments ? 'Uploading PDF...' : 'Add PDF context'}
                            >
                              <ToolbarIcon path="M12 5v14M5 12h14" />
                            </button>
                            <button
                              type="button"
                              className="canvas-glass-button ai-dialog-button"
                              onClick={() => void sendAiMessage()}
                              disabled={isAiBusy || !aiInput.trim() || !isAiAvailable}
                            >
                              Send
                            </button>
                          </div>
                        </div>
                      </div>

                      {aiError ? <p className="feedback feedback--error">{aiError}</p> : null}
                    </div>
                  )}
                </aside>
              </>
            )}
          </section>
        </div>
      </div>

      {isSettingsOpen ? (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
          <button type="button" className="settings-overlay__scrim" onClick={() => setIsSettingsOpen(false)} aria-label="Close settings" />
          <div className="settings-overlay__panel">
            <div className="panel settings-panel settings-panel--overlay">
              <div className="panel-header">
                <h2>Settings</h2>
                <button type="button" className="icon-button secondary" onClick={() => setIsSettingsOpen(false)} aria-label="Close settings">
                  <ToolbarIcon path="M7 7 17 17M17 7 7 17" />
                </button>
              </div>

              <div className="settings-section">
                <div className="settings-row">
                  <div>
                    <strong>Theme</strong>
                    <p className="muted">Architectural Chromaticism uses a single dark workspace tuned to the redesign system.</p>
                  </div>
                  <span className="status-pill is-online">Dark only</span>
                </div>
              </div>

              <div className="settings-section">
                <div className="panel-header">
                  <h2>OpenAI</h2>
                  <span className={['status-pill', appSettings.backendStatus === 'online' ? 'is-online' : 'is-offline'].join(' ')}>
                    {isSettingsLoading ? 'Checking' : appSettings.backendStatus}
                  </span>
                </div>
                <p className="muted">
                  API key status: {appSettings.openai.hasApiKey ? 'configured on backend' : 'not configured'}
                </p>
                <label>
                  API Key
                  <input
                    type="password"
                    value={apiKeyDraft}
                    placeholder={appSettings.openai.hasApiKey ? 'Configured. Enter a new key to replace it.' : 'sk-...'}
                    onChange={(event) => setApiKeyDraft(event.target.value)}
                  />
                </label>
                <label>
                  Model
                  <select value={selectedModelDraft} onChange={(event) => setSelectedModelDraft(event.target.value)}>
                    <option value="">Choose a model</option>
                    {modelOptions.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="settings-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void loadModels({ silentNoKey: false })}
                    disabled={isModelsLoading || !appSettings.openai.hasApiKey}
                  >
                    {isModelsLoading ? 'Refreshing...' : 'Refresh models'}
                  </button>
                  <button type="button" onClick={() => void saveSettings()}>
                    Save OpenAI settings
                  </button>
                </div>
                {!appSettings.openai.hasApiKey && !settingsError ? (
                  <p className="muted">Add an API key first, then refresh models to populate the picker.</p>
                ) : null}
                {settingsError ? <p className="feedback feedback--error">{settingsError}</p> : null}
                {settingsMessage ? <p className="feedback">{settingsMessage}</p> : null}
              </div>

              <div className="settings-section">
                <div className="panel-header">
                  <h2>Notion</h2>
                  <span className={['status-pill', appSettings.notion.tokenConfigured ? 'is-online' : 'is-offline'].join(' ')}>
                    {appSettings.notion.tokenConfigured ? 'configured' : 'not configured'}
                  </span>
                </div>
                <p className="muted">
                  Share your notes and progress databases with the Notion integration, then save the token and database IDs here.
                </p>
                <label>
                  Integration Token
                  <input
                    type="password"
                    value={notionTokenDraft}
                    placeholder={appSettings.notion.tokenConfigured ? 'Configured. Enter a new token to replace it.' : 'secret_...'}
                    onChange={(event) => setNotionTokenDraft(event.target.value)}
                  />
                </label>
                <label>
                  Notes Database ID
                  <input
                    value={notionNotesDatabaseIdDraft}
                    placeholder="Database ID for AI note lookup"
                    onChange={(event) => setNotionNotesDatabaseIdDraft(event.target.value)}
                  />
                </label>
                <div className="settings-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void loadNotionNotesSchema()}
                    disabled={isNotionNotesSchemaLoading || !notionNotesDatabaseIdDraft.trim()}
                  >
                    {isNotionNotesSchemaLoading ? 'Loading schema...' : 'Load notes schema'}
                  </button>
                </div>
                {notionNotesSchema ? (
                  <div className="settings-section">
                    <div className="panel-header">
                      <h2>Notes Field Mapping</h2>
                      <span>{notionNotesSchema.properties.length} fields</span>
                    </div>
                    <p className="muted">
                      Map your notes database properties so ProjectPlanner can read the right note metadata before ranking and loading note content.
                    </p>
                    {(Object.keys(notionNotesFieldLabels) as NotionNotesFieldKey[]).map((fieldKey) => {
                      const typeByField: Record<NotionNotesFieldKey, string[]> = {
                        titleField: ['title'],
                        summaryField: ['rich_text'],
                        statusField: ['status', 'select'],
                        tagsField: ['multi_select'],
                        scopeField: ['rich_text', 'select', 'multi_select'],
                      };
                      const availableProperties = notionNotesSchema.properties.filter((property) =>
                        typeByField[fieldKey].includes(property.type),
                      );

                      return (
                        <label key={fieldKey}>
                          {notionNotesFieldLabels[fieldKey]}
                          <select
                            value={notionNotesFieldMapDraft[fieldKey]}
                            onChange={(event) =>
                              setNotionNotesFieldMapDraft((current) => ({
                                ...current,
                                [fieldKey]: event.target.value,
                              }))
                            }
                          >
                            <option value="">Choose a field</option>
                            {availableProperties.map((property) => (
                              <option key={`${fieldKey}-${property.id}`} value={property.name}>
                                {property.name} ({property.type})
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                ) : null}
                <label>
                  Progress Database ID
                  <input
                    value={notionProgressDatabaseIdDraft}
                    placeholder="Database ID for session sync logs"
                    onChange={(event) => setNotionProgressDatabaseIdDraft(event.target.value)}
                  />
                </label>
                <div className="settings-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void loadNotionProgressSchema()}
                    disabled={isNotionProgressSchemaLoading || !notionProgressDatabaseIdDraft.trim()}
                  >
                    {isNotionProgressSchemaLoading ? 'Loading schema...' : 'Load progress schema'}
                  </button>
                </div>
                {notionProgressSchema ? (
                  <div className="settings-section">
                    <div className="panel-header">
                      <h2>Progress Field Mapping</h2>
                      <span>{notionProgressSchema.properties.length} fields</span>
                    </div>
                    <p className="muted">
                      Map your existing Notion database properties to the fields ProjectPlanner needs for progress sync.
                    </p>
                    {(Object.keys(notionProgressFieldLabels) as NotionProgressFieldKey[]).map((fieldKey) => {
                      const typeByField: Record<NotionProgressFieldKey, string[]> = {
                        titleField: ['title'],
                        projectNameField: ['rich_text'],
                        syncedAtField: ['date'],
                        changedCountField: ['number'],
                        completedCountField: ['number'],
                        scopeField: ['rich_text'],
                      };
                      const availableProperties = notionProgressSchema.properties.filter((property) =>
                        typeByField[fieldKey].includes(property.type),
                      );

                      return (
                        <label key={fieldKey}>
                          {notionProgressFieldLabels[fieldKey]}
                          <select
                            value={notionProgressFieldMapDraft[fieldKey]}
                            onChange={(event) =>
                              setNotionProgressFieldMapDraft((current) => ({
                                ...current,
                                [fieldKey]: event.target.value,
                              }))
                            }
                          >
                            <option value="">Choose a field</option>
                            {availableProperties.map((property) => (
                              <option key={`${fieldKey}-${property.id}`} value={property.name}>
                                {property.name} ({property.type})
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                ) : null}
                <label className="settings-row">
                  <div>
                    <strong>Use Notion Notes For AI Context</strong>
                    <p className="muted">Search matching notes from your configured Notion notes database before AI requests.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={useNotionNotesForAiContextDraft}
                    onChange={(event) => setUseNotionNotesForAiContextDraft(event.target.checked)}
                  />
                </label>
                <label className="settings-row">
                  <div>
                    <strong>Enable Notion Progress Logging</strong>
                    <p className="muted">Track planner changes locally and let you sync them as one session entry.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={enableNotionProgressSyncDraft}
                    onChange={(event) => setEnableNotionProgressSyncDraft(event.target.checked)}
                  />
                </label>
                <div className="settings-actions">
                  <button type="button" onClick={() => void saveNotionConfiguration()}>
                    Save Notion settings
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void syncCurrentSessionToNotion()}
                    disabled={!isNotionProgressSyncAvailable || isNotionSyncing}
                  >
                    {isNotionSyncing ? 'Syncing...' : 'Sync current session to Notion'}
                  </button>
                </div>
                <p className="muted">
                  Session journal: {sessionJournal.length} tracked change{sessionJournal.length === 1 ? '' : 's'} ready to sync.
                </p>
                {notionSettingsError ? <p className="feedback feedback--error">{notionSettingsError}</p> : null}
                {notionSettingsMessage ? <p className="feedback">{notionSettingsMessage}</p> : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <PlannerApp />
    </ReactFlowProvider>
  );
}
