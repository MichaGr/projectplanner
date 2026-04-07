export type BackendStatus = 'online' | 'offline';

export type AppSettings = {
  backendStatus: BackendStatus;
  openai: {
    hasApiKey: boolean;
    selectedModel: string | null;
  };
  notion: {
    tokenConfigured: boolean;
    notesDatabaseId: string | null;
    progressDatabaseId: string | null;
    useNotesForAiContext: boolean;
    enableProgressSync: boolean;
    progressFieldMap: Record<string, string | null>;
    notesFieldMap: Record<string, string | null>;
  };
};

export type ModelOption = {
  id: string;
  label: string;
  ownedBy?: string | null;
};

export type AIConversationMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type AIDocument = {
  id: string;
  name: string;
  pageCount: number;
  excerpt: string;
  content: string;
};

export type AIContext = {
  targetType: 'root' | 'group' | 'node';
  targetId: string | null;
  targetTitle: string;
  scopeId: string | null;
};

export type AIResolvedIntent = {
  intent: 'describe_node' | 'define_completion_criteria' | 'create_nodes' | 'split_into_subtasks';
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
};

export type AINodeContextSummary = {
  id: string;
  kind: 'task' | 'group';
  title: string;
  parentId?: string | null;
  description: string;
  completionCriteria: string;
  status: 'todo' | 'done';
  relationship: string;
};

export type AIContextBundle = {
  target?: AINodeContextSummary | null;
  ancestorGroup?: AINodeContextSummary | null;
  surroundingNodes: AINodeContextSummary[];
  blockingNodes: AINodeContextSummary[];
  scopeSummary: string;
};

export type AIPlannerOutput = {
  resolvedIntent: AIResolvedIntent;
  intentSummary: string;
  contextSummary: string;
  openQuestions: string[];
  contextBundle: AIContextBundle;
};

export type UpdateNodeFieldsOperation = {
  type: 'update_node_fields';
  targetType: 'root' | 'node';
  targetId: string;
  fields: {
    title?: string;
    description?: string;
    completionCriteria?: string;
  };
};

export type CreateGroupOperation = {
  type: 'create_group';
  group: {
    id: string;
    title: string;
    description: string;
    completionCriteria: string;
    parentId?: string;
    position: { x: number; y: number };
    tags?: string[];
    size?: { width: number; height: number };
  };
};

export type CreateTasksOperation = {
  type: 'create_tasks';
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    completionCriteria: string;
    parentId?: string;
    position: { x: number; y: number };
    tags?: string[];
  }>;
};

export type CreateEdgesOperation = {
  type: 'create_edges';
  edges: Array<{
    id: string;
    source: string;
    target: string;
  }>;
};

export type GraphMutationOperation =
  | UpdateNodeFieldsOperation
  | CreateGroupOperation
  | CreateTasksOperation
  | CreateEdgesOperation;

export type AIProposal = {
  proposalId: string;
  summary: string;
  context: AIContext;
  intentSummary: string;
  contextSummary: string;
  changePlan: string[];
  affectedTargets: string[];
  openQuestions: string[];
  operations: GraphMutationOperation[];
};

export type AIChatResponse = {
  message: string;
  proposal?: AIProposal | null;
};

export type AIGraphNode = {
  id: string;
  label: string;
  kind: 'entry' | 'planner' | 'router' | 'worker' | 'formatter' | 'terminal';
  description: string;
  inputs: string[];
  outputs: string[];
};

export type AIGraphEdge = {
  id: string;
  source: string;
  target: string;
  type: 'start' | 'linear' | 'conditional' | 'end';
  label: string;
};

export type AIGraphLegendItem = {
  kind: string;
  label: string;
  description: string;
};

export type AIGraphResponse = {
  version: string;
  source: 'langgraph';
  nodes: AIGraphNode[];
  edges: AIGraphEdge[];
  legend: AIGraphLegendItem[];
};

export type NotionProgressEntry = {
  type:
    | 'create_node'
    | 'update_node'
    | 'update_root'
    | 'status_change'
    | 'create_edge'
    | 'delete_node'
    | 'delete_edge'
    | 'apply_proposal';
  title: string;
  detail: string;
  scopeTitle?: string | null;
  completed?: boolean;
};

export type NotionDatabaseProperty = {
  id: string;
  name: string;
  type: string;
};

export type NotionDatabaseSchemaResponse = {
  databaseId: string;
  dataSourceId: string;
  title: string;
  properties: NotionDatabaseProperty[];
};

const normalizeProposal = (proposal: AIProposal | null | undefined): AIProposal | null => {
  if (!proposal) {
    return null;
  }

  return {
    ...proposal,
    intentSummary: proposal.intentSummary ?? proposal.summary ?? 'Review the requested change.',
    contextSummary:
      proposal.contextSummary ??
      `Working in the ${proposal.context.targetTitle} context (${proposal.context.targetType}).`,
    changePlan: Array.isArray(proposal.changePlan) ? proposal.changePlan : [proposal.summary ?? 'Apply the proposed graph changes.'],
    affectedTargets: Array.isArray(proposal.affectedTargets)
      ? proposal.affectedTargets
      : [proposal.context.targetTitle],
    openQuestions: Array.isArray(proposal.openQuestions) ? proposal.openQuestions : [],
  };
};

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const ensureOk = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    let message = 'Request failed.';

    try {
      const payload = (await response.json()) as { detail?: string };
      if (payload?.detail) {
        message = payload.detail;
      }
    } catch {
      // Ignore JSON parse failures and keep the generic message.
    }

    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
};

export const fetchSettings = async (): Promise<AppSettings> => {
  const response = await fetch('/api/settings');
  return ensureOk<AppSettings>(response);
};

export const fetchModels = async (): Promise<ModelOption[]> => {
  const response = await fetch('/api/models');
  return ensureOk<ModelOption[]>(response);
};

export const fetchAIGraph = async (): Promise<AIGraphResponse> => {
  const response = await fetch('/api/ai/graph');
  return ensureOk<AIGraphResponse>(response);
};

export const saveOpenAISettings = async (payload: {
  apiKey?: string;
  selectedModel?: string | null;
}): Promise<AppSettings> => {
  const response = await fetch('/api/settings/openai', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return ensureOk<AppSettings>(response);
};

export const saveNotionSettings = async (payload: {
  token?: string;
  notesDatabaseId?: string | null;
  progressDatabaseId?: string | null;
  useNotesForAiContext: boolean;
  enableProgressSync: boolean;
  progressFieldMap: Record<string, string | null>;
  notesFieldMap: Record<string, string | null>;
}): Promise<AppSettings> => {
  const response = await fetch('/api/settings/notion', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return ensureOk<AppSettings>(response);
};

export const fetchNotionDatabaseSchema = async (payload: {
  databaseId: string;
  token?: string;
}): Promise<NotionDatabaseSchemaResponse> => {
  const response = await fetch('/api/notion/database-schema', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return ensureOk<NotionDatabaseSchemaResponse>(response);
};

export const sendAIChat = async (payload: {
  message: string;
  context: AIContext;
  project: unknown;
  conversation: AIConversationMessage[];
  documents?: AIDocument[];
}): Promise<AIChatResponse> => {
  const response = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const result = await ensureOk<AIChatResponse>(response);
  return {
    ...result,
    proposal: normalizeProposal(result.proposal),
  };
};

export const confirmAIProposal = async (proposal: AIProposal): Promise<{ accepted: true }> => {
  const response = await fetch('/api/ai/apply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ proposal }),
  });

  return ensureOk<{ accepted: true }>(response);
};

export const uploadAIDocuments = async (files: File[]): Promise<AIDocument[]> => {
  const body = new FormData();
  for (const file of files) {
    body.append('files', file);
  }

  const response = await fetch('/api/ai/documents', {
    method: 'POST',
    body,
  });

  return ensureOk<AIDocument[]>(response);
};

export const syncNotionProgress = async (payload: {
  project: unknown;
  context: AIContext;
  entries: NotionProgressEntry[];
}): Promise<{ title: string; syncedEntries: number }> => {
  const response = await fetch('/api/notion/progress-sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return ensureOk<{ title: string; syncedEntries: number }>(response);
};
