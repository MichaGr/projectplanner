export type ProjectGraphResponse = {
  projectId: string;
  project: unknown;
};

export type GraphContextResponse = {
  projectId: string;
  project: unknown;
  graphVersion: number;
  uiContext: {
    activeTabId: string;
    selectedNodeIds: string[];
    selectedNodes: Array<{
      id: string;
      title: string;
      kind: 'task' | 'group';
    }>;
    scopeNodeIds: string[];
    scopeEdgeIds: string[];
  };
  graphContext: {
    root: {
      title: string;
      description: string;
      completionCriteria: string;
      tags: string[];
    };
    availableTasksGlobal: Array<{
      id: string;
      title: string;
    }>;
    scope: {
      activeScopeId: string | null;
      activeScopeTitle: string;
      scopeNodes: Array<{
        id: string;
        title: string;
        kind: 'task' | 'group';
      }>;
      scopeEdges: Array<{
        id: string;
        source: string;
        target: string;
      }>;
      availableTasksInScope: Array<{
        id: string;
        title: string;
      }>;
    };
    summaries: {
      rootWorkstreams: Array<{ id: string; title: string; kind: 'task' | 'group' }>;
      leavesWithoutSubtasks: Array<{ id: string; title: string; kind: 'task' | 'group' }>;
      tasksWithoutBlockers: Array<{ id: string; title: string }>;
      itemsMissingDetails: Array<{ id: string; title: string; kind: 'task' | 'group'; missing: string }>;
      emptyGroups: Array<{ id: string; title: string }>;
      criticalPathCandidates: Array<{ id: string; title: string; kind: 'task' | 'group'; dependencyDepth: number }>;
    };
  };
};

export type StoredProjectSummary = {
  projectId: string;
  title: string;
  description: string;
  graphVersion: number;
  nodeCount: number;
  edgeCount: number;
  updatedAt: string;
};

export type GraphOperationRequest =
  | {
      type: 'replace_graph';
      project: unknown;
    }
  | {
      type: 'update_node_fields';
      targetType: 'root' | 'node';
      targetId: string;
      fields: {
        title?: string;
        description?: string;
        completionCriteria?: string;
      };
    }
  | {
      type: 'create_group';
      group: unknown;
    }
  | {
      type: 'create_tasks';
      tasks: unknown[];
    }
  | {
      type: 'create_edges';
      edges: unknown[];
    };

export type ChatUiContext = {
  activeTabId: string;
  selectedNodeIds: string[];
  visibleNodeIds: string[];
};

export type AiRequestSettings = {
  supermemoryApiKey?: string;
  openaiApiKey?: string;
};

export type ChatProposal = {
  proposalId: string;
  intent: string;
  mode: string;
  summary: string;
  rationale: string;
  graphOperations: GraphOperationRequest[];
  touchedNodeIds: string[];
  memoryInsight: string | null;
};

export type AiChatResponse = {
  projectId: string;
  intent: string;
  mode: string;
  contextScore: number;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  response: string;
  graphContext: GraphContextResponse['graphContext'];
  memoryContext: Array<Record<string, unknown>>;
  proposal: ChatProposal | null;
};

export type ApplyProposalResponse = {
  proposalId: string;
  projectId: string;
  project: unknown;
  appliedAt: string;
};

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

const fetchWithRetry = async (input: RequestInfo | URL, init?: RequestInit, retries = 4): Promise<Response> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      await wait(300 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to fetch');
};

const ensureOk = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    let message = 'Request failed.';

    try {
      const payload = (await response.json()) as { detail?: string };
      if (payload?.detail) {
        message = payload.detail;
      }
    } catch {
      // Ignore parse errors and keep the generic message.
    }

    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
};

export const createProjectGraph = async (payload: {
  projectId: string;
  title?: string;
  project?: unknown;
}): Promise<ProjectGraphResponse> => {
  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return ensureOk<ProjectGraphResponse>(response);
};

export const fetchProjectGraph = async (projectId: string): Promise<ProjectGraphResponse> => {
  const response = await fetchWithRetry(`/api/projects/${encodeURIComponent(projectId)}/graph`);
  return ensureOk<ProjectGraphResponse>(response);
};

export const listStoredProjects = async (): Promise<StoredProjectSummary[]> => {
  const response = await fetchWithRetry('/api/projects');
  return ensureOk<StoredProjectSummary[]>(response);
};

export const applyProjectGraphOperations = async (
  projectId: string,
  operations: GraphOperationRequest[],
): Promise<ProjectGraphResponse> => {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/operations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ operations }),
  });

  return ensureOk<ProjectGraphResponse>(response);
};

export const fetchProjectContext = async (
  projectId: string,
  uiContext: { activeTabId?: string; selectedNodeIds?: string[] },
): Promise<GraphContextResponse> => {
  const searchParams = new URLSearchParams();
  if (uiContext.activeTabId) {
    searchParams.set('activeTabId', uiContext.activeTabId);
  }
  for (const nodeId of uiContext.selectedNodeIds ?? []) {
    searchParams.append('selectedNodeIds', nodeId);
  }

  const query = searchParams.toString();
  const response = await fetchWithRetry(
    `/api/projects/${encodeURIComponent(projectId)}/context${query ? `?${query}` : ''}`,
  );
  return ensureOk<GraphContextResponse>(response);
};

export const sendChatMessage = async (payload: {
  projectId: string;
  message: string;
  uiContext: ChatUiContext;
  settings?: AiRequestSettings;
}): Promise<AiChatResponse> => {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return ensureOk<AiChatResponse>(response);
};

export const applyChatProposal = async (proposalId: string): Promise<ApplyProposalResponse> => {
  const response = await fetch(`/api/chat/proposals/${encodeURIComponent(proposalId)}/apply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  return ensureOk<ApplyProposalResponse>(response);
};

export const applyChatProposalWithSettings = async (
  proposalId: string,
  settings?: AiRequestSettings,
): Promise<ApplyProposalResponse> => {
  const response = await fetch(`/api/chat/proposals/${encodeURIComponent(proposalId)}/apply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ settings }),
  });

  return ensureOk<ApplyProposalResponse>(response);
};

export const checkWorkflowService = async (): Promise<{ status: string }> => {
  const response = await fetchWithRetry('/api/health');
  return ensureOk<{ status: string }>(response);
};
