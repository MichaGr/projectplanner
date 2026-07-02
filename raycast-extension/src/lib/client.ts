import type {
  AvailableTaskItem,
  AvailableTaskScope,
  CompleteTaskResponse,
  CreateTaskPayload,
  CreateTaskResponse,
  TaskDestinationWorkspaceItem,
} from "./types";

export type PlannerPreferences = {
  serverUrl: string;
  username: string;
  password: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const SESSION_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const READ_CACHE_TTL_MS = 15 * 1000;

const normalizeServerUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new ConfigError("Server URL is invalid. Use the app root URL, for example http://localhost:4173.");
  }

  parsed.pathname = parsed.pathname
    .replace(/\/+(login.*)?$/i, "")
    .replace(/\/+api(?:\/.*)?$/i, "")
    .replace(/\/+$/, "");

  return parsed.toString().replace(/\/+$/, "");
};

const extractSessionCookie = (response: Response): string | null => {
  const raw = response.headers.get("set-cookie");
  if (!raw) {
    return null;
  }
  const match = raw.match(/projectplanner_session=[^;]+/);
  return match ? match[0] : null;
};

const ensureConfigured = (preferences: PlannerPreferences) => {
  if (!normalizeServerUrl(preferences.serverUrl) || !preferences.username.trim() || !preferences.password) {
    throw new ConfigError("Set the server URL, username, and password in the extension preferences.");
  }
};

export class PlannerApiClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private sessionCookie: string | null = null;
  private sessionEstablishedAt = 0;
  private loginInFlight: Promise<void> | null = null;
  private inFlightRequests = new Map<string, Promise<unknown>>();
  private readCache = new Map<string, { expiresAt: number; value: unknown }>();

  constructor(preferences: PlannerPreferences) {
    ensureConfigured(preferences);
    this.baseUrl = normalizeServerUrl(preferences.serverUrl);
    this.username = preferences.username.trim();
    this.password = preferences.password;
  }

  async fetchTaskDestinations() {
    return this.request<TaskDestinationWorkspaceItem[]>("/api/task-destinations");
  }

  async fetchAvailableTasks(scope: AvailableTaskScope = { mode: "all" }) {
    const params = new URLSearchParams({ scope: scope.mode });
    if (scope.mode === "workspace" || scope.mode === "project") {
      params.set("workspaceId", scope.workspaceId);
    }
    if (scope.mode === "project") {
      params.set("projectId", scope.projectId);
    }
    return this.request<AvailableTaskItem[]>(`/api/available-tasks?${params.toString()}`);
  }

  async createTask(payload: CreateTaskPayload) {
    return this.request<CreateTaskResponse>("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async completeAvailableTask(workspaceId: string, projectId: string, taskId: string) {
    return this.request<CompleteTaskResponse>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/complete`,
      {
        method: "POST",
      },
    );
  }

  private async performFetch(input: string, init?: RequestInit, attempts = 3): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fetch(input, init);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await wait(250 * attempt);
        }
      }
    }

    const detail = lastError instanceof Error && lastError.message ? ` ${lastError.message}` : "";
    throw new Error(
      `Could not reach ${this.baseUrl}. Use the app root URL, for example http://localhost:4173 or your public https URL.${detail}`,
    );
  }

  private async login() {
    if (!this.loginInFlight) {
      this.loginInFlight = (async () => {
        const response = await this.performFetch(`${this.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: this.username, password: this.password }),
        });
        if (!response.ok) {
          throw new AuthError("Authentication failed. Check the extension preferences and server login.");
        }
        const cookie = extractSessionCookie(response);
        if (!cookie) {
          throw new AuthError("Authentication succeeded but no session cookie was returned.");
        }
        this.sessionCookie = cookie;
        this.sessionEstablishedAt = Date.now();
      })().finally(() => {
        this.loginInFlight = null;
      });
    }

    await this.loginInFlight;
  }

  private async ensureFreshSession(force = false) {
    const sessionIsStale =
      !this.sessionCookie || Date.now() - this.sessionEstablishedAt >= SESSION_REFRESH_INTERVAL_MS;
    if (force || sessionIsStale) {
      this.sessionCookie = null;
      await this.login();
    }
  }

  private async readErrorMessage(response: Response) {
    const rawBody = await response.text();
    if (!rawBody.trim()) {
      if (response.status === 401 || response.status === 403) {
        return "Authentication expired. The extension will retry automatically; if this keeps happening, reopen the command.";
      }
      return `Request failed with status ${response.status}.`;
    }

    try {
      const payload = JSON.parse(rawBody) as { detail?: string; message?: string };
      return payload.detail || payload.message || `Request failed with status ${response.status}.`;
    } catch {
      return rawBody;
    }
  }

  private getRequestKey(path: string, init?: RequestInit) {
    return JSON.stringify({
      path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
  }

  private async request<T>(path: string, init?: RequestInit, allowRetry = true): Promise<T> {
    const method = init?.method ?? "GET";
    const requestKey = this.getRequestKey(path, init);
    const isCacheableRead = method === "GET";

    if (isCacheableRead) {
      const cached = this.readCache.get(requestKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value as T;
      }
      const inFlight = this.inFlightRequests.get(requestKey);
      if (inFlight) {
        return (await inFlight) as T;
      }
    }

    const executeRequest = async () => {
      await this.ensureFreshSession();

      const response = await this.performFetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          Cookie: this.sessionCookie ?? "",
        },
      });

      if ((response.status === 401 || response.status === 403) && allowRetry) {
        await this.ensureFreshSession(true);
        return this.request<T>(path, init, false);
      }

      if ([502, 503, 504].includes(response.status) && allowRetry) {
        await wait(300);
        return this.request<T>(path, init, false);
      }

      if (!response.ok) {
        const message = await this.readErrorMessage(response);
        if (response.status === 401 || response.status === 403) {
          throw new AuthError(message);
        }
        throw new Error(message);
      }

      const result = (await response.json()) as T;
      if (isCacheableRead) {
        this.readCache.set(requestKey, {
          expiresAt: Date.now() + READ_CACHE_TTL_MS,
          value: result,
        });
      } else {
        this.readCache.clear();
      }
      return result;
    };

    const requestPromise = executeRequest().finally(() => {
      this.inFlightRequests.delete(requestKey);
    });

    if (isCacheableRead) {
      this.inFlightRequests.set(requestKey, requestPromise);
    }

    return await requestPromise;
  }
}

const clientCache = new Map<string, PlannerApiClient>();

export const getPlannerApiClient = (preferences: PlannerPreferences) => {
  const cacheKey = JSON.stringify({
    serverUrl: normalizeServerUrl(preferences.serverUrl),
    username: preferences.username.trim(),
    password: preferences.password,
  });
  const existing = clientCache.get(cacheKey);
  if (existing) {
    return existing;
  }
  const client = new PlannerApiClient(preferences);
  clientCache.set(cacheKey, client);
  return client;
};
