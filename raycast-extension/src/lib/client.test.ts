import { describe, expect, it, vi } from "vitest";
import { ConfigError, PlannerApiClient } from "./client";

describe("PlannerApiClient", () => {
  it("rejects missing preferences", () => {
    expect(
      () =>
        new PlannerApiClient({
          serverUrl: "",
          username: "planner-admin",
          password: "planner-password",
        }),
    ).toThrow(ConfigError);
  });

  it("re-authenticates once after a 401 response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, username: "planner-admin" }), {
          status: 200,
          headers: { "set-cookie": "projectplanner_session=first-cookie; Path=/; HttpOnly" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Authentication required." }), { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, username: "planner-admin" }), {
          status: 200,
          headers: { "set-cookie": "projectplanner_session=second-cookie; Path=/; HttpOnly" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([{ taskId: "task-1", title: "Ready" }]), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);
    const client = new PlannerApiClient({
      serverUrl: "https://planner.example.com/",
      username: "planner-admin",
      password: "planner-password",
    });

    const response = await client.fetchAvailableTasks();

    expect(response).toEqual([{ taskId: "task-1", title: "Ready" }]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://planner.example.com/api/available-tasks?scope=all");
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      headers: {
        Cookie: "projectplanner_session=second-cookie",
      },
    });
  });

  it("normalizes common server URL variants", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, username: "planner-admin" }), {
          status: 200,
          headers: { "set-cookie": "projectplanner_session=cookie; Path=/; HttpOnly" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);
    const client = new PlannerApiClient({
      serverUrl: "localhost:4173/login",
      username: "planner-admin",
      password: "planner-password",
    });

    await client.fetchAvailableTasks();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:4173/api/auth/login");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:4173/api/available-tasks?scope=all");
  });

  it("builds scoped available-task URLs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, username: "planner-admin" }), {
          status: 200,
          headers: { "set-cookie": "projectplanner_session=cookie; Path=/; HttpOnly" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);
    const client = new PlannerApiClient({
      serverUrl: "https://planner.example.com",
      username: "planner-admin",
      password: "planner-password",
    });

    await client.fetchAvailableTasks({ mode: "workspace", workspaceId: "workspace-1", workspaceName: "Workspace" });
    await client.fetchAvailableTasks({
      mode: "project",
      workspaceId: "workspace-1",
      workspaceName: "Workspace",
      projectId: "project-1",
      projectTitle: "Project",
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://planner.example.com/api/available-tasks?scope=workspace&workspaceId=workspace-1",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://planner.example.com/api/available-tasks?scope=project&workspaceId=workspace-1&projectId=project-1",
    );
  });

  it("posts to the task completion endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, username: "planner-admin" }), {
          status: 200,
          headers: { "set-cookie": "projectplanner_session=cookie; Path=/; HttpOnly" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ taskId: "task-1", projectId: "project-1", workspaceId: "workspace-1", status: "done", graphVersion: 3 }), {
          status: 200,
        }),
      );

    vi.stubGlobal("fetch", fetchMock);
    const client = new PlannerApiClient({
      serverUrl: "https://planner.example.com",
      username: "planner-admin",
      password: "planner-password",
    });

    await client.completeAvailableTask("workspace-1", "project-1", "task-1");

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://planner.example.com/api/workspaces/workspace-1/projects/project-1/tasks/task-1/complete",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        Cookie: "projectplanner_session=cookie",
      },
    });
  });

  it("refreshes the session before requests when the cached login is old", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T09:00:00Z"));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, username: "planner-admin" }), {
          status: 200,
          headers: { "set-cookie": "projectplanner_session=first-cookie; Path=/; HttpOnly" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, username: "planner-admin" }), {
          status: 200,
          headers: { "set-cookie": "projectplanner_session=second-cookie; Path=/; HttpOnly" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);
    const client = new PlannerApiClient({
      serverUrl: "https://planner.example.com",
      username: "planner-admin",
      password: "planner-password",
    });

    await client.fetchAvailableTasks();
    vi.setSystemTime(new Date("2026-07-02T09:06:00Z"));
    await client.fetchAvailableTasks();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://planner.example.com/api/auth/login");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://planner.example.com/api/auth/login");
    vi.useRealTimers();
  });

  it("retries after an empty 401 response from the protected API", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, username: "planner-admin" }), {
          status: 200,
          headers: { "set-cookie": "projectplanner_session=first-cookie; Path=/; HttpOnly" },
        }),
      )
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, username: "planner-admin" }), {
          status: 200,
          headers: { "set-cookie": "projectplanner_session=second-cookie; Path=/; HttpOnly" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);
    const client = new PlannerApiClient({
      serverUrl: "https://planner.example.com",
      username: "planner-admin",
      password: "planner-password",
    });

    await client.fetchAvailableTasks();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      headers: {
        Cookie: "projectplanner_session=second-cookie",
      },
    });
  });

  it("deduplicates concurrent identical read requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, username: "planner-admin" }), {
          status: 200,
          headers: { "set-cookie": "projectplanner_session=cookie; Path=/; HttpOnly" },
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(new Response(JSON.stringify([{ taskId: "task-1", title: "Ready" }]), { status: 200 }));
            }, 5);
          }),
      );

    vi.stubGlobal("fetch", fetchMock);
    const client = new PlannerApiClient({
      serverUrl: "https://planner.example.com",
      username: "planner-admin",
      password: "planner-password",
    });

    const [first, second] = await Promise.all([client.fetchAvailableTasks(), client.fetchAvailableTasks()]);

    expect(first).toEqual([{ taskId: "task-1", title: "Ready" }]);
    expect(second).toEqual([{ taskId: "task-1", title: "Ready" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://planner.example.com/api/available-tasks?scope=all");
  });
});
