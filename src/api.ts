export type ProjectGraphResponse = {
  projectId: string;
  project: unknown;
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

export const checkWorkflowService = async (): Promise<{ status: string }> => {
  const response = await fetchWithRetry('/api/health');
  return ensureOk<{ status: string }>(response);
};
