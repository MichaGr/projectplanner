export type ProjectGraphResponse = {
  workspaceId: string;
  projectId: string;
  project: unknown;
};

export type StoredProjectSummary = {
  workspaceId: string;
  projectId: string;
  title: string;
  description: string;
  graphVersion: number;
  nodeCount: number;
  edgeCount: number;
  updatedAt: string;
};

export type WorkspaceSummary = {
  workspaceId: string;
  name: string;
  description: string;
  tags: string[];
  projectCount: number;
  createdAt: string;
  updatedAt: string;
  projects: StoredProjectSummary[];
};

export type AvailableTaskScope = 'all' | 'workspace' | 'project';

export type AvailableTaskItem = {
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectTitle: string;
  taskId: string;
  title: string;
};

export type CompleteTaskResponse = {
  workspaceId: string;
  projectId: string;
  taskId: string;
  status: 'done';
  graphVersion: number;
};

export type GraphOperationRequest =
  | { type: 'replace_graph'; project: unknown }
  | {
      type: 'update_node_fields';
      targetType: 'root' | 'node';
      targetId: string;
      fields: { title?: string; description?: string; completionCriteria?: string };
    }
  | { type: 'create_group'; group: unknown }
  | { type: 'create_tasks'; tasks: unknown[] }
  | { type: 'create_edges'; edges: unknown[] };

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
      if (attempt === retries) break;
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
      if (payload?.detail) message = payload.detail;
    } catch {
      // Keep the generic message when the response has no JSON detail.
    }
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
};

const workspaceUrl = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}`;
const projectUrl = (workspaceId: string, projectId: string) =>
  `${workspaceUrl(workspaceId)}/projects/${encodeURIComponent(projectId)}`;

export const listWorkspaces = async (): Promise<WorkspaceSummary[]> => {
  const response = await fetchWithRetry('/api/workspaces');
  return ensureOk<WorkspaceSummary[]>(response);
};

export const fetchAvailableTasks = async (scope: {
  mode: AvailableTaskScope;
  workspaceId?: string;
  projectId?: string;
}): Promise<AvailableTaskItem[]> => {
  const params = new URLSearchParams({ scope: scope.mode });
  if (scope.workspaceId) params.set('workspaceId', scope.workspaceId);
  if (scope.projectId) params.set('projectId', scope.projectId);
  const response = await fetchWithRetry(`/api/available-tasks?${params.toString()}`);
  return ensureOk<AvailableTaskItem[]>(response);
};

export const createWorkspace = async (payload: { name: string; description?: string }): Promise<WorkspaceSummary> => {
  const response = await fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return ensureOk<WorkspaceSummary>(response);
};

export const updateWorkspace = async (
  workspaceId: string,
  payload: { name?: string; description?: string; tags?: string[] },
): Promise<WorkspaceSummary> => {
  const response = await fetch(workspaceUrl(workspaceId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return ensureOk<WorkspaceSummary>(response);
};

export const deleteWorkspace = async (
  workspaceId: string,
): Promise<{ deletedWorkspaceId: string; replacementWorkspaceId: string }> => {
  const response = await fetch(workspaceUrl(workspaceId), { method: 'DELETE' });
  return ensureOk(response);
};

export const createProjectGraph = async (
  workspaceId: string,
  payload: { title?: string; project?: unknown },
): Promise<ProjectGraphResponse> => {
  const response = await fetch(`${workspaceUrl(workspaceId)}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return ensureOk<ProjectGraphResponse>(response);
};

export const fetchProjectGraph = async (workspaceId: string, projectId: string): Promise<ProjectGraphResponse> => {
  const response = await fetchWithRetry(`${projectUrl(workspaceId, projectId)}/graph`);
  return ensureOk<ProjectGraphResponse>(response);
};

export const updateProject = async (
  workspaceId: string,
  projectId: string,
  payload: { title?: string; description?: string },
): Promise<ProjectGraphResponse> => {
  const response = await fetch(projectUrl(workspaceId, projectId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return ensureOk<ProjectGraphResponse>(response);
};

export const deleteProject = async (
  workspaceId: string,
  projectId: string,
): Promise<{ deletedProjectId: string }> => {
  const response = await fetch(projectUrl(workspaceId, projectId), { method: 'DELETE' });
  return ensureOk(response);
};

export const completeAvailableTask = async (
  workspaceId: string,
  projectId: string,
  taskId: string,
): Promise<CompleteTaskResponse> => {
  const response = await fetch(
    `${projectUrl(workspaceId, projectId)}/tasks/${encodeURIComponent(taskId)}/complete`,
    { method: 'POST' },
  );
  return ensureOk<CompleteTaskResponse>(response);
};

export const applyProjectGraphOperations = async (
  workspaceId: string,
  projectId: string,
  operations: GraphOperationRequest[],
): Promise<ProjectGraphResponse> => {
  const response = await fetch(`${projectUrl(workspaceId, projectId)}/operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operations }),
  });
  return ensureOk<ProjectGraphResponse>(response);
};

export const checkWorkflowService = async (): Promise<{ status: string }> => {
  const response = await fetchWithRetry('/api/health');
  return ensureOk<{ status: string }>(response);
};
