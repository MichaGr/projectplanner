import type { Node } from '@xyflow/react';
import type { AvailableTaskScope } from '../../../api';

export type PlannerNodeKind = 'task' | 'group';
export type TaskStatus = 'todo' | 'done';
export type ScopeId = string | null;
export type ThemeMode = 'dark' | 'light';
export type EditableNodeField = 'description' | 'completionCriteria';
export type EditableNodeDateField = 'dueDate' | 'doDate';
export type EditableRootField = 'title' | 'description' | 'completionCriteria';

export type PlannerNodeRecord = {
  id: string;
  kind: PlannerNodeKind;
  title: string;
  status: TaskStatus;
  position: { x: number; y: number };
  description: string;
  completionCriteria: string;
  tags: string[];
  createdAt?: string;
  dueDate?: string | null;
  doDate?: string | null;
  parentId?: string;
  size?: { width: number; height: number };
};

export type PlannerEdgeRecord = {
  id: string;
  source: string;
  target: string;
};

export type PlannerSnapshot = {
  root: {
    title: string;
    description: string;
    completionCriteria: string;
    tags: string[];
  };
  nodes: PlannerNodeRecord[];
  edges: PlannerEdgeRecord[];
};

export type TabDescriptor =
  | { id: 'main'; kind: 'main' }
  | { id: string; kind: 'group' };

export type ProjectFileV1 = {
  version: 1 | 2 | 3;
  workspaceId?: string;
  projectId?: string;
  project: PlannerSnapshot;
  ui: {
    openTabs: TabDescriptor[];
    activeTabId: string;
    selectedNodeId: string | null;
  };
};

export type ImportableProjectFile =
  | ProjectFileV1
  | PlannerSnapshot
  | { projectId?: string; project: PlannerSnapshot };

export type RenderNodeData = {
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

export type PlannerFlowNode = Node<RenderNodeData, 'plannerTask' | 'plannerGroup'>;
export type NodeDropTarget =
  | { mode: 'group'; nodeId: string }
  | { mode: 'combine'; nodeId: string }
  | null;
export type DragPreviewEdge = { source: string; target: string; path: string };

export type NodeJournalState = {
  id: string;
  kind: PlannerNodeKind;
  title: string;
  description: string;
  completionCriteria: string;
  status: TaskStatus;
  scopeTitle: string;
};

export type SessionJournalEntryType =
  | 'create_node'
  | 'update_node'
  | 'update_root'
  | 'status_change'
  | 'create_edge'
  | 'delete_node'
  | 'delete_edge'
  | 'apply_proposal';

export type JournalEntryBase = {
  type: SessionJournalEntryType;
  title: string;
  detail: string;
  scopeTitle?: string | null;
  completed?: boolean;
};

export type SessionJournalEntry = JournalEntryBase & {
  entityKey?: string;
  initialNodeState?: NodeJournalState;
  finalNodeState?: NodeJournalState;
  nodeAction?: 'created' | 'updated' | 'deleted';
};

export type BackendStatus = 'checking' | 'online' | 'offline';
export type TaskScopePreference = { mode: AvailableTaskScope };
export type TransientNotification = { id: number; message: string; tone: 'info' | 'error' };
