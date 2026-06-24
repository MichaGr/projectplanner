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
  fetchProjectGraph,
  listWorkspaces,
  updateProject,
  updateWorkspace,
  WorkspaceSummary,
} from './api';
import {
  Check,
  Menu,
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
  ImportableProjectFile,
  NodeDropTarget,
  NodeJournalState,
  PlannerFlowNode,
  PlannerNodeRecord,
  PlannerSnapshot,
  ProjectFileV1,
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
import { ParticleGridBackground } from './features/planner/canvas/ParticleGridBackground';
import { flowEdgeTypes, flowNodeTypes } from './features/planner/canvas/FlowElements';
import { useDebouncedLocalStorage } from './hooks/useDebouncedLocalStorage';
import { useStableCallback } from './hooks/useStableCallback';
import { usePlannerSnapshot } from './features/planner/state/usePlannerSnapshot';
import { ToolbarIcon } from './components/ToolbarIcon';
import { TagTree } from './features/planner/components/TagTree';
import { buildTagTree, getAllKnownTags, matchesTagQuery } from './features/planner/model/tags';
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
const mainTab: TabDescriptor = { id: 'main', kind: 'main' };
const FLOW_SNAP_GRID: [number, number] = [18, 18];
const FLOW_PRO_OPTIONS = { hideAttribution: true } as const;
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

const getStoredTheme = (): ThemeMode => {
  return 'dark';
};

const clampLeftPanelWidth = (value: number) => Math.min(420, Math.max(220, value));
const clampRightPanelWidth = (value: number) => Math.min(480, Math.max(260, value));

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

function PlannerApp() {
  const { screenToFlowPosition, setCenter, getZoom, getViewport } = useReactFlow();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const canvasShellRef = useRef<HTMLElement | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string>(() => getStoredWorkspaceId());
  const [projectId, setProjectId] = useState<string>(() => getStoredProjectId());
  const [snapshot, setSnapshot] = usePlannerSnapshot(getStoredSnapshot);
  const [themeMode] = useState<ThemeMode>(() => getStoredTheme());
  const [openTabs, setOpenTabs] = useState<TabDescriptor[]>([mainTab]);
  const [activeTabId, setActiveTabId] = useState<string>('main');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [notification, setNotification] = useState<TransientNotification | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [tagQuery, setTagQuery] = useState('');
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
  const [, setSessionJournal] = useState<SessionJournalEntry[]>([]);
  const [panelPreferences, setPanelPreferences] = useState(() => getStoredPanelPreferences());
  const [taskScope, setTaskScope] = useState<TaskScopePreference>(() => getStoredTaskScope());
  const [availableTasks, setAvailableTasks] = useState<AvailableTaskItem[]>([]);
  const [isAvailableTasksLoading, setIsAvailableTasksLoading] = useState(false);
  const [availableTasksError, setAvailableTasksError] = useState<string | null>(null);
  const [availableTasksRefreshKey, setAvailableTasksRefreshKey] = useState(0);
  const [completingTaskKey, setCompletingTaskKey] = useState<string | null>(null);
  const [dragDropTarget, setDragDropTarget] = useState<NodeDropTarget>(null);
  const [dragPreviewNodeId, setDragPreviewNodeId] = useState<string | null>(null);
  const [isCanvasPointerDown, setIsCanvasPointerDown] = useState(false);
  const [isProjectGraphLoading, setIsProjectGraphLoading] = useState(true);
  const [graphSyncError, setGraphSyncError] = useState<string | null>(null);
  const resizingPanelRef = useRef<'left' | 'right' | null>(null);
  const notificationIdRef = useRef(0);
  const availableTasksRequestRef = useRef(0);
  const canvasNodesRef = useRef<PlannerFlowNode[]>([]);
  const multiSelectionActionsRef = useRef<HTMLDivElement | null>(null);
  const flowViewportRef = useRef({ x: 0, y: 0, zoom: 1 });
  const snapshotRef = useRef(snapshot);
  const workspaceIdRef = useRef(workspaceId);
  const projectIdRef = useRef(projectId);
  const isInspectorEditingRef = useRef(false);
  const isApplyingServerSnapshotRef = useRef(false);
  const hasHydratedProjectRef = useRef(false);
  const syncTimerRef = useRef<number | null>(null);
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const syncResolveRef = useRef<(() => void) | null>(null);
  const lastSyncedSnapshotRef = useRef(serializeSnapshot(snapshot));
  const activeScopeId: ScopeId = activeTabId === 'main' ? null : activeTabId;

  const showNotification = useCallback((message: string, tone: TransientNotification['tone'] = 'info') => {
    notificationIdRef.current += 1;
    setNotification({ id: notificationIdRef.current, message, tone });
  }, []);

  const appendSessionJournal = useCallback((entry: SessionJournalEntry | SessionJournalEntry[]) => {
    const nextEntries = Array.isArray(entry) ? entry : [entry];
    setSessionJournal((current) => nextEntries.reduce(mergeSessionJournalEntry, current));
  }, []);

  const plannerGraph = useMemo(
    () => createPlannerGraphIndex(snapshot.nodes, snapshot.edges),
    [snapshot.nodes, snapshot.edges],
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
    workspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  const applyServerProjectGraph = useCallback((nextWorkspaceId: string, nextProjectId: string, nextSnapshot: PlannerSnapshot) => {
    const normalizedSnapshot = sanitizeSnapshot(nextSnapshot);
    isApplyingServerSnapshotRef.current = true;
    lastSyncedSnapshotRef.current = serializeSnapshot(normalizedSnapshot);
    setWorkspaceId(nextWorkspaceId);
    setProjectId(nextProjectId);
    setSnapshot(normalizedSnapshot);
    setGraphSyncError(null);
  }, []);

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

  const persistSnapshotToServer = useCallback(
    async (nextSnapshot?: PlannerSnapshot) => {
      if (!workspaceIdRef.current || !projectIdRef.current) return;
      const snapshotToPersist = sanitizeSnapshot(nextSnapshot ?? snapshotRef.current);
      const response = await applyProjectGraphOperations(workspaceIdRef.current, projectIdRef.current, [
        {
          type: 'replace_graph',
          project: snapshotToPersist,
        },
      ]);

      applyServerProjectGraph(response.workspaceId, response.projectId, response.project as PlannerSnapshot);
      setAvailableTasksRefreshKey((current) => current + 1);
    },
    [applyServerProjectGraph],
  );

  const flushProjectGraphSync = useCallback(async () => {
    const nextSerialized = serializeSnapshot(snapshotRef.current);
    if (!workspaceIdRef.current || !projectIdRef.current || !hasHydratedProjectRef.current || nextSerialized === lastSyncedSnapshotRef.current) {
      return;
    }

    const hasPendingDebouncedSync = syncTimerRef.current !== null;
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }

    if (hasPendingDebouncedSync || !syncPromiseRef.current) {
      const pending = persistSnapshotToServer(snapshotRef.current)
        .catch((error) => {
          setGraphSyncError(error instanceof Error ? error.message : 'Could not persist the workflow.');
        })
        .finally(() => {
          syncPromiseRef.current = null;
          syncResolveRef.current?.();
          syncResolveRef.current = null;
        });
      syncPromiseRef.current = pending;
    }

    if (syncPromiseRef.current) {
      await syncPromiseRef.current;
    }
  }, [persistSnapshotToServer]);

  const initializeProjectGraph = useCallback(async () => {
    setIsProjectGraphLoading(true);
    setGraphSyncError(null);

    try {
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
        applyServerProjectGraph(response.workspaceId, response.projectId, response.project as PlannerSnapshot);
      } else {
        const emptySnapshot = blankSnapshot();
        isApplyingServerSnapshotRef.current = true;
        lastSyncedSnapshotRef.current = serializeSnapshot(emptySnapshot);
        setWorkspaceId(selectedWorkspace.workspaceId);
        setProjectId('');
        setSnapshot(emptySnapshot);
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
    if (!hasHydratedProjectRef.current) {
      return;
    }
    if (isApplyingServerSnapshotRef.current) {
      isApplyingServerSnapshotRef.current = false;
      return;
    }

    if (isInspectorEditingRef.current) {
      return;
    }

    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
    } else {
      syncPromiseRef.current = new Promise<void>((resolve) => {
        syncResolveRef.current = resolve;
      });
    }

    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      if (serializeSnapshot(snapshot) === lastSyncedSnapshotRef.current) {
        syncPromiseRef.current = null;
        syncResolveRef.current?.();
        syncResolveRef.current = null;
        return;
      }
      void persistSnapshotToServer(snapshot)
        .catch((error) => {
          setGraphSyncError(error instanceof Error ? error.message : 'Could not persist the workflow.');
        })
        .finally(() => {
          syncPromiseRef.current = null;
          syncResolveRef.current?.();
          syncResolveRef.current = null;
        });
    }, 300);

    return () => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, [snapshot, persistSnapshotToServer]);

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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsWorkspaceMenuOpen(false);
      setIsProjectMenuOpen(false);
      setIsLeftDrawerOpen(false);
      setIsRightDrawerOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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

  const selectedNode = snapshot.nodes.find((node) => node.id === selectedNodeId) ?? null;
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
  const activeScopeNode = activeScopeId ? snapshot.nodes.find((node) => node.id === activeScopeId) ?? null : null;
  const panelItem = selectedNode ?? activeScopeNode ?? null;
  const panelMode: 'selected' | 'scope-group' | 'root' =
    selectedNode ? 'selected' : activeScopeNode ? 'scope-group' : 'root';

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
    if (taskScope.mode === 'workspace') {
      return workspaceId ? { mode: 'workspace' as const, workspaceId } : null;
    }
    return workspaceId && projectId ? { mode: 'project' as const, workspaceId, projectId } : null;
  }, [projectId, taskScope.mode, workspaceId]);

  useEffect(() => {
    const requestId = availableTasksRequestRef.current + 1;
    availableTasksRequestRef.current = requestId;
    if (!resolvedTaskScope) {
      setAvailableTasks([]);
      setAvailableTasksError(null);
      return;
    }

    setIsAvailableTasksLoading(true);
    setAvailableTasksError(null);
    void fetchAvailableTasks(resolvedTaskScope)
      .then((tasks) => {
        if (availableTasksRequestRef.current === requestId) setAvailableTasks(tasks);
      })
      .catch((error) => {
        if (availableTasksRequestRef.current !== requestId) return;
        setAvailableTasks([]);
        setAvailableTasksError(error instanceof Error ? error.message : 'Could not load available tasks.');
      })
      .finally(() => {
        if (availableTasksRequestRef.current === requestId) setIsAvailableTasksLoading(false);
      });
  }, [availableTasksRefreshKey, resolvedTaskScope]);

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
      if (!projectId) return;
      const newNodeId = uid('task');
      let newNodeTitle = '';
      setSnapshot((current) => {
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
        createdAt: new Date().toISOString(),
        dueDate: null,
        doDate: null,
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

  const resetProjectUi = useCallback(() => {
    setSessionJournal([]);
    setOpenTabs([mainTab]);
    setActiveTabId('main');
    setSelectedNodeId(null);
    setSelectedNodeIds([]);
    setToolbarNodeId(null);
    setSelectedEdgeId(null);
  }, []);

  const setNodeDate = useCallback((nodeId: string, field: EditableNodeDateField, value: string) => {
    setSnapshot((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId ? { ...node, [field]: normalizeDateOnly(value) } : node,
      ),
    }));
  }, []);

  const showEmptyWorkspace = useCallback((nextWorkspaceId: string) => {
    const emptySnapshot = blankSnapshot();
    isApplyingServerSnapshotRef.current = true;
    lastSyncedSnapshotRef.current = serializeSnapshot(emptySnapshot);
    setWorkspaceId(nextWorkspaceId);
    setProjectId('');
    setSnapshot(emptySnapshot);
    resetProjectUi();
  }, [resetProjectUi]);

  const createNewProject = useCallback(async () => {
    if (!workspaceId) return;
    const title = window.prompt('Project name', 'Untitled Project');
    if (title === null) return;
    try {
      await flushProjectGraphSync();
      const project = blankSnapshot();
      project.root.title = title.trim() || 'Untitled Project';
      const response = await createProjectGraph(workspaceId, { project });
      applyServerProjectGraph(response.workspaceId, response.projectId, response.project as PlannerSnapshot);
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
        applyServerProjectGraph(response.workspaceId, response.projectId, loadedSnapshot);
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
        await completeAvailableTask(task.workspaceId, task.projectId, task.taskId);
        setAvailableTasks((current) => current.filter((entry) => entry.taskId !== task.taskId || entry.projectId !== task.projectId));

        if (task.workspaceId === workspaceIdRef.current && task.projectId === projectIdRef.current) {
          const response = await fetchProjectGraph(task.workspaceId, task.projectId);
          applyServerProjectGraph(response.workspaceId, response.projectId, response.project as PlannerSnapshot);
        }
        await loadWorkspaceTree();
        setAvailableTasksRefreshKey((current) => current + 1);
        showNotification(`Completed ${task.title}.`);
      } catch (error) {
        showNotification(error instanceof Error ? error.message : 'Could not complete the task.', 'error');
        setAvailableTasksRefreshKey((current) => current + 1);
      } finally {
        setCompletingTaskKey(null);
      }
    },
    [applyServerProjectGraph, flushProjectGraphSync, loadWorkspaceTree, showNotification],
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
      await loadWorkspaceTree();
      showEmptyWorkspace(created.workspaceId);
      setIsWorkspaceMenuOpen(false);
    } catch (error) {
      setWorkspaceTreeError(error instanceof Error ? error.message : 'Could not create the workspace.');
    }
  }, [flushProjectGraphSync, loadWorkspaceTree, showEmptyWorkspace]);

  const renameWorkspace = useCallback(async (workspace: WorkspaceSummary) => {
    const name = window.prompt('Rename workspace', workspace.name);
    if (name === null || !name.trim() || name.trim() === workspace.name) return;
    try {
      await updateWorkspace(workspace.workspaceId, { name: name.trim() });
      await loadWorkspaceTree();
    } catch (error) {
      setWorkspaceTreeError(error instanceof Error ? error.message : 'Could not rename the workspace.');
    }
  }, [loadWorkspaceTree]);

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
        applyServerProjectGraph(response.workspaceId, response.projectId, response.project as PlannerSnapshot);
      }
      await loadWorkspaceTree();
    } catch (error) {
      setWorkspaceTreeError(error instanceof Error ? error.message : 'Could not rename the project.');
    }
  }, [applyServerProjectGraph, flushProjectGraphSync, loadWorkspaceTree, projectId]);

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

  const importProject = useCallback(() => fileInputRef.current?.click(), []);

  const applyLoadedProject = useCallback(
    async (projectFile: ProjectFileV1) => {
      if (!workspaceId) throw new Error('Create or select a workspace before importing a project.');
      const normalized = sanitizeProjectFile(projectFile);
      await flushProjectGraphSync();
      const response = await createProjectGraph(workspaceId, { project: normalized.project });
      applyServerProjectGraph(response.workspaceId, response.projectId, response.project as PlannerSnapshot);
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
      ? [{ id: 'main', label: snapshot.root.title }]
      : [
          { id: 'main', label: snapshot.root.title },
          ...getGroupPath(snapshot.nodes, activeTabId).map((node) => ({
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
          <div className="editor-sidebar__primary">
            <button
              type="button"
              className="new-node-button"
              onClick={() => addTask()}
              disabled={isProjectGraphLoading || !projectId}
            >
              <Plus aria-hidden="true" />
              New Node
            </button>
          </div>

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
            onOpenProject={openStoredProject}
            onCreateProject={createNewProject}
            onRenameProject={renameStoredProject}
            onRemoveProject={removeStoredProject}
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
                    <span className="available-task-row__status" title="Available" aria-label="Available" />
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="editor-sidebar__footer">
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
                  }}
                  proOptions={FLOW_PRO_OPTIONS}
                >
                </ReactFlow>
              </main>

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
                      <strong>{panelMode === 'root' ? snapshot.root.title || 'Project' : panelItem?.title || 'No selection'}</strong>
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
                            value={snapshot.root.title}
                            onChange={(event) => setRootField('title', event.target.value)}
                            onFocus={handleInspectorFieldFocus}
                            onBlur={handleInspectorFieldBlur}
                          />
                        </label>
                        <label className="glass-field glass-field--description">
                          Description
                          <textarea
                            className="glass-field__textarea"
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
                        <label className="glass-field glass-field--description">
                          Description
                          <textarea
                            className="glass-field__textarea"
                            value={panelItem.description}
                            onChange={(event) => setNodeField(panelItem.id, 'description', event.target.value)}
                            onFocus={handleInspectorFieldFocus}
                            onBlur={handleInspectorFieldBlur}
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
                            />
                          </label>
                          <label className="glass-field">
                            Due Date
                            <input
                              type="date"
                              value={panelItem.dueDate ?? ''}
                              min={panelItem.doDate ?? undefined}
                              onChange={(event) => setNodeDate(panelItem.id, 'dueDate', event.target.value)}
                            />
                          </label>
                        </div>
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
                          <div className="node-tag-editor__controls">
                            <input
                              value={tagQuery}
                              onChange={(event) => setTagQuery(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' && canCreateTag) {
                                  event.preventDefault();
                                  createTagFromQuery();
                                }
                              }}
                              placeholder="Tag.Path"
                              aria-label="Tag path"
                            />
                            <button
                              type="button"
                              onClick={createTagFromQuery}
                              disabled={!canCreateTag}
                              aria-label="Create tag path"
                              title="Create tag path"
                            >
                              <Plus aria-hidden="true" />
                            </button>
                          </div>
                          {visibleTagTree.length > 0 ? (
                            <div className="tag-browser">
                              <TagTree nodes={visibleTagTree} selectedTags={panelTags} onToggle={togglePanelTag} />
                            </div>
                          ) : tagQuery ? (
                            <p className="node-tag-editor__empty">Press Enter to create this tag path.</p>
                          ) : (
                            <p className="node-tag-editor__empty">No tags in this project yet.</p>
                          )}
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
