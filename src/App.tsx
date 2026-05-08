import { CSSProperties, ChangeEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  BaseEdge,
  Connection,
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
  ApiError,
  ExternalRef,
  MemoryScope,
  applyProjectGraphOperations,
  checkWorkflowService,
  createProjectGraph,
  fetchProjectGraph,
  listStoredProjects,
  StoredProjectSummary,
} from './api';
import { AiPanel } from './AiPanel';
import addIconSvg from '../material-design-icons-4.0.0/src/content/add/materialicons/24px.svg?raw';
import searchIconSvg from '../material-design-icons-4.0.0/src/action/search/materialicons/24px.svg?raw';
import openInNewIconSvg from '../material-design-icons-4.0.0/src/action/open_in_new/materialicons/24px.svg?raw';
import warningIconSvg from '../material-design-icons-4.0.0/src/alert/warning/materialicons/24px.svg?raw';
import deviceHubIconSvg from '../material-design-icons-4.0.0/src/hardware/device_hub/materialicons/24px.svg?raw';
import accountTreeIconSvg from '../material-design-icons-4.0.0/src/notification/account_tree/materialiconsoutlined/24px.svg?raw';
import checkIconSvg from '../material-design-icons-4.0.0/src/navigation/check/materialicons/24px.svg?raw';
import closeIconSvg from '../material-design-icons-4.0.0/src/navigation/close/materialicons/24px.svg?raw';

type PlannerNodeKind = 'task' | 'group';
type TaskStatus = 'todo' | 'done';
type ScopeId = string | null;
type ThemeMode = 'dark' | 'light';
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
  conceptId?: string | null;
  externalRefs?: ExternalRef[];
  sourceKind?: string | null;
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
    conceptId?: string | null;
    externalRefs?: ExternalRef[];
    sourceKind?: string | null;
    memoryScope?: MemoryScope;
  };
  nodes: PlannerNodeRecord[];
  edges: PlannerEdgeRecord[];
};

type TabDescriptor =
  | { id: 'main'; kind: 'main' }
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

type ImportableProjectFile =
  | ProjectFileV1
  | PlannerSnapshot
  | {
      projectId?: string;
      project: PlannerSnapshot;
    };

type RenderNodeData = {
  title: string;
  kind: PlannerNodeKind;
  status: TaskStatus;
  isAvailable: boolean;
  isBlocked: boolean;
  isDropTarget: boolean;
  isEmptyGroup?: boolean;
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
type NodeJournalState = {
  id: string;
  kind: PlannerNodeKind;
  title: string;
  description: string;
  completionCriteria: string;
  status: TaskStatus;
  scopeTitle: string;
};
type SessionJournalEntry = JournalEntryBase & {
  entityKey?: string;
  initialNodeState?: NodeJournalState;
  finalNodeState?: NodeJournalState;
  nodeAction?: 'created' | 'updated' | 'deleted';
};
type SessionJournalEntryType =
  | 'create_node'
  | 'update_node'
  | 'update_root'
  | 'status_change'
  | 'create_edge'
  | 'delete_node'
  | 'delete_edge'
  | 'apply_proposal';

type JournalEntryBase = {
  type: SessionJournalEntryType;
  title: string;
  detail: string;
  scopeTitle?: string | null;
  completed?: boolean;
};

type BackendStatus = 'checking' | 'online' | 'offline';

const STORAGE_KEY = 'project-planner-state-v2';
const THEME_STORAGE_KEY = 'project-planner-theme-v1';
const LEFT_PANEL_WIDTH_STORAGE_KEY = 'project-planner-left-panel-width-v1';
const RIGHT_PANEL_WIDTH_STORAGE_KEY = 'project-planner-right-panel-width-v1';
const OPENAI_API_KEY_STORAGE_KEY = 'project-planner-openai-api-key-v1';
const SUPERMEMORY_API_KEY_STORAGE_KEY = 'project-planner-supermemory-api-key-v1';
const NOTION_API_KEY_STORAGE_KEY = 'project-planner-notion-api-key-v1';
const NOTION_PARENT_ID_STORAGE_KEY = 'project-planner-notion-parent-id-v1';
const TASK_GRAPH_MCP_URL_STORAGE_KEY = 'project-planner-task-graph-mcp-url-v1';
const SUPERMEMORY_MCP_URL_STORAGE_KEY = 'project-planner-supermemory-mcp-url-v1';
const NOTION_MCP_URL_STORAGE_KEY = 'project-planner-notion-mcp-url-v1';
const mainTab: TabDescriptor = { id: 'main', kind: 'main' };
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
    conceptId: 'project-root',
    externalRefs: [],
    sourceKind: 'human-authored',
    memoryScope: {
      containerTags: ['project-root'],
      metadataDefaults: { projectId: 'project-root' },
      retrievalDefaults: { limit: 6, searchMode: 'hybrid' },
    },
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
      conceptId: 'vision',
      externalRefs: [],
      sourceKind: 'human-authored',
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
      conceptId: 'research-users',
      externalRefs: [],
      sourceKind: 'human-authored',
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
      conceptId: 'architecture',
      externalRefs: [],
      sourceKind: 'human-authored',
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
      conceptId: 'build-prototype',
      externalRefs: [],
      sourceKind: 'human-authored',
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
      conceptId: 'ui-shell',
      externalRefs: [],
      sourceKind: 'human-authored',
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
      conceptId: 'task-workflow',
      externalRefs: [],
      sourceKind: 'human-authored',
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
      conceptId: 'map-dependencies',
      externalRefs: [],
      sourceKind: 'human-authored',
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
      conceptId: 'show-available-work',
      externalRefs: [],
      sourceKind: 'human-authored',
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
      conceptId: 'qa-review',
      externalRefs: [],
      sourceKind: 'human-authored',
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
      conceptId: 'launch-prep',
      externalRefs: [],
      sourceKind: 'human-authored',
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
    conceptId: null,
    externalRefs: [],
    sourceKind: 'human-authored',
    memoryScope: {
      containerTags: [],
      metadataDefaults: {},
      retrievalDefaults: { limit: 6, searchMode: 'hybrid' },
    },
  },
  nodes: [],
  edges: [],
});

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
const createProjectId = () => `project-${Math.random().toString(36).slice(2, 10)}`;
const serializeSnapshot = (snapshot: PlannerSnapshot) => JSON.stringify(snapshot);
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
    conceptId: rawRoot?.conceptId ?? null,
    externalRefs: Array.isArray(rawRoot?.externalRefs) ? rawRoot.externalRefs : [],
    sourceKind: rawRoot?.sourceKind ?? null,
    memoryScope: {
      containerTags: Array.isArray(rawRoot?.memoryScope?.containerTags)
        ? rawRoot.memoryScope.containerTags.map((tag: unknown) => String(tag)).filter(Boolean)
        : [],
      metadataDefaults:
        rawRoot?.memoryScope && typeof rawRoot.memoryScope.metadataDefaults === 'object' && rawRoot.memoryScope.metadataDefaults
          ? Object.fromEntries(
              Object.entries(rawRoot.memoryScope.metadataDefaults as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
            )
          : {},
      retrievalDefaults: {
        limit: Number(rawRoot?.memoryScope?.retrievalDefaults?.limit ?? 6),
        searchMode: String(rawRoot?.memoryScope?.retrievalDefaults?.searchMode ?? 'hybrid'),
      },
    },
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
      conceptId: legacyNode.conceptId ?? null,
      externalRefs: Array.isArray(legacyNode.externalRefs) ? legacyNode.externalRefs : [],
      sourceKind: legacyNode.sourceKind ?? null,
    };
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const seenEdgeIds = new Set<string>();
  const seenEdgePairs = new Set<string>();
  const edges = snapshot.edges.filter((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      return false;
    }
    if (edge.source === edge.target) {
      return false;
    }
    if (!isSameScope(nodes, edge.source, edge.target)) {
      return false;
    }
    if (seenEdgeIds.has(edge.id)) {
      return false;
    }

    const pairKey = `${edge.source}::${edge.target}`;
    if (seenEdgePairs.has(pairKey)) {
      return false;
    }

    seenEdgeIds.add(edge.id);
    seenEdgePairs.add(pairKey);
    return true;
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
  const normalized = (tabs ?? []).filter((tab) => tab.kind === 'main' || validGroupIds.has(tab.id));
  const deduped = normalized.filter(
    (tab, index) => normalized.findIndex((candidate) => candidate.id === tab.id && candidate.kind === tab.kind) === index,
  );
  return deduped.some((tab) => tab.kind === 'main') ? deduped : [mainTab, ...deduped];
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

const isPlannerSnapshot = (value: unknown): value is PlannerSnapshot => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<PlannerSnapshot>;
  return Boolean(candidate.root && Array.isArray(candidate.nodes) && Array.isArray(candidate.edges));
};

const normalizeImportedProjectFile = (raw: ImportableProjectFile): ProjectFileV1 => {
  if (isPlannerSnapshot(raw)) {
    return sanitizeProjectFile({
      version: 2,
      projectId: createProjectId(),
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
      projectId: typeof raw.projectId === 'string' ? raw.projectId : createProjectId(),
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

const getNodeElementFromDragEvent = (event: MouseEvent | ReactMouseEvent, nodeId: string): HTMLElement | null => {
  const target = event.target;
  if (target instanceof Element) {
    const closestNode = target.closest('.react-flow__node') as HTMLElement | null;
    if (closestNode?.getAttribute('data-id') === nodeId) {
      return closestNode;
    }
  }

  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`) as HTMLElement | null;
  }

  return document.querySelector(`.react-flow__node[data-id="${nodeId}"]`) as HTMLElement | null;
};

const getRectSampleAxis = (start: number, end: number, maxStep: number) => {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return [start];
  }

  const size = end - start;
  const segmentCount = Math.max(1, Math.ceil(size / maxStep));
  const points: number[] = [];

  for (let index = 0; index <= segmentCount; index += 1) {
    points.push(start + (size * index) / segmentCount);
  }

  return points;
};

const findEdgeIdIntersectingRect = (rect: DOMRect): string | null => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = Math.max(0, rect.left);
  const right = Math.min(viewportWidth, rect.right);
  const top = Math.max(0, rect.top);
  const bottom = Math.min(viewportHeight, rect.bottom);

  if (right <= left || bottom <= top) {
    return null;
  }

  const sampleXs = getRectSampleAxis(left, right, 18);
  const sampleYs = getRectSampleAxis(top, bottom, 18);

  for (const clientY of sampleYs) {
    for (const clientX of sampleXs) {
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
    }
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
        isEmptyGroup: node.kind === 'group' ? childCount === 0 : undefined,
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

const clampLeftPanelWidth = (value: number) => Math.min(720, Math.max(320, value));

const clampRightPanelWidth = (value: number) => Math.min(720, Math.max(360, value));

const getStoredLeftPanelWidth = () => {
  if (typeof window === 'undefined') {
    return 380;
  }

  const raw = window.localStorage.getItem(LEFT_PANEL_WIDTH_STORAGE_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? clampLeftPanelWidth(parsed) : 380;
};

const getStoredRightPanelWidth = () => {
  if (typeof window === 'undefined') {
    return 440;
  }

  const raw = window.localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? clampRightPanelWidth(parsed) : 440;
};

const getStoredSupermemoryApiKey = () => {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.localStorage.getItem(SUPERMEMORY_API_KEY_STORAGE_KEY) ?? '';
};

const getStoredOpenaiApiKey = () => {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.localStorage.getItem(OPENAI_API_KEY_STORAGE_KEY) ?? '';
};

const getStoredNotionApiKey = () => {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.localStorage.getItem(NOTION_API_KEY_STORAGE_KEY) ?? '';
};

const getStoredNotionParentId = () => {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.localStorage.getItem(NOTION_PARENT_ID_STORAGE_KEY) ?? '';
};

const getStoredTaskGraphMcpUrl = () => {
  if (typeof window === 'undefined') {
    return '/api/mcp/task-graph';
  }

  return window.localStorage.getItem(TASK_GRAPH_MCP_URL_STORAGE_KEY) ?? '/api/mcp/task-graph';
};

const getStoredSupermemoryMcpUrl = () => {
  if (typeof window === 'undefined') {
    return '/api/mcp/supermemory';
  }

  return window.localStorage.getItem(SUPERMEMORY_MCP_URL_STORAGE_KEY) ?? '/api/mcp/supermemory';
};

const getStoredNotionMcpUrl = () => {
  if (typeof window === 'undefined') {
    return '/api/mcp/notion';
  }

  return window.localStorage.getItem(NOTION_MCP_URL_STORAGE_KEY) ?? '/api/mcp/notion';
};

const nextAvailableOffset = (nodes: PlannerNodeRecord[], parentId?: string) => {
  const siblings = nodes.filter((node) => node.parentId === parentId);
  return {
    x: 90 + (siblings.length % 4) * 120,
    y: 110 + Math.floor(siblings.length / 4) * 120,
  };
};

const materialIconSvgs = {
  add: addIconSvg,
  check: checkIconSvg,
  close: closeIconSvg,
  device_hub: deviceHubIconSvg,
  open_in_new: openInNewIconSvg,
  search: searchIconSvg,
  warning: warningIconSvg,
} as const;

type MaterialIconName = keyof typeof materialIconSvgs;

const ToolbarIcon = ({ name }: { name: MaterialIconName }) => (
  <span className="app-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: materialIconSvgs[name] }} />
);

const Graph3Icon = () => <span className="app-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: accountTreeIconSvg }} />;

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
          <ToolbarIcon name="check" />
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
          <ToolbarIcon name="device_hub" />
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
        <ToolbarIcon name="open_in_new" />
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
      <ToolbarIcon name="close" />
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
      <div className="group-entry-node__eyebrow">
        <span>Node Group</span>
        {data.isEmptyGroup ? (
          <span
            className="group-entry-node__warning"
            title="Warning: Node group is empty"
            aria-label="Warning: Node group is empty"
          >
            <ToolbarIcon name="warning" />
          </span>
        ) : null}
      </div>
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

const nodeTypes = {
  plannerTask: TaskNode,
  plannerGroup: GroupNode,
};

const edgeTypes = {
  dragPreview: DragPreviewFlowEdge,
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
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [projectId, setProjectId] = useState<string>(() => getStoredProjectId());
  const [snapshot, setSnapshot] = useState<PlannerSnapshot>(() => getStoredSnapshot());
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredTheme());
  const [openTabs, setOpenTabs] = useState<TabDescriptor[]>([mainTab]);
  const [activeTabId, setActiveTabId] = useState<string>('main');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [fileFeedback, setFileFeedback] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [tagQuery, setTagQuery] = useState('');
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(() => getStoredLeftPanelWidth());
  const [shouldFocusSelectedTitle, setShouldFocusSelectedTitle] = useState(false);
  const [insertionEdgeId, setInsertionEdgeId] = useState<string | null>(null);
  const [pendingCenteredNodeId, setPendingCenteredNodeId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProjectLibraryOpen, setIsProjectLibraryOpen] = useState(false);
  const [storedProjects, setStoredProjects] = useState<StoredProjectSummary[]>([]);
  const [isStoredProjectsLoading, setIsStoredProjectsLoading] = useState(false);
  const [storedProjectsError, setStoredProjectsError] = useState<string | null>(null);
  const [loadingStoredProjectId, setLoadingStoredProjectId] = useState<string | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>('checking');
  const [sessionJournal, setSessionJournal] = useState<SessionJournalEntry[]>([]);
  const [rightPanelWidth, setRightPanelWidth] = useState(() => getStoredRightPanelWidth());
  const [openaiApiKey, setOpenaiApiKey] = useState(() => getStoredOpenaiApiKey());
  const [supermemoryApiKey, setSupermemoryApiKey] = useState(() => getStoredSupermemoryApiKey());
  const [notionApiKey, setNotionApiKey] = useState(() => getStoredNotionApiKey());
  const [notionParentId, setNotionParentId] = useState(() => getStoredNotionParentId());
  const [taskGraphMcpUrl, setTaskGraphMcpUrl] = useState(() => getStoredTaskGraphMcpUrl());
  const [supermemoryMcpUrl, setSupermemoryMcpUrl] = useState(() => getStoredSupermemoryMcpUrl());
  const [notionMcpUrl, setNotionMcpUrl] = useState(() => getStoredNotionMcpUrl());
  const [dragDropTarget, setDragDropTarget] = useState<NodeDropTarget>(null);
  const [dragPreviewNodeId, setDragPreviewNodeId] = useState<string | null>(null);
  const [flowViewport, setFlowViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [isCanvasPointerDown, setIsCanvasPointerDown] = useState(false);
  const [isProjectGraphLoading, setIsProjectGraphLoading] = useState(true);
  const [graphSyncError, setGraphSyncError] = useState<string | null>(null);
  const isResizingPanelRef = useRef(false);
  const isResizingLeftPanelRef = useRef(false);
  const canvasNodesRef = useRef<PlannerFlowNode[]>([]);
  const snapshotRef = useRef(snapshot);
  const projectIdRef = useRef(projectId);
  const isInspectorEditingRef = useRef(false);
  const isApplyingServerSnapshotRef = useRef(false);
  const hasHydratedProjectRef = useRef(false);
  const syncTimerRef = useRef<number | null>(null);
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const syncResolveRef = useRef<(() => void) | null>(null);
  const syncInFlightRef = useRef(false);
  const queuedSnapshotRef = useRef<PlannerSnapshot | null>(null);
  const lastSyncedSnapshotRef = useRef(serializeSnapshot(snapshot));
  const activeScopeId: ScopeId = activeTabId === 'main' ? null : activeTabId;

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
    window.localStorage.setItem(LEFT_PANEL_WIDTH_STORAGE_KEY, String(leftPanelWidth));
  }, [leftPanelWidth]);

  useEffect(() => {
    window.localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(rightPanelWidth));
  }, [rightPanelWidth]);

  useEffect(() => {
    window.localStorage.setItem(OPENAI_API_KEY_STORAGE_KEY, openaiApiKey);
  }, [openaiApiKey]);

  useEffect(() => {
    window.localStorage.setItem(SUPERMEMORY_API_KEY_STORAGE_KEY, supermemoryApiKey);
  }, [supermemoryApiKey]);

  useEffect(() => {
    window.localStorage.setItem(NOTION_API_KEY_STORAGE_KEY, notionApiKey);
  }, [notionApiKey]);

  useEffect(() => {
    window.localStorage.setItem(NOTION_PARENT_ID_STORAGE_KEY, notionParentId);
  }, [notionParentId]);

  useEffect(() => {
    window.localStorage.setItem(TASK_GRAPH_MCP_URL_STORAGE_KEY, taskGraphMcpUrl);
  }, [taskGraphMcpUrl]);

  useEffect(() => {
    window.localStorage.setItem(SUPERMEMORY_MCP_URL_STORAGE_KEY, supermemoryMcpUrl);
  }, [supermemoryMcpUrl]);

  useEffect(() => {
    window.localStorage.setItem(NOTION_MCP_URL_STORAGE_KEY, notionMcpUrl);
  }, [notionMcpUrl]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  const applyServerProjectGraph = useCallback((nextProjectId: string, nextSnapshot: PlannerSnapshot) => {
    const normalizedSnapshot = sanitizeSnapshot(nextSnapshot);
    isApplyingServerSnapshotRef.current = true;
    lastSyncedSnapshotRef.current = serializeSnapshot(normalizedSnapshot);
    setProjectId(nextProjectId);
    setSnapshot(normalizedSnapshot);
    setGraphSyncError(null);
  }, []);

  const loadStoredProjects = useCallback(async () => {
    setIsStoredProjectsLoading(true);
    setStoredProjectsError(null);

    try {
      const projects = await listStoredProjects();
      setStoredProjects(projects);
    } catch (error) {
      setStoredProjectsError(error instanceof Error ? error.message : 'Could not load saved projects.');
    } finally {
      setIsStoredProjectsLoading(false);
    }
  }, []);

  const persistSnapshotToServer = useCallback(
    async (nextSnapshot?: PlannerSnapshot) => {
      const snapshotToPersist = sanitizeSnapshot(nextSnapshot ?? snapshotRef.current);
      const response = await applyProjectGraphOperations(projectIdRef.current, [
        {
          type: 'replace_graph',
          project: snapshotToPersist,
        },
      ]);

      applyServerProjectGraph(response.projectId, response.project as PlannerSnapshot);
      setFileFeedback(null);
    },
    [applyServerProjectGraph],
  );

  const ensureSyncPromise = useCallback(() => {
    if (!syncPromiseRef.current) {
      syncPromiseRef.current = new Promise<void>((resolve) => {
        syncResolveRef.current = resolve;
      });
    }
    return syncPromiseRef.current;
  }, []);

  const resolveSyncPromise = useCallback(() => {
    syncResolveRef.current?.();
    syncResolveRef.current = null;
    syncPromiseRef.current = null;
  }, []);

  const processQueuedSnapshotSync = useCallback(async () => {
    if (syncInFlightRef.current) {
      return ensureSyncPromise();
    }

    if (!queuedSnapshotRef.current) {
      resolveSyncPromise();
      return null;
    }

    ensureSyncPromise();
    syncInFlightRef.current = true;

    try {
      while (queuedSnapshotRef.current) {
        const nextSnapshot = sanitizeSnapshot(queuedSnapshotRef.current);
        queuedSnapshotRef.current = null;

        if (serializeSnapshot(nextSnapshot) === lastSyncedSnapshotRef.current) {
          continue;
        }

        await persistSnapshotToServer(nextSnapshot);
      }
      setGraphSyncError(null);
    } catch (error) {
      queuedSnapshotRef.current = null;
      setGraphSyncError(error instanceof Error ? error.message : 'Could not persist the workflow.');
    } finally {
      syncInFlightRef.current = false;
      resolveSyncPromise();
    }

    return null;
  }, [ensureSyncPromise, persistSnapshotToServer, resolveSyncPromise]);

  const queueSnapshotSync = useCallback(
    (nextSnapshot: PlannerSnapshot) => {
      queuedSnapshotRef.current = sanitizeSnapshot(nextSnapshot);
      void processQueuedSnapshotSync();
      return ensureSyncPromise();
    },
    [ensureSyncPromise, processQueuedSnapshotSync],
  );

  const flushProjectGraphSync = useCallback(async () => {
    const snapshotToSync = sanitizeSnapshot(snapshotRef.current);
    const nextSerialized = serializeSnapshot(snapshotToSync);
    if (!hasHydratedProjectRef.current || nextSerialized === lastSyncedSnapshotRef.current) {
      return;
    }

    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }

    await queueSnapshotSync(snapshotToSync);
  }, [queueSnapshotSync]);

  const initializeProjectGraph = useCallback(async () => {
    setIsProjectGraphLoading(true);
    setGraphSyncError(null);

    try {
      await checkWorkflowService();
      setBackendStatus('online');
      const response = await fetchProjectGraph(projectIdRef.current);
      applyServerProjectGraph(response.projectId, response.project as PlannerSnapshot);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        const response = await createProjectGraph({
          projectId: projectIdRef.current,
          project: snapshotRef.current,
        });
        applyServerProjectGraph(response.projectId, response.project as PlannerSnapshot);
        setBackendStatus('online');
      } else {
        setBackendStatus('offline');
        setGraphSyncError(error instanceof Error ? error.message : 'Could not load the workflow from the backend.');
      }
    } finally {
      hasHydratedProjectRef.current = true;
      setIsProjectGraphLoading(false);
    }
  }, [applyServerProjectGraph]);

  useEffect(() => {
    void initializeProjectGraph();
  }, [initializeProjectGraph]);

  useEffect(() => {
    if (!hasHydratedProjectRef.current) {
      return;
    }
    if (isApplyingServerSnapshotRef.current) {
      isApplyingServerSnapshotRef.current = false;
      return;
    }

    const nextSerialized = serializeSnapshot(snapshot);
    if (nextSerialized === lastSyncedSnapshotRef.current) {
      return;
    }

    if (isInspectorEditingRef.current) {
      return;
    }

    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
    }

    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      void queueSnapshotSync(snapshot);
    }, 300);

    return () => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, [queueSnapshotSync, snapshot]);

  const handleInspectorFieldFocus = useCallback(() => {
    isInspectorEditingRef.current = true;
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
  }, []);

  const handleInspectorFieldBlur = useCallback(() => {
    isInspectorEditingRef.current = false;
    void flushProjectGraphSync();
  }, [flushProjectGraphSync]);

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
      setFileFeedback(null);
    }
  }, [isSettingsOpen]);

  useEffect(() => {
    if (!isProjectLibraryOpen) {
      return;
    }

    setFileFeedback(null);
    void loadStoredProjects();
  }, [isProjectLibraryOpen, loadStoredProjects]);

  useEffect(() => {
    const handlePointerMove = (event: MouseEvent) => {
      if (!isResizingLeftPanelRef.current) {
        return;
      }

      const nextWidth = clampLeftPanelWidth(window.innerWidth - event.clientX - 24);
      setLeftPanelWidth(nextWidth);
    };

    const handlePointerUp = () => {
      isResizingLeftPanelRef.current = false;
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

  const findEdgeIdIntersectingNode = useCallback((event: MouseEvent | ReactMouseEvent, nodeId: string) => {
    const nodeElement = getNodeElementFromDragEvent(event, nodeId);
    if (!nodeElement) {
      return null;
    }

    return findEdgeIdIntersectingRect(nodeElement.getBoundingClientRect());
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

      const childNodes: PlannerNodeRecord[] = [
        {
          id: uid('task'),
          kind: 'task',
          title: node.title,
          status: node.status,
          position: { x: 80, y: 120 },
          description: node.description,
          completionCriteria: node.completionCriteria,
          tags: [...(node.tags ?? [])],
          parentId: node.id,
        },
      ];

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
        detail: `Created a breakdown group containing a child task named ${node.title}.`,
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

  const createNewProject = useCallback(async () => {
    const shouldReplace = window.confirm('Create a new blank project and replace the current project?');
    if (!shouldReplace) {
      return;
    }

    try {
      const nextProjectId = createProjectId();
      const response = await createProjectGraph({
        projectId: nextProjectId,
        project: blankSnapshot(),
      });
      applyServerProjectGraph(response.projectId, response.project as PlannerSnapshot);
      setSessionJournal([]);
      setOpenTabs([mainTab]);
      setActiveTabId('main');
      setSelectedNodeId(null);
      setSelectedNodeIds([]);
      setToolbarNodeId(null);
      setSelectedEdgeId(null);
      setFileFeedback('Started a new blank project.');
    } catch (error) {
      setGraphSyncError(error instanceof Error ? error.message : 'Could not create a new project.');
    }
  }, [applyServerProjectGraph]);

  const openStoredProject = useCallback(
    async (nextProjectId: string) => {
      const shouldReplace = window.confirm('Load this saved project from the database and replace the current workspace?');
      if (!shouldReplace) {
        return;
      }

      setLoadingStoredProjectId(nextProjectId);
      setStoredProjectsError(null);

      try {
        await flushProjectGraphSync();
        const response = await fetchProjectGraph(nextProjectId);
        applyServerProjectGraph(response.projectId, response.project as PlannerSnapshot);
        setSessionJournal([]);
        setOpenTabs([mainTab]);
        setActiveTabId('main');
        setSelectedNodeId(null);
        setSelectedNodeIds([]);
        setToolbarNodeId(null);
        setSelectedEdgeId(null);
        setFileFeedback(`Loaded ${sanitizeSnapshot(response.project as PlannerSnapshot).root.title} from the database.`);
        setIsProjectLibraryOpen(false);
      } catch (error) {
        setStoredProjectsError(error instanceof Error ? error.message : 'Could not load the selected project.');
      } finally {
        setLoadingStoredProjectId(null);
      }
    },
    [applyServerProjectGraph, flushProjectGraphSync],
  );

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
      if (!selectedEdgeId || (event.key !== 'Backspace' && event.key !== 'Delete')) {
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
  }, [selectedEdgeId, deleteSelectedEdge]);

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
      return snapshot.nodes.find((node) => node.id === tab.id)?.title ?? 'Group';
    },
    [snapshot.nodes, snapshot.root.title],
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

  const applyLoadedProject = useCallback(
    async (projectFile: ProjectFileV1) => {
      const normalized = sanitizeProjectFile(projectFile);
      await flushProjectGraphSync();
      const response = await applyProjectGraphOperations(projectId, [
        {
          type: 'replace_graph',
          project: normalized.project,
        },
      ]);
      applyServerProjectGraph(response.projectId, response.project as PlannerSnapshot);
      setSessionJournal([]);
      setOpenTabs(normalized.ui.openTabs);
      setActiveTabId(normalized.ui.activeTabId);
      setSelectedNodeId(normalized.ui.selectedNodeId);
      setSelectedNodeIds(normalized.ui.selectedNodeId ? [normalized.ui.selectedNodeId] : []);
      setToolbarNodeId(null);
      setSelectedEdgeId(null);
      setFileFeedback('Project loaded from file.');
    },
    [applyServerProjectGraph, flushProjectGraphSync, projectId],
  );

  const handleLoadFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      try {
        const content = await file.text();
        const parsed = JSON.parse(content) as ImportableProjectFile;
        const normalized = normalizeImportedProjectFile(parsed);

        const shouldReplace = window.confirm('Load this project file and replace the current project?');
        if (!shouldReplace) {
          event.target.value = '';
          return;
        }

        await applyLoadedProject(normalized);
      } catch {
        setFileFeedback('Could not load that file. Please choose a valid project export or planner snapshot JSON file.');
      } finally {
        event.target.value = '';
      }
    },
    [applyLoadedProject],
  );

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
                <ToolbarIcon name="search" />
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
            <div className={['topbar__tab', activeTabId === 'main' ? 'is-active' : ''].join(' ')}>
              <button
                type="button"
                className="topbar__tab-button"
                onClick={() => setActiveTabId('main')}
                aria-current={activeTabId === 'main' ? 'page' : undefined}
              >
                Echo
              </button>
            </div>
          </nav>

          <div className="topbar__actions">
            <button type="button" className="primary-action" onClick={() => addTask()} disabled={isProjectGraphLoading}>
              New Node
            </button>
            <button type="button" className="secondary" onClick={() => void createNewProject()} disabled={isProjectGraphLoading}>
              New Project
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setIsProjectLibraryOpen(true)}
              disabled={isProjectGraphLoading}
              aria-label="Load project from database"
              title="Load project from database"
            >
              Load
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => fileInputRef.current?.click()}
              disabled={isProjectGraphLoading}
              aria-label="Import project file"
              title="Import project file"
            >
              Import
            </button>
            <button type="button" className="secondary" onClick={saveProject} disabled={isProjectGraphLoading}>
              Export
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
            {isProjectGraphLoading || graphSyncError || fileFeedback ? (
              <p className={['feedback floating-feedback', graphSyncError ? 'feedback--error' : ''].join(' ')}>
                {isProjectGraphLoading ? 'Loading workflow...' : graphSyncError ?? fileFeedback}
              </p>
            ) : null}

            <div className="floating-left-column">
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

            </div>

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
                        <ToolbarIcon name="device_hub" />
                      </button>
                      <button
                        type="button"
                        className="multi-selection-actions__button is-delete nodrag nopan"
                        onClick={() => deleteItems(multiSelectedNodeIds)}
                        aria-label="Delete selection"
                        title="Delete selection"
                      >
                        <ToolbarIcon name="close" />
                      </button>
                    </div>
                  ) : null}
                  <div className="canvas-shell__nav">
                    <button
                      type="button"
                      className="canvas-glass-button"
                      onClick={() => void fitView({ duration: 350, padding: 0.18 })}
                    >
                      Fit View
                    </button>
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
                  </div>
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
                      setInsertionEdgeId(findEdgeIdIntersectingNode(event, node.id) ?? findEdgeIdAtPoint(event.clientX, event.clientY));
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
                      const hoveredEdgeId = findEdgeIdIntersectingNode(event, node.id) ?? findEdgeIdAtPoint(event.clientX, event.clientY);
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
                </ReactFlow>
            </main>

            <aside className="floating-ai-panel floating-ai-panel--dock" aria-label="AI assistant">
              <AiPanel
                projectId={projectId}
                activeTabId={activeTabId}
                selectedNodeIds={selectedNodeIds}
                visibleNodeIds={scopeNodes.map((node) => node.id)}
                openaiApiKey={openaiApiKey}
                supermemoryApiKey={supermemoryApiKey}
                notionApiKey={notionApiKey}
                notionParentId={notionParentId}
                taskGraphMcpUrl={taskGraphMcpUrl}
                supermemoryMcpUrl={supermemoryMcpUrl}
                notionMcpUrl={notionMcpUrl}
                disabled={isProjectGraphLoading}
                onApplied={(project) => applyServerProjectGraph(projectIdRef.current, project as PlannerSnapshot)}
              />
            </aside>

              <aside className="floating-properties-panel floating-properties-panel--resizable" style={{ width: leftPanelWidth }}>
                  <button
                    type="button"
                    className="panel-resizer panel-resizer--left"
                    onMouseDown={() => {
                      isResizingLeftPanelRef.current = true;
                      document.body.classList.add('is-panel-resizing');
                    }}
                    aria-label="Resize node information panel"
                  />
                  <div className="glass-panel glass-panel--stack">
                    {panelMode === 'root' ? (
                      <>
                        <label className="glass-field">
                          Title
                          <input
                            value={snapshot.root.title}
                            onChange={(event) => setRootField('title', event.target.value)}
                            onFocus={handleInspectorFieldFocus}
                            onBlur={handleInspectorFieldBlur}
                          />
                        </label>
                        <label className="glass-field">
                          Description
                          <textarea
                            rows={5}
                            value={snapshot.root.description}
                            onChange={(event) => setRootField('description', event.target.value)}
                            onFocus={handleInspectorFieldFocus}
                            onBlur={handleInspectorFieldBlur}
                          />
                        </label>
                      </>
                    ) : panelItem ? (
                      <>
                        <label className="glass-field">
                          Title
                          <input
                            ref={titleInputRef}
                            value={panelItem.title}
                            onChange={(event) => setNodeTitle(panelItem.id, event.target.value)}
                            onFocus={handleInspectorFieldFocus}
                            onBlur={handleInspectorFieldBlur}
                          />
                        </label>
                        <label className="glass-field">
                          Description
                          <textarea
                            rows={5}
                            value={panelItem.description}
                            onChange={(event) => setNodeField(panelItem.id, 'description', event.target.value)}
                            onFocus={handleInspectorFieldFocus}
                            onBlur={handleInspectorFieldBlur}
                          />
                        </label>
                      </>
                    ) : (
                      <div className="glass-card">
                        <p className="muted">Select an item in the active tab to edit its title and description.</p>
                      </div>
                    )}
                  </div>
                </aside>
          </section>
        </div>
      </div>

      {isProjectLibraryOpen ? (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Load project">
          <button
            type="button"
            className="settings-overlay__scrim"
            onClick={() => setIsProjectLibraryOpen(false)}
            aria-label="Close project library"
          />
          <div className="settings-overlay__panel project-library-overlay__panel">
            <div className="project-library-overlay">
              <div className="panel-header">
                <h2>Load Project</h2>
                <button
                  type="button"
                  className="icon-button secondary"
                  onClick={() => setIsProjectLibraryOpen(false)}
                  aria-label="Close project library"
                >
                  <ToolbarIcon name="close" />
                </button>
              </div>

              <p className="muted">
                Choose a workflow stored in PostgreSQL. Use <strong>Import</strong> if you want to replace the current workflow from a JSON file instead.
              </p>

              {storedProjectsError ? <p className="feedback feedback--error">{storedProjectsError}</p> : null}

              {isStoredProjectsLoading ? (
                <p className="feedback">Loading saved projects...</p>
              ) : storedProjects.length > 0 ? (
                <div className="project-library-list">
                  {storedProjects.map((storedProject) => (
                    <button
                      key={storedProject.projectId}
                      type="button"
                      className={['project-library-card', storedProject.projectId === projectId ? 'is-current' : ''].join(' ')}
                      onClick={() => void openStoredProject(storedProject.projectId)}
                      disabled={loadingStoredProjectId !== null}
                    >
                      <div className="project-library-card__header">
                        <div>
                          <h3>{storedProject.title || 'Untitled project'}</h3>
                          <p className="muted">{storedProject.projectId}</p>
                        </div>
                        <span className="status-pill">{storedProject.projectId === projectId ? 'Current' : 'Stored'}</span>
                      </div>
                      <p className="muted">{storedProject.description.trim() || 'No description saved for this project yet.'}</p>
                      <div className="project-library-card__meta">
                        <span>{storedProject.nodeCount} nodes</span>
                        <span>{storedProject.edgeCount} edges</span>
                        <span>v{storedProject.graphVersion}</span>
                      </div>
                      <div className="project-library-card__footer">
                        <span>{loadingStoredProjectId === storedProject.projectId ? 'Loading...' : 'Load project'}</span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="glass-card">
                  <h3>No stored projects yet</h3>
                  <p className="muted">Create a project or import one from file, and it will appear here once it has been persisted.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {isSettingsOpen ? (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
          <button type="button" className="settings-overlay__scrim" onClick={() => setIsSettingsOpen(false)} aria-label="Close settings" />
          <div className="settings-overlay__panel">
            <div className="panel settings-panel settings-panel--overlay">
              <div className="panel-header">
                <h2>Settings</h2>
                <button type="button" className="icon-button secondary" onClick={() => setIsSettingsOpen(false)} aria-label="Close settings">
                  <ToolbarIcon name="close" />
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
                  <h2>AI Model</h2>
                  <span className={['status-pill', openaiApiKey.trim() ? 'is-online' : 'is-offline'].join(' ')}>
                    {openaiApiKey.trim() ? 'configured' : 'not set'}
                  </span>
                </div>
                <label className="glass-field">
                  OpenAI API Key
                  <input
                    type="password"
                    value={openaiApiKey}
                    placeholder="sk-..."
                    onChange={(event) => setOpenaiApiKey(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <p className="muted">Stored in this browser only and sent with AI requests so the assistant can use your OpenAI key without a server restart.</p>
              </div>

              <div className="settings-section">
                <div className="panel-header">
                  <h2>AI Memory</h2>
                  <span className={['status-pill', supermemoryApiKey.trim() ? 'is-online' : 'is-offline'].join(' ')}>
                    {supermemoryApiKey.trim() ? 'configured' : 'not set'}
                  </span>
                </div>
                <label className="glass-field">
                  Supermemory API Key
                  <input
                    type="password"
                    value={supermemoryApiKey}
                    placeholder="sm_..."
                    onChange={(event) => setSupermemoryApiKey(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <p className="muted">Stored in this browser only and sent with AI chat and proposal apply requests.</p>
              </div>

              <div className="settings-section">
                <div className="panel-header">
                  <h2>Knowledge Sources</h2>
                  <span className={['status-pill', notionApiKey.trim() ? 'is-online' : 'is-offline'].join(' ')}>
                    {notionApiKey.trim() ? 'configured' : 'not set'}
                  </span>
                </div>
                <label className="glass-field">
                  Notion API Key
                  <input
                    type="password"
                    value={notionApiKey}
                    placeholder="secret_..."
                    onChange={(event) => setNotionApiKey(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label className="glass-field">
                  Notion Parent Page / Database ID
                  <input
                    value={notionParentId}
                    placeholder="page-or-database-id"
                    onChange={(event) => setNotionParentId(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <p className="muted">Stored in this browser only and sent with retrieval or writeback requests when you trigger them from the UI.</p>
              </div>

              <div className="settings-section">
                <div className="panel-header">
                  <h2>MCP Endpoints</h2>
                  <span className="status-pill is-online">UI configured</span>
                </div>
                <label className="glass-field">
                  Task Graph MCP URL
                  <input value={taskGraphMcpUrl} onChange={(event) => setTaskGraphMcpUrl(event.target.value)} spellCheck={false} />
                </label>
                <label className="glass-field">
                  Supermemory MCP URL
                  <input value={supermemoryMcpUrl} onChange={(event) => setSupermemoryMcpUrl(event.target.value)} spellCheck={false} />
                </label>
                <label className="glass-field">
                  Notion MCP URL
                  <input value={notionMcpUrl} onChange={(event) => setNotionMcpUrl(event.target.value)} spellCheck={false} />
                </label>
                <p className="muted">These endpoints stay in browser storage so the UI can route each request to the MCP services you want to use.</p>
              </div>

              <div className="settings-section">
                <div className="panel-header">
                  <h2>Project Memory Scope</h2>
                  <span className="status-pill">{snapshot.root.memoryScope?.retrievalDefaults.searchMode ?? 'hybrid'}</span>
                </div>
                <label className="glass-field">
                  Container Tags
                  <input
                    value={(snapshot.root.memoryScope?.containerTags ?? []).join(', ')}
                    onChange={(event) =>
                      setSnapshot((current) => ({
                        ...current,
                        root: {
                          ...current.root,
                          memoryScope: {
                            ...(current.root.memoryScope ?? { containerTags: [], metadataDefaults: {}, retrievalDefaults: { limit: 6, searchMode: 'hybrid' } }),
                            containerTags: event.target.value
                              .split(',')
                              .map((tag) => tag.trim())
                              .filter(Boolean),
                          },
                        },
                      }))
                    }
                  />
                </label>
                <label className="glass-field">
                  Metadata Defaults
                  <textarea
                    rows={3}
                    value={JSON.stringify(snapshot.root.memoryScope?.metadataDefaults ?? {}, null, 2)}
                    onChange={(event) => {
                      try {
                        const nextValue = JSON.parse(event.target.value) as Record<string, string>;
                        setSnapshot((current) => ({
                          ...current,
                          root: {
                            ...current.root,
                            memoryScope: {
                              ...(current.root.memoryScope ?? { containerTags: [], metadataDefaults: {}, retrievalDefaults: { limit: 6, searchMode: 'hybrid' } }),
                              metadataDefaults: Object.fromEntries(Object.entries(nextValue).map(([key, value]) => [key, String(value)])),
                            },
                          },
                        }));
                      } catch {
                        // Ignore invalid JSON while typing.
                      }
                    }}
                  />
                </label>
                <label className="glass-field">
                  Retrieval Limit
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={snapshot.root.memoryScope?.retrievalDefaults.limit ?? 6}
                    onChange={(event) =>
                      setSnapshot((current) => ({
                        ...current,
                        root: {
                          ...current.root,
                          memoryScope: {
                            ...(current.root.memoryScope ?? { containerTags: [], metadataDefaults: {}, retrievalDefaults: { limit: 6, searchMode: 'hybrid' } }),
                            retrievalDefaults: {
                              ...(current.root.memoryScope?.retrievalDefaults ?? { limit: 6, searchMode: 'hybrid' }),
                              limit: Number(event.target.value) || 6,
                            },
                          },
                        },
                      }))
                    }
                  />
                </label>
              </div>

              <div className="settings-section">
                <div className="panel-header">
                  <h2>Persistence</h2>
                  <span className={['status-pill', backendStatus === 'online' ? 'is-online' : backendStatus === 'offline' ? 'is-offline' : ''].join(' ')}>
                    {backendStatus}
                  </span>
                </div>
                <p className="muted">Workflow state is stored through the backend graph API and PostgreSQL. AI chat proposals are now routed through the dedicated AI service and still apply back through graph operations.</p>
                <p className="muted">Current project ID: {projectId}</p>
                <p className="muted">Stored project library: {storedProjects.length > 0 ? `${storedProjects.length} known projects` : 'open the Load dialog to refresh'}</p>
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
