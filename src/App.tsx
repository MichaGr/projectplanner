import { CSSProperties, ChangeEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  Connection,
  NodeChange,
  PanOnScrollMode,
  SelectionMode,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  applyProjectGraphOperations,
  AvailableTaskItem,
  AvailableTaskScope,
  checkWorkflowService,
  completeAvailableTask,
  createWorkspace,
  createProjectGraph,
  deleteProject,
  deleteWorkspace,
  fetchAvailableTasks,
  fetchAuthSession,
  fetchProjectGraph,
  listWorkspaces,
  logoutSession,
  reorderProjects,
  reorderWorkspaces,
  updateProject,
  updateWorkspace,
  WorkspaceSummary,
} from './api';
import type { ApplyProjectOperationsRequest } from './api';
import {
  Check,
  Menu,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Settings,
  X,
} from 'lucide-react';
import type {
  BackendStatus,
  EditableNodeDateField,
  EditableNodeField,
  EditableRootField,
  GraphTransaction,
  ImportableProjectFile,
  InteractiveDraft,
  InteractiveDraftMap,
  NodeDropTarget,
  NodeJournalState,
  PlannerFlowNode,
  PlannerNodeRecord,
  PlannerSnapshot,
  ProjectFileV1,
  RecoveryBundle,
  ScopeId,
  SessionJournalEntry,
  TabDescriptor,
  TaskScopePreference,
  TaskStatus,
  ThemeMode,
  TransientNotification,
} from './features/planner/model/types';
import {
  createPlannerGraphIndex,
  getDescendantNodeIds,
  getGroupPath,
  wouldCreateCycle,
} from './features/planner/model/graph-index';
import {
  extractNodeSubtree,
  insertNodeSubtreeIntoSnapshot,
  moveNodeWithinSnapshot,
  removeNodeSubtreeFromSnapshot,
} from './features/planner/model/nodeMove';
import { ParticleGridBackground } from './features/planner/canvas/ParticleGridBackground';
import { flowEdgeTypes, flowNodeTypes } from './features/planner/canvas/FlowElements';
import { useDebouncedLocalStorage } from './hooks/useDebouncedLocalStorage';
import { useStableCallback } from './hooks/useStableCallback';
import {
  buildGraphOperations,
  createInteractiveDraft,
  getDraftTargetKey,
  hasSnapshotChanges,
  overlayInteractiveDrafts,
} from './features/planner/state/graphTransactions';
import { usePlannerSnapshot } from './features/planner/state/usePlannerSnapshot';
import { ToolbarIcon } from './components/ToolbarIcon';
import { TagTree } from './features/planner/components/TagTree';
import { buildTagTree, matchesTagQuery } from './features/planner/model/tags';
import { WorkspaceProjectNavigation } from './features/navigation/WorkspaceProjectNavigation';
import {
  buildDragPreviewPath,
  buildFlowEdges,
  buildFlowNodes,
  findEdgeIdIntersectingRect,
  getEdgeIdFromDomElement,
  getFlowNodeDimensions,
  getNodeElementFromDragEvent,
  getRelativeChildPosition,
  groupSize,
} from './features/planner/canvas/flow-model';
import {
  blankSnapshot,
  fileNameFromTitle,
  formatCreatedAt,
  getNodeScope,
  getStoredProjectId,
  getStoredSnapshot,
  getStoredWorkspaceId,
  isSameScope,
  normalizeDateOnly,
  normalizeImportedProjectFile,
  normalizeTag,
  sanitizeProjectFile,
  sanitizeSnapshot,
  serializeProjectFile,
  serializeSnapshot,
  serializeStoredState,
  slugify,
  uid,
} from './features/planner/model/project';

const STORAGE_KEY = 'project-planner-state-v2';
const THEME_STORAGE_KEY = 'project-planner-theme-v1';
const RIGHT_PANEL_WIDTH_STORAGE_KEY = 'project-planner-right-panel-width-v2';
const PANEL_PREFERENCES_STORAGE_KEY = 'project-planner-panels-v1';
const TASK_SCOPE_STORAGE_KEY = 'project-planner-task-scope-v1';
const RECOVERY_BUNDLE_STORAGE_KEY = 'project-planner-recovery-v1';
const mainTab: TabDescriptor = { id: 'main', kind: 'main' };
const FLOW_SNAP_GRID: [number, number] = [18, 18];
const FLOW_PRO_OPTIONS = { hideAttribution: true } as const;
const sortAvailableTasks = (tasks: AvailableTaskItem[]) =>
  [...tasks].sort((left, right) => {
    const leftKey = [
      left.workspaceName.toLowerCase(),
      left.projectTitle.toLowerCase(),
      left.title.toLowerCase(),
      left.taskId,
    ];
    const rightKey = [
      right.workspaceName.toLowerCase(),
      right.projectTitle.toLowerCase(),
      right.title.toLowerCase(),
      right.taskId,
    ];
    return leftKey.join('\u0000').localeCompare(rightKey.join('\u0000'));
  });
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

const reorderList = <T,>(items: T[], getId: (item: T) => string, orderedIds: string[]) => {
  const byId = new Map(items.map((item) => [getId(item), item] as const));
  return orderedIds.map((id) => byId.get(id)).filter((item): item is T => Boolean(item));
};

type NodeContextMenuState = {
  nodeId: string;
  kind: PlannerNodeRecord['kind'];
  x: number;
  y: number;
};

type LoadedMoveProject = {
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectTitle: string;
  graphVersion: number;
  snapshot: PlannerSnapshot;
};

type MoveDestinationOption = {
  key: string;
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectTitle: string;
  groupId: string | null;
  label: string;
  helper: string;
  depth: number;
  disabled: boolean;
};

const getStoredTheme = (): ThemeMode => {
  return 'dark';
};

const clampLeftPanelWidth = (value: number) => Math.min(420, Math.max(220, value));
const clampRightPanelWidth = (value: number) => Math.min(480, Math.max(260, value));
const normalizeTagList = (tags: string[]) =>
  Array.from(new Set(tags.map(normalizeTag).filter(Boolean))).sort((left, right) => left.localeCompare(right));

const getStoredPanelPreferences = () => {
  if (typeof window === 'undefined') {
    return { leftWidth: 260, rightWidth: 300, leftVisible: true, rightVisible: true };
  }

  const preferences = window.localStorage.getItem(PANEL_PREFERENCES_STORAGE_KEY);
  if (preferences) {
    try {
      const parsed = JSON.parse(preferences) as Partial<{
        leftWidth: number;
        rightWidth: number;
        leftVisible: boolean;
        rightVisible: boolean;
      }>;
      return {
        leftWidth: clampLeftPanelWidth(typeof parsed.leftWidth === 'number' ? parsed.leftWidth : 260),
        rightWidth: clampRightPanelWidth(typeof parsed.rightWidth === 'number' ? parsed.rightWidth : 300),
        leftVisible: parsed.leftVisible !== false,
        rightVisible: parsed.rightVisible !== false,
      };
    } catch {
      // Fall through to the legacy right-panel preference.
    }
  }
  const raw = window.localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return {
    leftWidth: 260,
    rightWidth: Number.isFinite(parsed) ? clampRightPanelWidth(parsed) : 300,
    leftVisible: true,
    rightVisible: true,
  };
};

const getStoredTaskScope = (): TaskScopePreference => {
  if (typeof window === 'undefined') {
    return { mode: 'project' };
  }
  const raw = window.localStorage.getItem(TASK_SCOPE_STORAGE_KEY);
  if (!raw) return { mode: 'project' };
  try {
    const parsed = JSON.parse(raw) as Partial<TaskScopePreference>;
    const mode: AvailableTaskScope =
      parsed.mode === 'all' || parsed.mode === 'workspace' || parsed.mode === 'project' ? parsed.mode : 'project';
    return { mode };
  } catch {
    return { mode: 'project' };
  }
};

const readRecoveryBundle = (): RecoveryBundle | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const raw = window.localStorage.getItem(RECOVERY_BUNDLE_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as RecoveryBundle;
  } catch {
    return null;
  }
};

const writeRecoveryBundle = (bundle: RecoveryBundle | null) => {
  if (typeof window === 'undefined') {
    return;
  }
  if (!bundle) {
    window.localStorage.removeItem(RECOVERY_BUNDLE_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(RECOVERY_BUNDLE_STORAGE_KEY, JSON.stringify(bundle));
};

function PlannerApp() {
  const { screenToFlowPosition, setCenter, getZoom, getViewport } = useReactFlow();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const canvasShellRef = useRef<HTMLElement | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string>(() => getStoredWorkspaceId());
  const [projectId, setProjectId] = useState<string>(() => getStoredProjectId());
  const [snapshot, setSnapshot] = usePlannerSnapshot(getStoredSnapshot);
  const [approvedSnapshot, setApprovedSnapshot] = usePlannerSnapshot(getStoredSnapshot);
  const [approvedGraphVersion, setApprovedGraphVersion] = useState(0);
  const [themeMode] = useState<ThemeMode>(() => getStoredTheme());
  const [openTabs, setOpenTabs] = useState<TabDescriptor[]>([mainTab]);
  const [activeTabId, setActiveTabId] = useState<string>('main');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [notification, setNotification] = useState<TransientNotification | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [shouldFocusSelectedTitle, setShouldFocusSelectedTitle] = useState(false);
  const [insertionEdgeId, setInsertionEdgeId] = useState<string | null>(null);
  const [pendingCenteredNodeId, setPendingCenteredNodeId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isWorkspaceMenuOpen, setIsWorkspaceMenuOpen] = useState(false);
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
  const [isLeftDrawerOpen, setIsLeftDrawerOpen] = useState(false);
  const [isRightDrawerOpen, setIsRightDrawerOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [isWorkspaceTreeLoading, setIsWorkspaceTreeLoading] = useState(false);
  const [workspaceTreeError, setWorkspaceTreeError] = useState<string | null>(null);
  const [loadingStoredProjectId, setLoadingStoredProjectId] = useState<string | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>('checking');
  const [authenticatedUsername, setAuthenticatedUsername] = useState<string | null>(null);
  const [, setSessionJournal] = useState<SessionJournalEntry[]>([]);
  const [panelPreferences, setPanelPreferences] = useState(() => getStoredPanelPreferences());
  const [taskScope, setTaskScope] = useState<TaskScopePreference>(() => getStoredTaskScope());
  const [remoteAvailableTasks, setRemoteAvailableTasks] = useState<AvailableTaskItem[]>([]);
  const [isAvailableTasksLoading, setIsAvailableTasksLoading] = useState(false);
  const [availableTasksError, setAvailableTasksError] = useState<string | null>(null);
  const [availableTasksRefreshKey, setAvailableTasksRefreshKey] = useState(0);
  const [completingTaskKey, setCompletingTaskKey] = useState<string | null>(null);
  const [workspaceTags, setWorkspaceTags] = useState<string[]>([]);
  const [isNodeTagModalOpen, setIsNodeTagModalOpen] = useState(false);
  const [nodeTagModalQuery, setNodeTagModalQuery] = useState('');
  const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenuState | null>(null);
  const [moveDialogNodeId, setMoveDialogNodeId] = useState<string | null>(null);
  const [loadedMoveProjects, setLoadedMoveProjects] = useState<LoadedMoveProject[]>([]);
  const [isMoveDialogLoading, setIsMoveDialogLoading] = useState(false);
  const [isMoveDialogSubmitting, setIsMoveDialogSubmitting] = useState(false);
  const [moveDialogError, setMoveDialogError] = useState<string | null>(null);
  const [dragDropTarget, setDragDropTarget] = useState<NodeDropTarget>(null);
  const [dragPreviewNodeId, setDragPreviewNodeId] = useState<string | null>(null);
  const [isCanvasPointerDown, setIsCanvasPointerDown] = useState(false);
  const [isProjectGraphLoading, setIsProjectGraphLoading] = useState(true);
  const [graphSyncError, setGraphSyncError] = useState<string | null>(null);
  const [pendingTransactions, setPendingTransactions] = useState<GraphTransaction[]>([]);
  const [interactiveDrafts, setInteractiveDrafts] = useState<InteractiveDraftMap>({});
  const [pendingRecoveryBundle, setPendingRecoveryBundle] = useState<RecoveryBundle | null>(null);
  const resizingPanelRef = useRef<'left' | 'right' | null>(null);
  const notificationIdRef = useRef(0);
  const availableTasksRequestRef = useRef(0);
  const canvasNodesRef = useRef<PlannerFlowNode[]>([]);
  const multiSelectionActionsRef = useRef<HTMLDivElement | null>(null);
  const flowViewportRef = useRef({ x: 0, y: 0, zoom: 1 });
  const snapshotRef = useRef(snapshot);
  const approvedSnapshotRef = useRef(approvedSnapshot);
  const approvedGraphVersionRef = useRef(approvedGraphVersion);
  const pendingTransactionsRef = useRef(pendingTransactions);
  const interactiveDraftsRef = useRef(interactiveDrafts);
  const workspaceIdRef = useRef(workspaceId);
  const projectIdRef = useRef(projectId);
  const isApplyingServerSnapshotRef = useRef(false);
  const hasHydratedProjectRef = useRef(false);
  const syncTimerRef = useRef<number | null>(null);
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const activeDraftKeyRef = useRef<string | null>(null);
  const activeScopeId: ScopeId = activeTabId === 'main' ? null : activeTabId;

  const showNotification = useCallback((message: string, tone: TransientNotification['tone'] = 'info') => {
    notificationIdRef.current += 1;
    setNotification({ id: notificationIdRef.current, message, tone });
  }, []);

  const appendSessionJournal = useCallback((entry: SessionJournalEntry | SessionJournalEntry[]) => {
    const nextEntries = Array.isArray(entry) ? entry : [entry];
    setSessionJournal((current) => nextEntries.reduce(mergeSessionJournalEntry, current));
  }, []);

  const closeNodeContextMenu = useCallback(() => {
    setNodeContextMenu(null);
  }, []);

  const closeMoveDialog = useCallback(() => {
    setMoveDialogNodeId(null);
    setLoadedMoveProjects([]);
    setIsMoveDialogLoading(false);
    setIsMoveDialogSubmitting(false);
    setMoveDialogError(null);
  }, []);

  const displaySnapshot = useMemo(
    () => overlayInteractiveDrafts(snapshot, interactiveDrafts),
    [interactiveDrafts, snapshot],
  );
  const hasPendingApprovals =
    pendingTransactions.length > 0 ||
    hasSnapshotChanges(approvedSnapshot, displaySnapshot) ||
    Object.values(interactiveDrafts).some((draft) => draft.dirty);

  const plannerGraph = useMemo(
    () => createPlannerGraphIndex(displaySnapshot.nodes, displaySnapshot.edges),
    [displaySnapshot.nodes, displaySnapshot.edges],
  );
  const scopeNodes = useMemo(() => [...plannerGraph.getScopeNodes(activeScopeId)], [plannerGraph, activeScopeId]);
  const scopeEdges = useMemo(() => [...plannerGraph.getScopeEdges(activeScopeId)], [plannerGraph, activeScopeId]);
  const [canvasNodes, setCanvasNodes] = useState<PlannerFlowNode[]>([]);

  const fitCurrentGraph = useCallback((duration = 300) => {
    const canvas = canvasShellRef.current;
    const nodes = canvasNodesRef.current;
    if (!canvas || nodes.length === 0) return;

    const rects = nodes.map((node) => ({ ...node.position, ...getFlowNodeDimensions(node) }));
    const minX = Math.min(...rects.map((rect) => rect.x));
    const minY = Math.min(...rects.map((rect) => rect.y));
    const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
    const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
    const graphWidth = Math.max(1, maxX - minX);
    const graphHeight = Math.max(1, maxY - minY);
    const availableWidth = Math.max(1, canvas.clientWidth - 64);
    const availableHeight = Math.max(1, canvas.clientHeight - 96);
    const zoom = Math.max(0.2, Math.min(1, availableWidth / graphWidth, availableHeight / graphHeight));

    void setCenter(minX + graphWidth / 2, minY + graphHeight / 2, { zoom, duration });
  }, [setCenter]);

  const storedProjectState = useMemo(
    () => serializeStoredState(workspaceId, projectId, snapshot, openTabs, activeTabId, selectedNodeId),
    [workspaceId, projectId, snapshot, openTabs, activeTabId, selectedNodeId],
  );
  useDebouncedLocalStorage(STORAGE_KEY, storedProjectState);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    window.localStorage.setItem(PANEL_PREFERENCES_STORAGE_KEY, JSON.stringify(panelPreferences));
  }, [panelPreferences]);

  useEffect(() => {
    window.localStorage.setItem(TASK_SCOPE_STORAGE_KEY, JSON.stringify(taskScope));
  }, [taskScope]);

  useEffect(() => {
    if (!notification) return;
    const notificationId = notification.id;
    const timer = window.setTimeout(() => {
      setNotification((current) => (current?.id === notificationId ? null : current));
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [notification]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    approvedSnapshotRef.current = approvedSnapshot;
  }, [approvedSnapshot]);

  useEffect(() => {
    approvedGraphVersionRef.current = approvedGraphVersion;
  }, [approvedGraphVersion]);

  useEffect(() => {
    pendingTransactionsRef.current = pendingTransactions;
  }, [pendingTransactions]);

  useEffect(() => {
    interactiveDraftsRef.current = interactiveDrafts;
  }, [interactiveDrafts]);

  useEffect(() => {
    workspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  useEffect(() => {
    const activeWorkspace = workspaces.find((workspace) => workspace.workspaceId === workspaceId) ?? null;
    setWorkspaceTags(activeWorkspace?.tags ?? []);
  }, [workspaceId, workspaces]);

  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  const applyServerProjectGraph = useCallback((
    nextWorkspaceId: string,
    nextProjectId: string,
    nextSnapshot: PlannerSnapshot,
    nextGraphVersion: number,
  ) => {
    const normalizedSnapshot = sanitizeSnapshot(nextSnapshot);
    isApplyingServerSnapshotRef.current = true;
    approvedSnapshotRef.current = normalizedSnapshot;
    snapshotRef.current = normalizedSnapshot;
    approvedGraphVersionRef.current = nextGraphVersion;
    pendingTransactionsRef.current = [];
    setWorkspaceId(nextWorkspaceId);
    setProjectId(nextProjectId);
    setApprovedSnapshot(normalizedSnapshot);
    setSnapshot(normalizedSnapshot);
    setApprovedGraphVersion(nextGraphVersion);
    setPendingTransactions([]);
    setGraphSyncError(null);
  }, [setApprovedSnapshot]);

  const loadWorkspaceTree = useCallback(async () => {
    setIsWorkspaceTreeLoading(true);
    setWorkspaceTreeError(null);

    try {
      const nextWorkspaces = await listWorkspaces();
      setWorkspaces(nextWorkspaces);
      return nextWorkspaces;
    } catch (error) {
      setWorkspaceTreeError(error instanceof Error ? error.message : 'Could not load workspaces.');
      throw error;
    } finally {
      setIsWorkspaceTreeLoading(false);
    }
  }, []);

  const mergeWorkspaceSummary = useCallback((summary: WorkspaceSummary) => {
    setWorkspaces((current) => {
      let found = false;
      const next = current.map((workspace) => {
        if (workspace.workspaceId !== summary.workspaceId) {
          return workspace;
        }
        found = true;
        return summary;
      });
      return found ? next : [summary, ...next];
    });
  }, []);

  const persistSnapshotToServer = useCallback(
    async (nextSnapshot?: PlannerSnapshot) => {
      if (!workspaceIdRef.current || !projectIdRef.current) {
        return;
      }
      const snapshotToPersist = sanitizeSnapshot(
        nextSnapshot ?? overlayInteractiveDrafts(snapshotRef.current, interactiveDraftsRef.current),
      );
      const approved = approvedSnapshotRef.current;
      if (!hasSnapshotChanges(approved, snapshotToPersist)) {
        setPendingTransactions([]);
        return;
      }

      const payload: ApplyProjectOperationsRequest = {
        transactionId: pendingTransactionsRef.current[pendingTransactionsRef.current.length - 1]?.id ?? uid('transaction'),
        baseGraphVersion: approvedGraphVersionRef.current,
        operations: buildGraphOperations(approved, snapshotToPersist),
      };
      const response = await applyProjectGraphOperations(workspaceIdRef.current, projectIdRef.current, payload);
      if (response.status === 'accepted') {
        applyServerProjectGraph(
          response.workspaceId,
          response.projectId,
          response.project as PlannerSnapshot,
          response.graphVersion,
        );
        setInteractiveDrafts((current) => {
          const nextDrafts: InteractiveDraftMap = {};
          const approvedResponseSnapshot = sanitizeSnapshot(response.project as PlannerSnapshot);
          for (const [key, draft] of Object.entries(current)) {
            if (draft.targetType === 'root') {
              nextDrafts[key] = {
                ...draft,
                dirty: false,
                needsRevalidation: false,
                removedByRollback: false,
              };
              continue;
            }
            if (!approvedResponseSnapshot.nodes.some((node) => node.id === draft.targetId)) {
              continue;
            }
            nextDrafts[key] = {
              ...draft,
              dirty: false,
              needsRevalidation: false,
              removedByRollback: false,
            };
          }
          return nextDrafts;
        });
        setPendingTransactions([]);
        return;
      }

      const serverSnapshot = sanitizeSnapshot(response.project as PlannerSnapshot);
      approvedSnapshotRef.current = serverSnapshot;
      snapshotRef.current = serverSnapshot;
      approvedGraphVersionRef.current = response.graphVersion;
      pendingTransactionsRef.current = [];
      setApprovedSnapshot(serverSnapshot);
      setApprovedGraphVersion(response.graphVersion);
      setSnapshot(serverSnapshot);
      setPendingTransactions([]);
      setInteractiveDrafts((current) => {
        const nextDrafts: InteractiveDraftMap = {};
        for (const [key, draft] of Object.entries(current)) {
          if (draft.targetType === 'root') {
            nextDrafts[key] = { ...draft, needsRevalidation: true };
            continue;
          }
          const exists = serverSnapshot.nodes.some((node) => node.id === draft.targetId);
          if (exists) {
            nextDrafts[key] = { ...draft, needsRevalidation: true };
          } else {
            nextDrafts[key] = { ...draft, removedByRollback: true, needsRevalidation: false, dirty: false };
          }
        }
        return nextDrafts;
      });
      setGraphSyncError(response.message);
      showNotification(response.message, 'error');
    },
    [applyServerProjectGraph, setApprovedSnapshot, showNotification],
  );

  const runProjectGraphSync = useCallback(() => {
    if (syncPromiseRef.current) {
      return syncPromiseRef.current;
    }
    const pending = persistSnapshotToServer(
      overlayInteractiveDrafts(snapshotRef.current, interactiveDraftsRef.current),
    ).finally(() => {
      syncPromiseRef.current = null;
    });
    syncPromiseRef.current = pending;
    return pending;
  }, [persistSnapshotToServer]);

  const flushProjectGraphSync = useCallback(async () => {
    const drafts = interactiveDraftsRef.current;
    if (Object.keys(drafts).length > 0) {
      let nextSnapshot = snapshotRef.current;
      for (const draft of Object.values(drafts)) {
        if (draft.removedByRollback) {
          continue;
        }
        if (draft.targetType === 'root') {
          nextSnapshot = {
            ...nextSnapshot,
            root: {
              ...nextSnapshot.root,
              ...draft.fields,
            },
          };
          continue;
        }
        nextSnapshot = {
          ...nextSnapshot,
          nodes: nextSnapshot.nodes.map((node) =>
            node.id === draft.targetId
              ? {
                  ...node,
                  ...draft.fields,
                }
              : node,
          ),
        };
      }
      const normalizedSnapshot = sanitizeSnapshot(nextSnapshot);
      snapshotRef.current = normalizedSnapshot;
      setSnapshot(normalizedSnapshot);
      interactiveDraftsRef.current = {};
      setInteractiveDrafts({});
    }
    if (
      !workspaceIdRef.current ||
      !projectIdRef.current ||
      !hasHydratedProjectRef.current ||
      !hasSnapshotChanges(approvedSnapshotRef.current, snapshotRef.current)
    ) {
      return;
    }
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    await runProjectGraphSync();
  }, [runProjectGraphSync]);

  const initializeProjectGraph = useCallback(async () => {
    setIsProjectGraphLoading(true);
    setGraphSyncError(null);

    try {
      const session = await fetchAuthSession();
      setAuthenticatedUsername(session.username);
      await checkWorkflowService();
      setBackendStatus('online');
      const nextWorkspaces = await loadWorkspaceTree();
      const selectedWorkspace =
        nextWorkspaces.find((workspace) => workspace.workspaceId === workspaceIdRef.current) ??
        nextWorkspaces.find((workspace) => workspace.projects.some((project) => project.projectId === projectIdRef.current)) ??
        nextWorkspaces[0];

      if (!selectedWorkspace) {
        throw new Error('No workspace is available.');
      }

      const selectedProject =
        selectedWorkspace.projects.find((project) => project.projectId === projectIdRef.current) ??
        selectedWorkspace.projects[0];

      if (selectedProject) {
        const response = await fetchProjectGraph(selectedWorkspace.workspaceId, selectedProject.projectId);
        applyServerProjectGraph(
          response.workspaceId,
          response.projectId,
          response.project as PlannerSnapshot,
          response.graphVersion,
        );
      } else {
        const emptySnapshot = blankSnapshot();
        isApplyingServerSnapshotRef.current = true;
        approvedSnapshotRef.current = emptySnapshot;
        snapshotRef.current = emptySnapshot;
        approvedGraphVersionRef.current = 0;
        pendingTransactionsRef.current = [];
        setWorkspaceId(selectedWorkspace.workspaceId);
        setProjectId('');
        setApprovedSnapshot(emptySnapshot);
        setSnapshot(emptySnapshot);
        setApprovedGraphVersion(0);
        setPendingTransactions([]);
      }
    } catch (error) {
      setBackendStatus('offline');
      setGraphSyncError(error instanceof Error ? error.message : 'Could not load the workflow from the backend.');
    } finally {
      hasHydratedProjectRef.current = true;
      setIsProjectGraphLoading(false);
    }
  }, [applyServerProjectGraph, loadWorkspaceTree]);

  useEffect(() => {
    void initializeProjectGraph();
  }, [initializeProjectGraph]);

  useEffect(() => {
    if (!workspaceId || !projectId) {
      setPendingRecoveryBundle(null);
      return;
    }
    const bundle = readRecoveryBundle();
    if (bundle && bundle.workspaceId === workspaceId && bundle.projectId === projectId && bundle.savedAt) {
      setPendingRecoveryBundle(bundle);
      return;
    }
    setPendingRecoveryBundle(null);
  }, [projectId, workspaceId]);

  useEffect(() => {
    if (!hasHydratedProjectRef.current) {
      return;
    }
    if (isApplyingServerSnapshotRef.current) {
      isApplyingServerSnapshotRef.current = false;
      return;
    }

    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
    }

    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      const predictedSnapshot = overlayInteractiveDrafts(snapshotRef.current, interactiveDraftsRef.current);
      if (!hasSnapshotChanges(approvedSnapshotRef.current, predictedSnapshot)) {
        return;
      }
      void runProjectGraphSync();
    }, 4000);

    return () => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, [interactiveDrafts, snapshot, runProjectGraphSync]);

  useEffect(() => {
    if (!workspaceId || !projectId || !hasPendingApprovals) {
      writeRecoveryBundle(null);
      return;
    }
    writeRecoveryBundle({
      workspaceId,
      projectId,
      approvedSnapshot,
      approvedGraphVersion,
      predictedSnapshot: snapshot,
      pendingTransactions,
      interactiveDrafts,
      savedAt: new Date().toISOString(),
    });
  }, [approvedGraphVersion, approvedSnapshot, hasPendingApprovals, interactiveDrafts, pendingTransactions, projectId, snapshot, workspaceId]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasPendingApprovals) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasPendingApprovals]);

  const restorePendingRecovery = useCallback(() => {
    if (!pendingRecoveryBundle) {
      return;
    }
    const approved = sanitizeSnapshot(pendingRecoveryBundle.approvedSnapshot);
    const predicted = sanitizeSnapshot(pendingRecoveryBundle.predictedSnapshot);
    approvedSnapshotRef.current = approved;
    snapshotRef.current = predicted;
    approvedGraphVersionRef.current = pendingRecoveryBundle.approvedGraphVersion;
    pendingTransactionsRef.current = pendingRecoveryBundle.pendingTransactions;
    setApprovedSnapshot(approved);
    setSnapshot(predicted);
    setApprovedGraphVersion(pendingRecoveryBundle.approvedGraphVersion);
    setPendingTransactions(pendingRecoveryBundle.pendingTransactions);
    setInteractiveDrafts(pendingRecoveryBundle.interactiveDrafts);
    setPendingRecoveryBundle(null);
    showNotification('Restored pending local changes.');
  }, [pendingRecoveryBundle, setApprovedSnapshot, showNotification]);

  const handleLogout = useCallback(async () => {
    try {
      await logoutSession();
    } finally {
      window.location.assign('/login');
    }
  }, []);

  const discardPendingRecovery = useCallback(() => {
    writeRecoveryBundle(null);
    setPendingRecoveryBundle(null);
    pendingTransactionsRef.current = [];
    interactiveDraftsRef.current = {};
    setInteractiveDrafts({});
    setPendingTransactions([]);
  }, []);

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
    if (nodeContextMenu && !scopeNodes.some((node) => node.id === nodeContextMenu.nodeId)) {
      setNodeContextMenu(null);
    }
  }, [nodeContextMenu, scopeNodes]);

  useEffect(() => {
    if (selectedEdgeId && !scopeEdges.some((edge) => edge.id === selectedEdgeId)) {
      setSelectedEdgeId(null);
    }
  }, [scopeEdges, selectedEdgeId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsNodeTagModalOpen(false);
      setIsWorkspaceMenuOpen(false);
      setIsProjectMenuOpen(false);
      setIsLeftDrawerOpen(false);
      setIsRightDrawerOpen(false);
      setNodeContextMenu(null);
      setMoveDialogNodeId(null);
      setLoadedMoveProjects([]);
      setIsMoveDialogLoading(false);
      setIsMoveDialogSubmitting(false);
      setMoveDialogError(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!nodeContextMenu) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.node-context-menu')) {
        return;
      }
      setNodeContextMenu(null);
    };

    window.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
    };
  }, [nodeContextMenu]);

  useEffect(() => {
    const handlePointerMove = (event: MouseEvent) => {
      if (!resizingPanelRef.current) {
        return;
      }

      if (resizingPanelRef.current === 'left') {
        const nextWidth = clampLeftPanelWidth(event.clientX);
        setPanelPreferences((current) => ({ ...current, leftWidth: nextWidth }));
      } else {
        const nextWidth = clampRightPanelWidth(window.innerWidth - event.clientX);
        setPanelPreferences((current) => ({ ...current, rightWidth: nextWidth }));
      }
    };

    const handlePointerUp = () => {
      resizingPanelRef.current = null;
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

  const selectedNode = displaySnapshot.nodes.find((node) => node.id === selectedNodeId) ?? null;
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

    const viewport = flowViewportRef.current;
    return {
      left: viewport.x + (multiSelectionBounds.left + multiSelectionBounds.width / 2) * viewport.zoom,
      top: viewport.y + multiSelectionBounds.top * viewport.zoom,
      transform: 'translate(-50%, calc(-100% - 0.75rem))',
    };
  }, [multiSelectionBounds]);
  const positionMultiSelectionActions = useCallback(
    (viewport: { x: number; y: number; zoom: number }) => {
      flowViewportRef.current = viewport;
      const element = multiSelectionActionsRef.current;
      if (!element || !multiSelectionBounds) return;
      element.style.left = `${viewport.x + (multiSelectionBounds.left + multiSelectionBounds.width / 2) * viewport.zoom}px`;
      element.style.top = `${viewport.y + multiSelectionBounds.top * viewport.zoom}px`;
    },
    [multiSelectionBounds],
  );
  const activeScopeNode = activeScopeId ? displaySnapshot.nodes.find((node) => node.id === activeScopeId) ?? null : null;
  const panelItem = selectedNode ?? activeScopeNode ?? null;
  const panelMode: 'selected' | 'scope-group' | 'root' =
    selectedNode ? 'selected' : activeScopeNode ? 'scope-group' : 'root';
  const tagTargetNode = panelMode === 'root' ? null : panelItem;
  const panelDraft =
    panelMode === 'root'
      ? interactiveDrafts[getDraftTargetKey('root', 'root')] ?? null
      : panelItem
        ? interactiveDrafts[getDraftTargetKey('node', panelItem.id)] ?? null
        : null;
  const moveDialogNode = moveDialogNodeId ? displaySnapshot.nodes.find((node) => node.id === moveDialogNodeId) ?? null : null;
  const moveDialogDescendantIds = useMemo(
    () => (moveDialogNode ? new Set(getDescendantNodeIds(displaySnapshot.nodes, moveDialogNode.id)) : new Set<string>()),
    [displaySnapshot.nodes, moveDialogNode],
  );
  const moveProjectMap = useMemo(
    () => new Map(loadedMoveProjects.map((project) => [`${project.workspaceId}:${project.projectId}`, project] as const)),
    [loadedMoveProjects],
  );
  const moveDestinationOptions = useMemo<MoveDestinationOption[]>(() => {
    if (!moveDialogNode) {
      return [];
    }

    const options: MoveDestinationOption[] = [];
    const appendGroupOptions = (
      workspace: WorkspaceSummary,
      projectSummary: WorkspaceSummary['projects'][number],
      projectSnapshot: PlannerSnapshot,
      parentId: string | null,
      depth: number,
    ) => {
      const groups = projectSnapshot.nodes.filter((node) => node.kind === 'group' && (node.parentId ?? null) === parentId);
      for (const group of groups) {
        const sameProject = workspace.workspaceId === workspaceId && projectSummary.projectId === projectId;
        const disabled =
          (sameProject && moveDialogNode.parentId === group.id) ||
          (sameProject && (group.id === moveDialogNode.id || moveDialogDescendantIds.has(group.id)));
        options.push({
          key: `${workspace.workspaceId}:${projectSummary.projectId}:group:${group.id}`,
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.name,
          projectId: projectSummary.projectId,
          projectTitle: projectSummary.title || 'Untitled Project',
          groupId: group.id,
          label: group.title || 'Untitled group',
          helper: `${workspace.name} / ${projectSummary.title || 'Untitled Project'}`,
          depth,
          disabled,
        });
        appendGroupOptions(workspace, projectSummary, projectSnapshot, group.id, depth + 1);
      }
    };

    for (const workspace of workspaces) {
      for (const projectSummary of workspace.projects) {
        const project = moveProjectMap.get(`${workspace.workspaceId}:${projectSummary.projectId}`);
        if (!project) {
          continue;
        }
        const sameProject = workspace.workspaceId === workspaceId && projectSummary.projectId === projectId;
        options.push({
          key: `${workspace.workspaceId}:${projectSummary.projectId}:root`,
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.name,
          projectId: projectSummary.projectId,
          projectTitle: projectSummary.title || 'Untitled Project',
          groupId: null,
          label: 'Project root',
          helper: `${workspace.name} / ${projectSummary.title || 'Untitled Project'}`,
          depth: 0,
          disabled: sameProject && !moveDialogNode.parentId,
        });
        appendGroupOptions(workspace, projectSummary, project.snapshot, null, 1);
      }
    }

    return options;
  }, [loadedMoveProjects, moveDialogDescendantIds, moveDialogNode, moveProjectMap, projectId, workspaceId, workspaces]);

  useEffect(() => {
    setNodeTagModalQuery('');
    if (!tagTargetNode) {
      setIsNodeTagModalOpen(false);
    }
  }, [tagTargetNode]);

  useEffect(() => {
    if (!moveDialogNodeId) {
      return;
    }

    let cancelled = false;
    const loadProjects = async () => {
      setIsMoveDialogLoading(true);
      setMoveDialogError(null);
      try {
        const projects = await Promise.all(
          workspaces.flatMap((workspace) =>
            workspace.projects.map(async (project) => {
              if (workspace.workspaceId === workspaceId && project.projectId === projectId) {
                return {
                  workspaceId: workspace.workspaceId,
                  workspaceName: workspace.name,
                  projectId: project.projectId,
                  projectTitle: project.title || 'Untitled Project',
                  graphVersion: approvedGraphVersionRef.current,
                  snapshot: sanitizeSnapshot(displaySnapshot),
                } satisfies LoadedMoveProject;
              }

              const response = await fetchProjectGraph(workspace.workspaceId, project.projectId);
              return {
                workspaceId: workspace.workspaceId,
                workspaceName: workspace.name,
                projectId: project.projectId,
                projectTitle: project.title || 'Untitled Project',
                graphVersion: response.graphVersion,
                snapshot: sanitizeSnapshot(response.project as PlannerSnapshot),
              } satisfies LoadedMoveProject;
            }),
          ),
        );

        if (cancelled) {
          return;
        }

        setLoadedMoveProjects(projects);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setMoveDialogError(error instanceof Error ? error.message : 'Could not load move destinations.');
      } finally {
        if (!cancelled) {
          setIsMoveDialogLoading(false);
        }
      }
    };

    void loadProjects();
    return () => {
      cancelled = true;
    };
  }, [approvedGraphVersion, displaySnapshot, moveDialogNodeId, projectId, workspaceId, workspaces]);

  useEffect(() => {
    if (!shouldFocusSelectedTitle || panelMode !== 'selected' || !selectedNode) {
      return;
    }

    const input = titleInputRef.current;
    if (!input) {
      return;
    }

    input.focus();
    input.select();
    setShouldFocusSelectedTitle(false);
  }, [shouldFocusSelectedTitle, panelMode, selectedNode]);

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
    positionMultiSelectionActions(getViewport());
  }, [getViewport, canvasNodes.length, activeTabId, positionMultiSelectionActions]);

  const resolvedTaskScope = useMemo(() => {
    if (taskScope.mode === 'all') {
      return { mode: 'all' as const };
    }
    const activeWorkspace = workspaces.find((workspace) => workspace.workspaceId === workspaceId);
    if (taskScope.mode === 'workspace') {
      return activeWorkspace ? { mode: 'workspace' as const, workspaceId: activeWorkspace.workspaceId } : null;
    }
    const activeProject = activeWorkspace?.projects.find((project) => project.projectId === projectId);
    return activeWorkspace && activeProject
      ? { mode: 'project' as const, workspaceId: activeWorkspace.workspaceId, projectId: activeProject.projectId }
      : null;
  }, [projectId, taskScope.mode, workspaceId, workspaces]);

  const localProjectAvailableTasks = useMemo(() => {
    if (!workspaceId || !projectId) {
      return [];
    }
    const activeWorkspace = workspaces.find((workspace) => workspace.workspaceId === workspaceId);
    if (!activeWorkspace) {
      return [];
    }

    return sortAvailableTasks(
      displaySnapshot.nodes
        .filter((node) => node.kind === 'task' && plannerGraph.isNodeAvailable(node.id))
        .map((node) => ({
          workspaceId: activeWorkspace.workspaceId,
          workspaceName: activeWorkspace.name,
          projectId,
          projectTitle: displaySnapshot.root.title,
          taskId: node.id,
          title: node.title,
          description: node.description,
          dueDate: node.dueDate ?? null,
          doDate: node.doDate ?? null,
          tags: [...node.tags],
          scopePath: [],
        })),
    );
  }, [displaySnapshot.nodes, displaySnapshot.root.title, plannerGraph, projectId, workspaceId, workspaces]);

  const availableTasks = useMemo(() => {
    if (!resolvedTaskScope) {
      return [];
    }

    if (resolvedTaskScope.mode === 'project') {
      return localProjectAvailableTasks;
    }

    const currentProjectIsInScope =
      workspaceId &&
      projectId &&
      (resolvedTaskScope.mode === 'all' ||
        (resolvedTaskScope.mode === 'workspace' && resolvedTaskScope.workspaceId === workspaceId));

    if (!currentProjectIsInScope) {
      return remoteAvailableTasks;
    }

    return sortAvailableTasks(
      remoteAvailableTasks
        .filter((task) => !(task.workspaceId === workspaceId && task.projectId === projectId))
        .concat(localProjectAvailableTasks),
    );
  }, [localProjectAvailableTasks, projectId, remoteAvailableTasks, resolvedTaskScope, workspaceId]);

  useEffect(() => {
    const requestId = availableTasksRequestRef.current + 1;
    availableTasksRequestRef.current = requestId;
    if (!resolvedTaskScope) {
      setRemoteAvailableTasks([]);
      setAvailableTasksError(null);
      setIsAvailableTasksLoading(false);
      return;
    }

    if (resolvedTaskScope.mode === 'project') {
      setRemoteAvailableTasks([]);
      setAvailableTasksError(null);
      setIsAvailableTasksLoading(false);
      return;
    }

    setIsAvailableTasksLoading(true);
    setAvailableTasksError(null);
    void fetchAvailableTasks(resolvedTaskScope)
      .then((tasks) => {
        if (availableTasksRequestRef.current === requestId) setRemoteAvailableTasks(tasks);
      })
      .catch((error) => {
        if (availableTasksRequestRef.current !== requestId) return;
        setRemoteAvailableTasks([]);
        setAvailableTasksError(error instanceof Error ? error.message : 'Could not load available tasks.');
      })
      .finally(() => {
        if (availableTasksRequestRef.current === requestId) setIsAvailableTasksLoading(false);
      });
  }, [availableTasksRefreshKey, resolvedTaskScope]);

  const applyPredictedSnapshotChange = useCallback(
    (label: string, updater: (current: PlannerSnapshot) => PlannerSnapshot) => {
      const currentSnapshot = snapshotRef.current;
      const nextSnapshot = sanitizeSnapshot(updater(currentSnapshot));
      if (serializeSnapshot(currentSnapshot) === serializeSnapshot(nextSnapshot)) {
        return currentSnapshot;
      }
      const operations = buildGraphOperations(currentSnapshot, nextSnapshot);
      const transaction: GraphTransaction = {
        id: uid('transaction'),
        workspaceId: workspaceIdRef.current,
        projectId: projectIdRef.current,
        baseGraphVersion: approvedGraphVersionRef.current + pendingTransactionsRef.current.length,
        operations,
        createdAt: new Date().toISOString(),
        label,
      };
      snapshotRef.current = nextSnapshot;
      pendingTransactionsRef.current = [...pendingTransactionsRef.current, transaction];
      setSnapshot(nextSnapshot);
      setPendingTransactions((current) => [...current, transaction]);
      return nextSnapshot;
    },
    [],
  );

  const setDraftFieldValue = useCallback(
    (
      target: InteractiveDraft['targetType'],
      targetId: string,
      field: InteractiveDraft['activeField'],
      value: string | null,
    ) => {
      if (!field) {
        return;
      }
      const key = getDraftTargetKey(target, targetId);
      setInteractiveDrafts((current) => {
        const draft = current[key] ?? createInteractiveDraft(target, targetId, field);
        return {
          ...current,
          [key]: {
            ...draft,
            activeField: draft.activeField ?? field,
            dirty: true,
            removedByRollback: false,
            fields: {
              ...draft.fields,
              [field]: value,
            },
          },
        };
      });
    },
    [],
  );

  const beginInteractiveDraft = useCallback((target: InteractiveDraft['targetType'], targetId: string, field: InteractiveDraft['activeField']) => {
    const key = getDraftTargetKey(target, targetId);
    activeDraftKeyRef.current = key;
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    setInteractiveDrafts((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? createInteractiveDraft(target, targetId, field)),
        activeField: field,
        removedByRollback: false,
      },
    }));
  }, []);

  const commitInteractiveDraft = useCallback(
    (target: InteractiveDraft['targetType'], targetId: string) => {
      const key = getDraftTargetKey(target, targetId);
      const draft = interactiveDraftsRef.current[key];
      if (!draft) {
        return;
      }

      setInteractiveDrafts((current) => ({
        ...current,
        [key]: {
          ...draft,
          activeField: null,
        },
      }));
      activeDraftKeyRef.current = null;

      if (draft.removedByRollback) {
        return;
      }

      const currentSnapshot = snapshotRef.current;
      if (target === 'root') {
        const nextRoot = { ...currentSnapshot.root, ...draft.fields };
        if (JSON.stringify(nextRoot) !== JSON.stringify(currentSnapshot.root)) {
          applyPredictedSnapshotChange('Update project details', (current) => ({ ...current, root: nextRoot }));
        }
      } else {
        const node = currentSnapshot.nodes.find((entry) => entry.id === targetId);
        if (!node) {
          setInteractiveDrafts((current) => ({
            ...current,
            [key]: {
              ...draft,
              removedByRollback: true,
              dirty: false,
              activeField: null,
            },
          }));
          return;
        }
        const nextNode = { ...node, ...draft.fields };
        if (JSON.stringify(nextNode) !== JSON.stringify(node)) {
          applyPredictedSnapshotChange(`Update ${node.title || 'item'}`, (current) => ({
            ...current,
            nodes: current.nodes.map((entry) => (entry.id === targetId ? nextNode : entry)),
          }));
        }
      }

      setInteractiveDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [applyPredictedSnapshotChange],
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

      applyPredictedSnapshotChange('Group selected items', (current) => {
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
              createdAt: new Date().toISOString(),
              dueDate: null,
              doDate: null,
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
    [appendSessionJournal, applyPredictedSnapshotChange, snapshot],
  );

  const normalizedSearchQuery = searchQuery.trim();
  const isTagSearch = normalizedSearchQuery.startsWith('#');
  const normalizedTagSearch = normalizeTag(normalizedSearchQuery.slice(1));
  const normalizedTextSearch = normalizedSearchQuery.toLowerCase();

  const searchResults = useMemo(() => {
    if (!normalizedSearchQuery) {
      return [];
    }

    return displaySnapshot.nodes.filter((node) => {
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
  }, [displaySnapshot.nodes, normalizedSearchQuery, isTagSearch, normalizedTagSearch, normalizedTextSearch]);

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
    applyPredictedSnapshotChange('Delete dependency', (current) => ({
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
  }, [activeScopeId, appendSessionJournal, applyPredictedSnapshotChange, snapshot.edges, snapshot.nodes, snapshot]);

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

      applyPredictedSnapshotChange('Delete items', (current) => ({
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
    [appendSessionJournal, applyPredictedSnapshotChange, snapshot],
  );

  const setNodeTitle = useCallback((nodeId: string, title: string) => {
    setDraftFieldValue('node', nodeId, 'title', title);
  }, [setDraftFieldValue]);

  const setNodeField = useCallback(
    (nodeId: string, field: EditableNodeField, value: string) => {
      setDraftFieldValue('node', nodeId, field, value);
    },
    [setDraftFieldValue],
  );

  const setRootField = useCallback(
    (field: EditableRootField, value: string) => {
      setDraftFieldValue('root', 'root', field, value);
    },
    [setDraftFieldValue],
  );

  const setNodeTags = useCallback((nodeId: string, updater: (currentTags: string[]) => string[]) => {
    applyPredictedSnapshotChange('Update node tags', (current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId ? { ...node, tags: updater(node.tags).map(normalizeTag).filter(Boolean) } : node,
      ),
    }));
  }, [applyPredictedSnapshotChange]);

  const setNodeDate = useCallback((nodeId: string, field: EditableNodeDateField, value: string) => {
    setDraftFieldValue('node', nodeId, field, normalizeDateOnly(value));
  }, [setDraftFieldValue]);

  const persistWorkspaceTags = useCallback(
    async (nextTags: string[]) => {
      if (!workspaceIdRef.current) {
        return;
      }
      const normalizedTags = normalizeTagList(nextTags);
      setWorkspaceTags(normalizedTags);
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.workspaceId === workspaceIdRef.current ? { ...workspace, tags: normalizedTags } : workspace,
        ),
      );
      const updatedWorkspace = await updateWorkspace(workspaceIdRef.current, { tags: normalizedTags });
      mergeWorkspaceSummary(updatedWorkspace);
      if (workspaceIdRef.current === updatedWorkspace.workspaceId) {
        setWorkspaceTags(updatedWorkspace.tags);
      }
    },
    [mergeWorkspaceSummary],
  );

  const setTaskStatus = useCallback((nodeId: string, status: TaskStatus) => {
    const node = snapshot.nodes.find((entry) => entry.id === nodeId);
    applyPredictedSnapshotChange(`Set task status ${status}`, (current) => ({
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
  }, [appendSessionJournal, applyPredictedSnapshotChange, snapshot]);

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
      if (!projectId) return;
      const newNodeId = uid('task');
      let newNodeTitle = '';
      applyPredictedSnapshotChange('Add task', (current) => {
        const scopedNodes = current.nodes.filter((node) => getNodeScope(node) === activeScopeId);
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
          createdAt: new Date().toISOString(),
          dueDate: null,
          doDate: null,
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
    [activeScopeId, appendSessionJournal, projectId, snapshot],
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
      applyPredictedSnapshotChange('Add dependency', (current) => ({
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
    [activeScopeId, appendSessionJournal, applyPredictedSnapshotChange, snapshot],
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
    applyPredictedSnapshotChange('Split task', (current) => {
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
          createdAt: new Date().toISOString(),
          dueDate: node.dueDate ?? null,
          doDate: node.doDate ?? null,
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
  }, [appendSessionJournal, applyPredictedSnapshotChange, snapshot]);

  const handleContextMenuCreateGroup = useCallback(() => {
    if (!nodeContextMenu || nodeContextMenu.kind !== 'task') {
      return;
    }
    splitTask(nodeContextMenu.nodeId);
    closeNodeContextMenu();
  }, [closeNodeContextMenu, nodeContextMenu, splitTask]);

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

      applyPredictedSnapshotChange('Move node into group', (current) => ({
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
    [appendSessionJournal, applyPredictedSnapshotChange, snapshot],
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
        createdAt: new Date().toISOString(),
        dueDate: null,
        doDate: null,
        parentId: sharedParentId,
        size: { ...groupSize },
      };

      applyPredictedSnapshotChange('Combine nodes into group', (current) => ({
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
    [appendSessionJournal, applyPredictedSnapshotChange, snapshot],
  );

  const resetProjectUi = useCallback(() => {
    setSessionJournal([]);
    setOpenTabs([mainTab]);
    setActiveTabId('main');
    setSelectedNodeId(null);
    setSelectedNodeIds([]);
    setToolbarNodeId(null);
    setSelectedEdgeId(null);
  }, []);

  const showEmptyWorkspace = useCallback((nextWorkspaceId: string) => {
    const emptySnapshot = blankSnapshot();
    isApplyingServerSnapshotRef.current = true;
    approvedSnapshotRef.current = emptySnapshot;
    snapshotRef.current = emptySnapshot;
    approvedGraphVersionRef.current = 0;
    pendingTransactionsRef.current = [];
    interactiveDraftsRef.current = {};
    setWorkspaceId(nextWorkspaceId);
    setProjectId('');
    setApprovedSnapshot(emptySnapshot);
    setSnapshot(emptySnapshot);
    setApprovedGraphVersion(0);
    setPendingTransactions([]);
    setInteractiveDrafts({});
    resetProjectUi();
  }, [resetProjectUi, setApprovedSnapshot]);

  const createNewProject = useCallback(async () => {
    if (!workspaceId) return;
    const title = window.prompt('Project name', 'Untitled Project');
    if (title === null) return;
    try {
      await flushProjectGraphSync();
      const project = blankSnapshot();
      project.root.title = title.trim() || 'Untitled Project';
      const response = await createProjectGraph(workspaceId, { project });
      applyServerProjectGraph(response.workspaceId, response.projectId, response.project as PlannerSnapshot, response.graphVersion);
      resetProjectUi();
      await loadWorkspaceTree();
      showNotification('Started a new blank project.');
    } catch (error) {
      setGraphSyncError(error instanceof Error ? error.message : 'Could not create a new project.');
    }
  }, [applyServerProjectGraph, flushProjectGraphSync, loadWorkspaceTree, resetProjectUi, showNotification, workspaceId]);

  const openStoredProject = useCallback(
    async (nextWorkspaceId: string, nextProjectId: string) => {
      if (nextWorkspaceId === workspaceId && nextProjectId === projectId) {
        setIsWorkspaceMenuOpen(false);
        setIsProjectMenuOpen(false);
        setIsLeftDrawerOpen(false);
        return snapshotRef.current;
      }
      setLoadingStoredProjectId(nextProjectId);
      setWorkspaceTreeError(null);

      try {
        await flushProjectGraphSync();
        const response = await fetchProjectGraph(nextWorkspaceId, nextProjectId);
        const loadedSnapshot = sanitizeSnapshot(response.project as PlannerSnapshot);
        applyServerProjectGraph(response.workspaceId, response.projectId, loadedSnapshot, response.graphVersion);
        resetProjectUi();
        setIsWorkspaceMenuOpen(false);
        setIsProjectMenuOpen(false);
        setIsLeftDrawerOpen(false);
        showNotification(`Loaded ${loadedSnapshot.root.title} from the database.`);
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            fitCurrentGraph();
          });
        });
        return loadedSnapshot;
      } catch (error) {
        setWorkspaceTreeError(error instanceof Error ? error.message : 'Could not load the selected project.');
        return null;
      } finally {
        setLoadingStoredProjectId(null);
      }
    },
    [applyServerProjectGraph, fitCurrentGraph, flushProjectGraphSync, projectId, resetProjectUi, showNotification, workspaceId],
  );

  const openAvailableTask = useCallback(
    async (task: AvailableTaskItem) => {
      const loadedSnapshot = await openStoredProject(task.workspaceId, task.projectId);
      const node = loadedSnapshot?.nodes.find((entry) => entry.id === task.taskId);
      if (node) focusNodeInWorkspace(node);
      setIsLeftDrawerOpen(false);
    },
    [focusNodeInWorkspace, openStoredProject],
  );

  const markAvailableTaskComplete = useCallback(
    async (task: AvailableTaskItem) => {
      const taskKey = `${task.workspaceId}:${task.projectId}:${task.taskId}`;
      setCompletingTaskKey(taskKey);
      try {
        if (task.workspaceId === workspaceIdRef.current && task.projectId === projectIdRef.current) {
          await flushProjectGraphSync();
        }
        const completionResponse = await completeAvailableTask(task.workspaceId, task.projectId, task.taskId);
        setRemoteAvailableTasks((current) =>
          current.filter((entry) => entry.taskId !== task.taskId || entry.projectId !== task.projectId),
        );

        if (task.workspaceId === workspaceIdRef.current && task.projectId === projectIdRef.current) {
          const nextSnapshot = {
            ...snapshotRef.current,
            nodes: snapshotRef.current.nodes.map((node) =>
              node.id === task.taskId && node.kind === 'task' ? { ...node, status: 'done' as const } : node,
            ),
          };
          approvedSnapshotRef.current = nextSnapshot;
          snapshotRef.current = nextSnapshot;
          approvedGraphVersionRef.current = completionResponse.graphVersion;
          pendingTransactionsRef.current = [];
          setApprovedSnapshot(nextSnapshot);
          setApprovedGraphVersion(completionResponse.graphVersion);
          setSnapshot(nextSnapshot);
          setPendingTransactions([]);
        }
        if (resolvedTaskScope?.mode !== 'project') {
          setAvailableTasksRefreshKey((current) => current + 1);
        }
        showNotification(`Completed ${task.title}.`);
      } catch (error) {
        showNotification(error instanceof Error ? error.message : 'Could not complete the task.', 'error');
        if (resolvedTaskScope?.mode !== 'project') {
          setAvailableTasksRefreshKey((current) => current + 1);
        }
      } finally {
        setCompletingTaskKey(null);
      }
    },
    [flushProjectGraphSync, resolvedTaskScope?.mode, setSnapshot, showNotification],
  );

  const selectWorkspace = useCallback(async (nextWorkspaceId: string) => {
    const workspace = workspaces.find((entry) => entry.workspaceId === nextWorkspaceId);
    if (!workspace) return;
    setIsWorkspaceMenuOpen(false);
    const nextProject = workspace.projects[0];
    if (nextProject) {
      await openStoredProject(nextWorkspaceId, nextProject.projectId);
    } else {
      await flushProjectGraphSync();
      showEmptyWorkspace(nextWorkspaceId);
    }
  }, [flushProjectGraphSync, openStoredProject, showEmptyWorkspace, workspaces]);

  const createNewWorkspace = useCallback(async () => {
    const name = window.prompt('Workspace name', 'New Workspace');
    if (name === null || !name.trim()) return;
    try {
      await flushProjectGraphSync();
      const created = await createWorkspace({ name: name.trim() });
      mergeWorkspaceSummary(created);
      await loadWorkspaceTree();
      showEmptyWorkspace(created.workspaceId);
      setIsWorkspaceMenuOpen(false);
    } catch (error) {
      setWorkspaceTreeError(error instanceof Error ? error.message : 'Could not create the workspace.');
    }
  }, [flushProjectGraphSync, loadWorkspaceTree, mergeWorkspaceSummary, showEmptyWorkspace]);

  const renameWorkspace = useCallback(async (workspace: WorkspaceSummary) => {
    const name = window.prompt('Rename workspace', workspace.name);
    if (name === null || !name.trim() || name.trim() === workspace.name) return;
    try {
      const updatedWorkspace = await updateWorkspace(workspace.workspaceId, { name: name.trim() });
      mergeWorkspaceSummary(updatedWorkspace);
      await loadWorkspaceTree();
    } catch (error) {
      setWorkspaceTreeError(error instanceof Error ? error.message : 'Could not rename the workspace.');
    }
  }, [loadWorkspaceTree, mergeWorkspaceSummary]);

  const persistWorkspaceOrder = useCallback(async (workspaceIds: string[]) => {
    const previous = workspaces;
    setWorkspaces((current) => reorderList(current, (workspace) => workspace.workspaceId, workspaceIds));
    try {
      const reordered = await reorderWorkspaces(workspaceIds);
      setWorkspaces(reordered);
    } catch (error) {
      setWorkspaces(previous);
      setWorkspaceTreeError(error instanceof Error ? error.message : 'Could not reorder workspaces.');
      void loadWorkspaceTree();
    }
  }, [loadWorkspaceTree, workspaces]);

  const removeWorkspace = useCallback(async (workspace: WorkspaceSummary) => {
    const confirmation = window.prompt(`Type "${workspace.name}" to delete this workspace and all of its projects.`);
    if (confirmation !== workspace.name) return;
    try {
      if (workspace.workspaceId === workspaceId) await flushProjectGraphSync();
      const result = await deleteWorkspace(workspace.workspaceId);
      const nextWorkspaces = await loadWorkspaceTree();
      const replacement = nextWorkspaces.find((entry) => entry.workspaceId === result.replacementWorkspaceId) ?? nextWorkspaces[0];
      if (replacement) {
        const nextProject = replacement.projects[0];
        if (nextProject) await openStoredProject(replacement.workspaceId, nextProject.projectId);
        else showEmptyWorkspace(replacement.workspaceId);
      }
    } catch (error) {
      setWorkspaceTreeError(error instanceof Error ? error.message : 'Could not delete the workspace.');
    }
  }, [flushProjectGraphSync, loadWorkspaceTree, openStoredProject, showEmptyWorkspace, workspaceId]);

  const renameStoredProject = useCallback(async (nextWorkspaceId: string, nextProjectId: string, currentTitle: string) => {
    const title = window.prompt('Rename project', currentTitle);
    if (title === null || !title.trim() || title.trim() === currentTitle) return;
    try {
      if (nextProjectId === projectId) await flushProjectGraphSync();
      const response = await updateProject(nextWorkspaceId, nextProjectId, { title: title.trim() });
      if (nextProjectId === projectId) {
        applyServerProjectGraph(response.workspaceId, response.projectId, response.project as PlannerSnapshot, response.graphVersion);
      }
      await loadWorkspaceTree();
    } catch (error) {
      setWorkspaceTreeError(error instanceof Error ? error.message : 'Could not rename the project.');
    }
  }, [applyServerProjectGraph, flushProjectGraphSync, loadWorkspaceTree, projectId]);

  const persistProjectOrder = useCallback(async (nextWorkspaceId: string, projectIds: string[]) => {
    const previous = workspaces;
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.workspaceId === nextWorkspaceId
          ? { ...workspace, projects: reorderList(workspace.projects, (project) => project.projectId, projectIds) }
          : workspace,
      ),
    );
    try {
      const reordered = await reorderProjects(nextWorkspaceId, projectIds);
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.workspaceId === nextWorkspaceId ? { ...workspace, projects: reordered } : workspace,
        ),
      );
    } catch (error) {
      setWorkspaces(previous);
      setWorkspaceTreeError(error instanceof Error ? error.message : 'Could not reorder projects.');
      void loadWorkspaceTree();
    }
  }, [loadWorkspaceTree, workspaces]);

  const removeStoredProject = useCallback(async (nextWorkspaceId: string, nextProjectId: string, title: string) => {
    if (!window.confirm(`Delete project "${title}"? This removes all of its nodes and edges.`)) return;
    try {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      await deleteProject(nextWorkspaceId, nextProjectId);
      const nextWorkspaces = await loadWorkspaceTree();
      if (nextProjectId === projectId) {
        const workspace = nextWorkspaces.find((entry) => entry.workspaceId === nextWorkspaceId);
        const nextProject = workspace?.projects[0];
        if (nextProject) await openStoredProject(nextWorkspaceId, nextProject.projectId);
        else showEmptyWorkspace(nextWorkspaceId);
      }
    } catch (error) {
      setWorkspaceTreeError(error instanceof Error ? error.message : 'Could not delete the project.');
    }
  }, [loadWorkspaceTree, openStoredProject, projectId, showEmptyWorkspace]);

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
  const handleContextMenuDelete = useCallback(() => {
    if (!nodeContextMenu) {
      return;
    }
    deleteItems([nodeContextMenu.nodeId]);
    closeNodeContextMenu();
  }, [closeNodeContextMenu, deleteItems, nodeContextMenu]);

  const handleContextMenuMove = useCallback(() => {
    if (!nodeContextMenu) {
      return;
    }
    setMoveDialogNodeId(nodeContextMenu.nodeId);
    closeNodeContextMenu();
  }, [closeNodeContextMenu, nodeContextMenu]);

  const moveNodeToDestination = useCallback(
    async (destination: MoveDestinationOption) => {
      if (!moveDialogNode) {
        return;
      }

      const sourceLabel = formatScopeTitle(displaySnapshot, moveDialogNode.parentId);
      const destinationLabel =
        destination.groupId === null
          ? `${destination.projectTitle} / Project root`
          : `${destination.projectTitle} / ${destination.label}`;

      if (destination.workspaceId === workspaceId && destination.projectId === projectId) {
        applyPredictedSnapshotChange('Move node', (current) =>
          moveNodeWithinSnapshot(current, moveDialogNode.id, destination.groupId),
        );
        appendSessionJournal({
          type: 'update_node',
          entityKey: `node:${moveDialogNode.id}`,
          initialNodeState: nodeJournalStateFromNode(moveDialogNode, sourceLabel),
          finalNodeState: nodeJournalStateFromNode(
            { ...moveDialogNode, parentId: destination.groupId ?? undefined },
            destination.groupId ? formatScopeTitle(displaySnapshot, destination.groupId) : destination.projectTitle,
          ),
          nodeAction: 'updated',
          title: `Moved ${moveDialogNode.title} to ${destinationLabel}`,
          detail: `Moved ${moveDialogNode.kind} from ${sourceLabel} to ${destinationLabel}.`,
          scopeTitle: destination.groupId ? formatScopeTitle(displaySnapshot, destination.groupId) : destination.projectTitle,
        });
        closeMoveDialog();
        return;
      }

      setIsMoveDialogSubmitting(true);
      setMoveDialogError(null);
      try {
        await flushProjectGraphSync();
        const sourceSnapshot = sanitizeSnapshot(snapshotRef.current);
        const freshNode = sourceSnapshot.nodes.find((node) => node.id === moveDialogNode.id);
        const subtree = extractNodeSubtree(sourceSnapshot, moveDialogNode.id);
        if (!freshNode || !subtree || !workspaceIdRef.current || !projectIdRef.current) {
          throw new Error('Could not prepare the selected node for moving.');
        }

        const destinationProject = await fetchProjectGraph(destination.workspaceId, destination.projectId);
        const destinationSnapshot = sanitizeSnapshot(destinationProject.project as PlannerSnapshot);
        const inserted = insertNodeSubtreeIntoSnapshot(destinationSnapshot, subtree, destination.groupId);
        const destinationPayload: ApplyProjectOperationsRequest = {
          transactionId: uid('transaction'),
          baseGraphVersion: destinationProject.graphVersion,
          operations: buildGraphOperations(destinationSnapshot, inserted.snapshot),
        };
        const destinationResult = await applyProjectGraphOperations(
          destination.workspaceId,
          destination.projectId,
          destinationPayload,
        );
        if (destinationResult.status !== 'accepted') {
          throw new Error(destinationResult.message);
        }

        const sourceNextSnapshot = removeNodeSubtreeFromSnapshot(sourceSnapshot, moveDialogNode.id);
        const sourcePayload: ApplyProjectOperationsRequest = {
          transactionId: uid('transaction'),
          baseGraphVersion: approvedGraphVersionRef.current,
          operations: buildGraphOperations(sourceSnapshot, sourceNextSnapshot),
        };
        const sourceResult = await applyProjectGraphOperations(
          workspaceIdRef.current,
          projectIdRef.current,
          sourcePayload,
        );

        if (sourceResult.status !== 'accepted') {
          const refreshedSource = await fetchProjectGraph(workspaceIdRef.current, projectIdRef.current);
          applyServerProjectGraph(
            refreshedSource.workspaceId,
            refreshedSource.projectId,
            refreshedSource.project as PlannerSnapshot,
            refreshedSource.graphVersion,
          );
          await loadWorkspaceTree();
          throw new Error(sourceResult.message);
        }

        applyServerProjectGraph(
          sourceResult.workspaceId,
          sourceResult.projectId,
          sourceResult.project as PlannerSnapshot,
          sourceResult.graphVersion,
        );
        appendSessionJournal({
          type: 'update_node',
          entityKey: `node:${freshNode.id}`,
          initialNodeState: nodeJournalStateFromNode(freshNode, sourceLabel),
          finalNodeState: nodeJournalStateFromNode(
            { ...freshNode, parentId: undefined },
            `${destination.workspaceName} / ${destinationLabel}`,
          ),
          nodeAction: 'updated',
          title: `Moved ${freshNode.title} to ${destinationLabel}`,
          detail: `Moved ${freshNode.kind} from ${sourceLabel} to ${destination.workspaceName} / ${destinationLabel}.`,
          scopeTitle: `${destination.workspaceName} / ${destinationLabel}`,
        });
        setOpenTabs((current) => current.filter((tab) => tab.kind === 'main' || !subtree.nodeIds.has(tab.id)));
        setActiveTabId((current) => (subtree.nodeIds.has(current) ? 'main' : current));
        setSelectedNodeId((current) => (current && subtree.nodeIds.has(current) ? null : current));
        setSelectedNodeIds((current) => current.filter((nodeId) => !subtree.nodeIds.has(nodeId)));
        setToolbarNodeId((current) => (current && subtree.nodeIds.has(current) ? null : current));
        setSelectedEdgeId(null);
        await loadWorkspaceTree();
        showNotification(`Moved ${freshNode.title} to ${destination.workspaceName} / ${destinationLabel}.`);
        closeMoveDialog();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not move the selected node.';
        setMoveDialogError(message);
        showNotification(message, 'error');
      } finally {
        setIsMoveDialogSubmitting(false);
      }
    },
    [
      appendSessionJournal,
      applyPredictedSnapshotChange,
      applyServerProjectGraph,
      closeMoveDialog,
      displaySnapshot,
      flushProjectGraphSync,
      loadWorkspaceTree,
      moveDialogNode,
      projectId,
      showNotification,
      workspaceId,
    ],
  );
  const flowToggleTaskStatus = useStableCallback(toggleTaskStatus);
  const flowSplitTask = useStableCallback(splitTask);
  const flowOpenNodeGroup = useStableCallback(openNodeGroup);
  const flowDeleteItem = useStableCallback(deleteItem);

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
      plannerGraph,
      scopeNodes,
      selectedNodeId,
      selectedNodeIds,
      toolbarNodeId,
      dragDropTarget?.nodeId ?? null,
      flowToggleTaskStatus,
      flowSplitTask,
      flowOpenNodeGroup,
      flowDeleteItem,
      canvasNodesRef.current,
    );
    if (
      nextCanvasNodes.length === canvasNodesRef.current.length &&
      nextCanvasNodes.every((node, index) => node === canvasNodesRef.current[index])
    ) {
      return;
    }
    canvasNodesRef.current = nextCanvasNodes;
    setCanvasNodes(nextCanvasNodes);
  }, [plannerGraph, scopeNodes, selectedNodeId, selectedNodeIds, toolbarNodeId, dragDropTarget, flowToggleTaskStatus, flowSplitTask, flowOpenNodeGroup, flowDeleteItem]);

  const insertNodeIntoEdge = useCallback((edgeId: string, nodeId: string) => {
    const edge = snapshot.edges.find((entry) => entry.id === edgeId);
    const node = snapshot.nodes.find((entry) => entry.id === nodeId);
    applyPredictedSnapshotChange('Insert node into dependency', (current) => {
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
  }, [appendSessionJournal, applyPredictedSnapshotChange, snapshot]);

  const panelTags = panelMode === 'root' ? snapshot.root.tags : panelItem?.tags ?? [];
  const knownTags = useMemo(() => normalizeTagList(workspaceTags), [workspaceTags]);

  const togglePanelTag = useCallback(
    (tag: string) => {
      if (!panelItem) {
        return;
      }
      const normalizedTag = normalizeTag(tag);
      if (!normalizedTag) {
        return;
      }

      setNodeTags(panelItem.id, (currentTags) =>
        currentTags.includes(normalizedTag)
          ? currentTags.filter((entry) => entry !== normalizedTag)
          : [...currentTags, normalizedTag].sort((left, right) => left.localeCompare(right)),
      );
    },
    [panelItem, setNodeTags],
  );

  const normalizedNodeTagModalQuery = normalizeTag(nodeTagModalQuery);
  const visibleWorkspaceTags = useMemo(
    () => knownTags.filter((tag) => matchesTagQuery(tag, normalizedNodeTagModalQuery)),
    [knownTags, normalizedNodeTagModalQuery],
  );
  const visibleWorkspaceTagTree = useMemo(() => buildTagTree(visibleWorkspaceTags), [visibleWorkspaceTags]);
  const canCreateWorkspaceTag =
    Boolean(normalizedNodeTagModalQuery) &&
    !knownTags.includes(normalizedNodeTagModalQuery);

  const toggleNodeTagFromModal = useCallback(
    async (tag: string) => {
      if (!tagTargetNode) {
        return;
      }
      const normalizedTag = normalizeTag(tag);
      if (!normalizedTag) {
        return;
      }

      if (!knownTags.includes(normalizedTag)) {
        try {
          await persistWorkspaceTags([...knownTags, normalizedTag]);
        } catch (error) {
          showNotification(error instanceof Error ? error.message : 'Could not update workspace tags.', 'error');
          return;
        }
      }

      setNodeTags(tagTargetNode.id, (currentTags) =>
        currentTags.includes(normalizedTag)
          ? currentTags.filter((entry) => entry !== normalizedTag)
          : [...currentTags, normalizedTag].sort((left, right) => left.localeCompare(right)),
      );
    },
    [knownTags, persistWorkspaceTags, setNodeTags, showNotification, tagTargetNode],
  );

  const createWorkspaceTagFromModal = useCallback(async () => {
    if (!tagTargetNode || !normalizedNodeTagModalQuery) {
      return;
    }
    try {
      await persistWorkspaceTags([...knownTags, normalizedNodeTagModalQuery]);
      setNodeTags(tagTargetNode.id, (currentTags) =>
        currentTags.includes(normalizedNodeTagModalQuery)
          ? currentTags
          : [...currentTags, normalizedNodeTagModalQuery].sort((left, right) => left.localeCompare(right)),
      );
      setNodeTagModalQuery('');
    } catch (error) {
      showNotification(error instanceof Error ? error.message : 'Could not create the tag.', 'error');
    }
  }, [knownTags, normalizedNodeTagModalQuery, persistWorkspaceTags, setNodeTags, showNotification, tagTargetNode]);

  const saveProject = useCallback(() => {
    const file = serializeProjectFile(projectId, displaySnapshot, openTabs, activeTabId, selectedNodeId);
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileNameFromTitle(displaySnapshot.root.title);
    anchor.click();
    URL.revokeObjectURL(url);
  }, [projectId, displaySnapshot, openTabs, activeTabId, selectedNodeId]);

  const importProject = useCallback(() => fileInputRef.current?.click(), []);

  const applyLoadedProject = useCallback(
    async (projectFile: ProjectFileV1) => {
      if (!workspaceId) throw new Error('Create or select a workspace before importing a project.');
      const normalized = sanitizeProjectFile(projectFile);
      await flushProjectGraphSync();
      const response = await createProjectGraph(workspaceId, { project: normalized.project });
      applyServerProjectGraph(response.workspaceId, response.projectId, response.project as PlannerSnapshot, response.graphVersion);
      setSessionJournal([]);
      setOpenTabs(normalized.ui.openTabs);
      setActiveTabId(normalized.ui.activeTabId);
      setSelectedNodeId(normalized.ui.selectedNodeId);
      setSelectedNodeIds(normalized.ui.selectedNodeId ? [normalized.ui.selectedNodeId] : []);
      setToolbarNodeId(null);
      setSelectedEdgeId(null);
      await loadWorkspaceTree();
      showNotification('Imported a new project from file.');
    },
    [applyServerProjectGraph, flushProjectGraphSync, loadWorkspaceTree, showNotification, workspaceId],
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
        showNotification('Could not load that file. Please choose a valid project export or planner snapshot JSON file.', 'error');
      } finally {
        event.target.value = '';
      }
    },
    [applyLoadedProject, showNotification],
  );

  const breadcrumbs =
    activeTabId === 'main'
      ? [{ id: 'main', label: displaySnapshot.root.title }]
      : [
          { id: 'main', label: displaySnapshot.root.title },
          ...getGroupPath(displaySnapshot.nodes, activeTabId).map((node) => ({
            id: node.id,
            label: node.title,
          })),
        ];

  const activeWorkspace = workspaces.find((workspace) => workspace.workspaceId === workspaceId) ?? null;

  return (
    <>
      <div
        className="app-frame"
        style={
          {
            '--navigation-width': `${panelPreferences.leftWidth}px`,
            '--navigation-column': panelPreferences.leftVisible ? `${panelPreferences.leftWidth}px` : '0px',
            '--properties-width': `${panelPreferences.rightWidth}px`,
            '--properties-column': panelPreferences.rightVisible ? `${panelPreferences.rightWidth}px` : '0px',
          } as CSSProperties
        }
      >
        <aside
          className={[
            'editor-sidebar',
            isLeftDrawerOpen ? 'is-open' : '',
            !panelPreferences.leftVisible ? 'is-desktop-hidden' : '',
          ].join(' ')}
          aria-label="Project navigation"
        >
          <div
            className="panel-resizer editor-sidebar__resizer"
            role="separator"
            aria-label="Resize project navigation"
            aria-orientation="vertical"
            aria-valuemin={220}
            aria-valuemax={420}
            aria-valuenow={panelPreferences.leftWidth}
            tabIndex={0}
            onMouseDown={() => {
              resizingPanelRef.current = 'left';
              document.body.classList.add('is-panel-resizing');
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const delta = event.key === 'ArrowLeft' ? -10 : 10;
              setPanelPreferences((current) => ({
                ...current,
                leftWidth: clampLeftPanelWidth(current.leftWidth + delta),
              }));
            }}
          />
          {/*<div className="editor-sidebar__primary">
            <button
              type="button"
              className="new-node-button"
              onClick={() => addTask()}
              disabled={isProjectGraphLoading || !projectId}
            >
              <Plus aria-hidden="true" />
              New Node
            </button>
          </div>*/}

          <WorkspaceProjectNavigation
            workspaces={workspaces}
            workspaceId={workspaceId}
            projectId={projectId}
            isWorkspaceMenuOpen={isWorkspaceMenuOpen}
            setIsWorkspaceMenuOpen={setIsWorkspaceMenuOpen}
            isProjectMenuOpen={isProjectMenuOpen}
            setIsProjectMenuOpen={setIsProjectMenuOpen}
            isWorkspaceTreeLoading={isWorkspaceTreeLoading}
            workspaceTreeError={workspaceTreeError}
            loadingStoredProjectId={loadingStoredProjectId}
            isProjectGraphLoading={isProjectGraphLoading}
            onSelectWorkspace={selectWorkspace}
            onCreateWorkspace={createNewWorkspace}
            onRenameWorkspace={renameWorkspace}
            onRemoveWorkspace={removeWorkspace}
            onReorderWorkspaces={persistWorkspaceOrder}
            onOpenProject={openStoredProject}
            onCreateProject={createNewProject}
            onRenameProject={renameStoredProject}
            onRemoveProject={removeStoredProject}
            onReorderProjects={persistProjectOrder}
            onImportProject={importProject}
            onExportProject={saveProject}
          />

          <div className="topbar__search-stack sidebar-search">
            <label className="topbar__search" aria-label="Search nodes">
              <span className="topbar__search-icon" aria-hidden="true">
                <ToolbarIcon name="search" />
              </span>
              <input
                value={searchQuery}
                placeholder="Search nodes or use #Tag.Path"
                onChange={(event) => setSearchQuery(event.target.value)}
                disabled={!projectId}
              />
            </label>

            {normalizedSearchQuery ? (
              <div className="search-overlay" role="listbox" aria-label="Search results">
                <div className="search-overlay__header">
                  <span>{isTagSearch ? 'Tag Search' : 'Project Search'}</span>
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
                          setIsWorkspaceMenuOpen(false);
                          setIsProjectMenuOpen(false);
                          setIsLeftDrawerOpen(false);
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

          <div className="sidebar-section available-tasks-section">
            <div className="task-scope-controls">
              <label>
                <span>Task source</span>
                <select
                  value={taskScope.mode}
                  onChange={(event) => setTaskScope({ mode: event.target.value as AvailableTaskScope })}
                >
                  <option value="all">All workspaces</option>
                  <option value="workspace">Current workspace</option>
                  <option value="project">Current project</option>
                </select>
              </label>
            </div>
            <div className="sidebar-section__header">
              <span className="sidebar-section__label">Available Tasks</span>
              <span className="sidebar-section__count">{availableTasks.length}</span>
            </div>
            <div className="available-task-list">
              {isAvailableTasksLoading ? (
                <p className="sidebar-empty">Loading available tasks...</p>
              ) : availableTasksError ? (
                <p className="sidebar-empty is-error">{availableTasksError}</p>
              ) : resolvedTaskScope && availableTasks.length === 0 ? (
                <p className="sidebar-empty">No tasks are currently available.</p>
              ) : !resolvedTaskScope ? (
                <p className="sidebar-empty">Select a workspace or project to see available tasks.</p>
              ) : (
                availableTasks.map((task) => (
                  <div key={`${task.workspaceId}:${task.projectId}:${task.taskId}`} className="available-task-row">
                    <button
                      type="button"
                      className="available-task-row__focus"
                      onClick={() => void openAvailableTask(task)}
                    >
                      <span>{task.title}</span>
                      {taskScope.mode !== 'project' ? (
                        <small>
                          {taskScope.mode === 'all' ? `${task.workspaceName} / ` : ''}{task.projectTitle}
                        </small>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="available-task-row__check"
                      onClick={() => void markAvailableTaskComplete(task)}
                      disabled={completingTaskKey === `${task.workspaceId}:${task.projectId}:${task.taskId}`}
                      aria-label={`Mark ${task.title} complete`}
                      title="Mark complete"
                    >
                      <Check aria-hidden="true" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="editor-sidebar__footer">
            {authenticatedUsername ? (
              <button
                type="button"
                className="sidebar-settings-button"
                onClick={() => void handleLogout()}
                aria-label="Log out"
              >
                <LogOut aria-hidden="true" />
                Log out {authenticatedUsername}
              </button>
            ) : null}
            <button
              type="button"
              className="sidebar-settings-button"
              onClick={() => setIsSettingsOpen(true)}
              aria-label="Open settings"
            >
              <Settings aria-hidden="true" />
              Settings
            </button>
          </div>

        </aside>

        {isLeftDrawerOpen || isRightDrawerOpen ? (
          <button
            type="button"
            className="editor-drawer-scrim"
            onClick={() => {
              setIsWorkspaceMenuOpen(false);
              setIsProjectMenuOpen(false);
              setIsLeftDrawerOpen(false);
              setIsRightDrawerOpen(false);
            }}
            aria-label="Close editor panel"
          />
        ) : null}

        <div className="app-shell app-shell--floating">
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="application/json,.json"
            onChange={handleLoadFile}
          />

          <section className="workspace workspace--floating">
            <div className="mobile-editor-controls" aria-label="Editor panels">
              <button
                type="button"
                onClick={() => {
                  setIsLeftDrawerOpen(true);
                  setIsRightDrawerOpen(false);
                }}
                aria-label="Open project navigation"
                aria-expanded={isLeftDrawerOpen}
              >
                <Menu aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsRightDrawerOpen(true);
                  setIsLeftDrawerOpen(false);
                }}
                aria-label="Open inspector"
                aria-expanded={isRightDrawerOpen}
              >
                <PanelRight aria-hidden="true" />
              </button>
            </div>

            <main
                ref={canvasShellRef}
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
                <div className="desktop-panel-controls" aria-label="Editor panels">
                  <button
                    type="button"
                    onClick={() => setPanelPreferences((current) => ({ ...current, leftVisible: !current.leftVisible }))}
                    aria-label={panelPreferences.leftVisible ? 'Hide project navigation' : 'Show project navigation'}
                    aria-expanded={panelPreferences.leftVisible}
                    title={panelPreferences.leftVisible ? 'Hide project navigation' : 'Show project navigation'}
                  >
                    {panelPreferences.leftVisible ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPanelPreferences((current) => ({ ...current, rightVisible: !current.rightVisible }))}
                    aria-label={panelPreferences.rightVisible ? 'Hide inspector' : 'Show inspector'}
                    aria-expanded={panelPreferences.rightVisible}
                    title={panelPreferences.rightVisible ? 'Hide inspector' : 'Show inspector'}
                  >
                    {panelPreferences.rightVisible ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
                  </button>
                </div>
                <div className="canvas-status-region" aria-live="polite" aria-atomic="true">
                  {isProjectGraphLoading ? <p className="feedback floating-feedback">Loading workflow...</p> : null}
                  {hasPendingApprovals && !isProjectGraphLoading ? <p className="feedback floating-feedback">Local changes pending backend approval.</p> : null}
                  {graphSyncError ? <p className="feedback feedback--error floating-feedback">{graphSyncError}</p> : null}
                  {notification ? (
                    <p
                      className={['feedback floating-feedback', notification.tone === 'error' ? 'feedback--error' : ''].join(' ')}
                      role={notification.tone === 'error' ? 'alert' : 'status'}
                    >
                      {notification.message}
                    </p>
                  ) : null}
                </div>
                <ParticleGridBackground />
                <div className="canvas-shell__overlay">
                  {multiSelectionButtonStyle && !isCanvasPointerDown ? (
                    <div ref={multiSelectionActionsRef} className="multi-selection-actions" style={multiSelectionButtonStyle}>
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
                      onClick={() => fitCurrentGraph(350)}
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
                  {!projectId && !isProjectGraphLoading ? (
                    <div className="empty-project-state">
                      <h2>{activeWorkspace?.name ?? 'Workspace'}</h2>
                      <p>This workspace has no projects.</p>
                      <button type="button" className="primary-action" onClick={() => void createNewProject()}>
                        <Plus aria-hidden="true" />
                        New Project
                      </button>
                    </div>
                  ) : null}
                </div>
                <ReactFlow
                  nodes={canvasNodes}
                  edges={flowEdges}
                  nodeTypes={flowNodeTypes}
                  edgeTypes={flowEdgeTypes}
                  fitView
                  snapToGrid
                  snapGrid={FLOW_SNAP_GRID}
                  panOnScroll
                  panOnScrollMode={PanOnScrollMode.Free}
                  panOnDrag={[1, 2]}
                  selectionOnDrag
                  selectionMode={SelectionMode.Partial}
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
                    setNodeContextMenu(null);
                  }}
                  onNodeContextMenu={(event, node) => {
                    event.preventDefault();
                    setSelectedNodeId(node.id);
                    setSelectedNodeIds([node.id]);
                    setSelectedEdgeId(null);
                    setToolbarNodeId(null);
                    setNodeContextMenu({
                      nodeId: node.id,
                      kind: node.data.kind,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  onNodeDoubleClick={(_, node) => {
                    const plannerNode = snapshot.nodes.find((entry) => entry.id === node.id);
                    if (plannerNode?.kind === 'group') {
                      openGroupTab(plannerNode.id);
                      setSelectedNodeId(plannerNode.id);
                      setSelectedNodeIds([plannerNode.id]);
                      setToolbarNodeId(null);
                      setNodeContextMenu(null);
                    }
                  }}
                  onEdgeClick={(_, edge) => {
                    setSelectedEdgeId(edge.id);
                    setSelectedNodeId(null);
                    setSelectedNodeIds([]);
                    setToolbarNodeId(null);
                    setNodeContextMenu(null);
                  }}
                  onNodesChange={handleNodesChange}
                  onNodesDelete={(nodes) => deleteItems(nodes.map((node) => node.id))}
                  onNodeDrag={(event, node) => {
                    setToolbarNodeId(null);
                    setNodeContextMenu(null);
                    const nextDropTarget = resolveNodeDropTarget(node.id, node.position);
                    setDragDropTarget(nextDropTarget);
                    setDragPreviewNodeId(node.id);
                    if (nextDropTarget || !(event instanceof MouseEvent)) {
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
                    applyPredictedSnapshotChange('Move node', (current) => ({
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
                      const hoveredEdgeId =
                        event instanceof MouseEvent
                          ? findEdgeIdIntersectingNode(event, node.id) ??
                            findEdgeIdAtPoint(event.clientX, event.clientY)
                          : null;
                      if (hoveredEdgeId) {
                        insertNodeIntoEdge(hoveredEdgeId, node.id);
                      } else {
                        setInsertionEdgeId(null);
                      }
                    }
                    setDragDropTarget(null);
                    setDragPreviewNodeId(null);
                  }}
                  onMove={(_, viewport) => positionMultiSelectionActions(viewport)}
                  onPaneClick={() => {
                    setSelectedNodeId(null);
                    setSelectedNodeIds([]);
                    setToolbarNodeId(null);
                    setSelectedEdgeId(null);
                    setDragDropTarget(null);
                    setDragPreviewNodeId(null);
                    setNodeContextMenu(null);
                  }}
                  proOptions={FLOW_PRO_OPTIONS}
                >
                </ReactFlow>
              </main>

              {nodeContextMenu ? (
                <div
                  className="node-context-menu"
                  role="menu"
                  aria-label="Node actions"
                  style={{ left: nodeContextMenu.x, top: nodeContextMenu.y }}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  <button type="button" role="menuitem" onClick={handleContextMenuMove}>
                    Move
                  </button>
                  {nodeContextMenu.kind === 'task' ? (
                    <button type="button" role="menuitem" onClick={handleContextMenuCreateGroup}>
                      Create group
                    </button>
                  ) : null}
                  <button type="button" role="menuitem" className="is-danger" onClick={handleContextMenuDelete}>
                    Delete
                  </button>
                </div>
              ) : null}

              <aside
                className={[
                  'editor-inspector',
                  isRightDrawerOpen ? 'is-open' : '',
                  !panelPreferences.rightVisible ? 'is-desktop-hidden' : '',
                ].join(' ')}
                aria-label="Node inspector"
              >
                  <div
                    className="panel-resizer editor-inspector__resizer"
                    role="separator"
                    aria-orientation="vertical"
                    onMouseDown={() => {
                      resizingPanelRef.current = 'right';
                      document.body.classList.add('is-panel-resizing');
                    }}
                    aria-label="Resize node information panel"
                    aria-valuemin={260}
                    aria-valuemax={480}
                    aria-valuenow={panelPreferences.rightWidth}
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                      event.preventDefault();
                      const delta = event.key === 'ArrowLeft' ? 10 : -10;
                      setPanelPreferences((current) => ({
                        ...current,
                        rightWidth: clampRightPanelWidth(current.rightWidth + delta),
                      }));
                    }}
                  />
                  <div className="editor-inspector__header">
                    <div>
                      <span>Inspector</span>
                      <strong>{panelMode === 'root' ? displaySnapshot.root.title || 'Project' : panelItem?.title || 'No selection'}</strong>
                    </div>
                    <button type="button" onClick={() => setIsRightDrawerOpen(false)} aria-label="Close inspector">
                      <X aria-hidden="true" />
                    </button>
                  </div>
                  <div className="editor-inspector__content">
                    {panelMode === 'root' ? (
                      <>
                        <label className="glass-field">
                          Title
                          <input
                            value={displaySnapshot.root.title}
                            onChange={(event) => setRootField('title', event.target.value)}
                            onFocus={() => beginInteractiveDraft('root', 'root', 'title')}
                            onBlur={() => commitInteractiveDraft('root', 'root')}
                          />
                        </label>
                        <label className="glass-field glass-field--description">
                          Description
                          <textarea
                            className="glass-field__textarea"
                            value={displaySnapshot.root.description}
                            onChange={(event) => setRootField('description', event.target.value)}
                            onFocus={() => beginInteractiveDraft('root', 'root', 'description')}
                            onBlur={() => commitInteractiveDraft('root', 'root')}
                          />
                        </label>
                        {panelDraft?.needsRevalidation ? (
                          <p className="feedback">This draft is waiting to be revalidated against the latest server state.</p>
                        ) : null}
                      </>
                    ) : panelItem ? (
                      <>
                        <label className="glass-field">
                          Title
                          <input
                            ref={titleInputRef}
                            value={panelItem.title}
                            onChange={(event) => setNodeTitle(panelItem.id, event.target.value)}
                            onFocus={() => beginInteractiveDraft('node', panelItem.id, 'title')}
                            onBlur={() => commitInteractiveDraft('node', panelItem.id)}
                          />
                        </label>
                        <label className="glass-field glass-field--description">
                          Description
                          <textarea
                            className="glass-field__textarea"
                            value={panelItem.description}
                            onChange={(event) => setNodeField(panelItem.id, 'description', event.target.value)}
                            onFocus={() => beginInteractiveDraft('node', panelItem.id, 'description')}
                            onBlur={() => commitInteractiveDraft('node', panelItem.id)}
                          />
                        </label>
                        <div className="node-date-grid">
                          <label className="glass-field">
                            Do Date
                            <input
                              type="date"
                              value={panelItem.doDate ?? ''}
                              max={panelItem.dueDate ?? undefined}
                              onChange={(event) => setNodeDate(panelItem.id, 'doDate', event.target.value)}
                              onFocus={() => beginInteractiveDraft('node', panelItem.id, 'doDate')}
                              onBlur={() => commitInteractiveDraft('node', panelItem.id)}
                            />
                          </label>
                          <label className="glass-field">
                            Due Date
                            <input
                              type="date"
                              value={panelItem.dueDate ?? ''}
                              min={panelItem.doDate ?? undefined}
                              onChange={(event) => setNodeDate(panelItem.id, 'dueDate', event.target.value)}
                              onFocus={() => beginInteractiveDraft('node', panelItem.id, 'dueDate')}
                              onBlur={() => commitInteractiveDraft('node', panelItem.id)}
                            />
                          </label>
                        </div>
                        {panelDraft?.removedByRollback ? (
                          <p className="feedback feedback--error">This item changed on the server and this draft can no longer be applied.</p>
                        ) : panelDraft?.needsRevalidation ? (
                          <p className="feedback">This draft is waiting to be revalidated against the latest server state.</p>
                        ) : null}
                        <div className="node-created-field">
                          <span>Created</span>
                          <time dateTime={panelItem.createdAt}>{formatCreatedAt(panelItem.createdAt)}</time>
                        </div>
                        <section className="node-tag-editor" aria-label="Node tags">
                          <div className="node-tag-editor__header">
                            <span>Tags</span>
                            <small>{panelTags.length}</small>
                          </div>
                          {panelTags.length > 0 ? (
                            <div className="tag-chip-list">
                              {panelTags.map((tag) => (
                                <button
                                  key={tag}
                                  type="button"
                                  className="tag-chip"
                                  onClick={() => togglePanelTag(tag)}
                                  aria-label={`Remove tag ${tag}`}
                                  title="Remove tag"
                                >
                                  <span>{tag}</span>
                                  <X aria-hidden="true" />
                                </button>
                              ))}
                            </div>
                          ) : null}
                          <div className="node-tag-editor__actions">
                            <button
                              type="button"
                              className="node-tag-editor__open-modal"
                              onClick={() => {
                                setNodeTagModalQuery('');
                                setIsNodeTagModalOpen(true);
                              }}
                            >
                              <Plus aria-hidden="true" />
                              Add tag
                            </button>
                          </div>
                          <p className="node-tag-editor__empty">
                            {workspaceTags.length > 0
                              ? 'Browse workspace tags or create a new one in the tag picker.'
                              : 'Create the first workspace tag from the tag picker.'}
                          </p>
                        </section>
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

      {isNodeTagModalOpen && tagTargetNode ? (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label={`Add tags to ${tagTargetNode.title}`}>
          <button
            type="button"
            className="settings-overlay__scrim"
            onClick={() => setIsNodeTagModalOpen(false)}
            aria-label="Close tag picker"
          />
          <div className="settings-overlay__panel tag-modal__panel">
            <div className="panel settings-panel settings-panel--overlay tag-modal">
              <div className="panel-header">
                <h2>Tag Picker</h2>
                <button
                  type="button"
                  className="icon-button secondary"
                  onClick={() => setIsNodeTagModalOpen(false)}
                  aria-label="Close tag picker"
                >
                  <X aria-hidden="true" />
                </button>
              </div>
              <p className="muted tag-modal__subtitle">Workspace tags for {tagTargetNode.title}</p>
              <div className="node-tag-editor__controls tag-modal__controls">
                <input
                  value={nodeTagModalQuery}
                  onChange={(event) => setNodeTagModalQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && canCreateWorkspaceTag) {
                      event.preventDefault();
                      void createWorkspaceTagFromModal();
                    }
                  }}
                  placeholder="Tag.Path"
                  aria-label="New workspace tag"
                />
                <button
                  type="button"
                  onClick={() => void createWorkspaceTagFromModal()}
                  disabled={!canCreateWorkspaceTag}
                  aria-label="Create new workspace tag"
                  title="Create new workspace tag"
                >
                  <Plus aria-hidden="true" />
                </button>
              </div>
              {visibleWorkspaceTagTree.length > 0 ? (
                <div className="tag-browser tag-modal__browser">
                  <TagTree nodes={visibleWorkspaceTagTree} selectedTags={tagTargetNode.tags} onToggle={(tag) => void toggleNodeTagFromModal(tag)} />
                </div>
              ) : nodeTagModalQuery ? (
                <p className="node-tag-editor__empty">Press Enter to create this new workspace tag.</p>
              ) : (
                <p className="node-tag-editor__empty">No workspace tags yet.</p>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {moveDialogNode ? (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label={`Move ${moveDialogNode.title}`}>
          <button
            type="button"
            className="settings-overlay__scrim"
            onClick={closeMoveDialog}
            aria-label="Close move dialog"
          />
          <div className="settings-overlay__panel move-dialog__panel">
            <div className="panel settings-panel settings-panel--overlay move-dialog">
              <div className="panel-header">
                <h2>Move {moveDialogNode.title}</h2>
                <button
                  type="button"
                  className="icon-button secondary"
                  onClick={closeMoveDialog}
                  aria-label="Close move dialog"
                  disabled={isMoveDialogSubmitting}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
              <p className="muted move-dialog__subtitle">
                Choose a workspace, project root, or node group destination for this {moveDialogNode.kind}.
              </p>
              {moveDialogError ? <p className="feedback feedback--error">{moveDialogError}</p> : null}
              {isMoveDialogLoading ? (
                <p className="node-tag-editor__empty">Loading destinations...</p>
              ) : (
                <div className="move-dialog__tree" role="tree" aria-label="Move destinations">
                  {workspaces.map((workspace) => (
                    <section key={workspace.workspaceId} className="move-dialog__workspace">
                      <header className="move-dialog__workspace-header">
                        <span>{workspace.name}</span>
                        <small>{workspace.projects.length} project{workspace.projects.length === 1 ? '' : 's'}</small>
                      </header>
                      <div className="move-dialog__workspace-body">
                        {workspace.projects.map((project) => {
                          const options = moveDestinationOptions.filter(
                            (option) => option.workspaceId === workspace.workspaceId && option.projectId === project.projectId,
                          );
                          return (
                            <div key={project.projectId} className="move-dialog__project">
                              <div className="move-dialog__project-title">{project.title || 'Untitled Project'}</div>
                              {options.length > 0 ? (
                                <div className="move-dialog__destination-list">
                                  {options.map((option) => (
                                    <button
                                      key={option.key}
                                      type="button"
                                      className="move-dialog__destination"
                                      style={{ paddingLeft: `${14 + option.depth * 18}px` }}
                                      onClick={() => void moveNodeToDestination(option)}
                                      disabled={option.disabled || isMoveDialogSubmitting}
                                      role="treeitem"
                                      aria-disabled={option.disabled}
                                    >
                                      <span>{option.label}</span>
                                      <small>{option.helper}</small>
                                    </button>
                                  ))}
                                </div>
                              ) : (
                                <p className="node-tag-editor__empty">Loading project graph...</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {pendingRecoveryBundle ? (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Restore pending changes">
          <div className="settings-overlay__scrim" />
          <div className="settings-overlay__panel">
            <div className="panel settings-panel settings-panel--overlay">
              <div className="panel-header">
                <h2>Pending Changes Found</h2>
              </div>
              <p className="muted">
                This project has local changes that were not yet approved by the backend. You can restore them and
                continue, or discard them and keep the server-approved version.
              </p>
              <div className="sidebar-menu__actions">
                <button type="button" onClick={restorePendingRecovery}>Restore pending work</button>
                <button type="button" className="is-danger" onClick={discardPendingRecovery}>Discard pending work</button>
              </div>
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
                  <h2>Persistence</h2>
                  <span className={['status-pill', backendStatus === 'online' ? 'is-online' : backendStatus === 'offline' ? 'is-offline' : ''].join(' ')}>
                    {backendStatus}
                  </span>
                </div>
                <p className="muted">Workflow state is stored through the backend graph API and PostgreSQL. AI, OpenAI, and Notion features remain removed.</p>
                <p className="muted">Current workspace: {activeWorkspace?.name ?? 'None selected'}</p>
                <p className="muted">Current project ID: {projectId || 'No project selected'}</p>
                <p className="muted">Workspace portfolio: {workspaces.length} workspace{workspaces.length === 1 ? '' : 's'}</p>
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
