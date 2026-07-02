import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  List,
  Toast,
  getPreferenceValues,
  openExtensionPreferences,
  open as openInBrowser,
  showToast,
} from "@raycast/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthError, ConfigError, getPlannerApiClient } from "./lib/client";
import { formatDate } from "./lib/date";
import type { AvailableTaskItem, AvailableTaskScope, TaskDestinationWorkspaceItem } from "./lib/types";

const renderTaskMarkdown = (task: AvailableTaskItem) => {
  const scopeLine = [task.workspaceName, task.projectTitle, ...task.scopePath].join(" / ");
  const tags = task.tags.length > 0 ? task.tags.join(", ") : "None";
  return [
    `# ${task.title}`,
    "",
    task.description || "_No description provided._",
    "",
    `- Scope: ${scopeLine}`,
    `- Due date: ${formatDate(task.dueDate)}`,
    `- Do date: ${formatDate(task.doDate)}`,
    `- Tags: ${tags}`,
  ].join("\n");
};

const getScopeKey = (scope: AvailableTaskScope) => {
  if (scope.mode === "all") {
    return "all";
  }
  if (scope.mode === "workspace") {
    return `workspace:${scope.workspaceId}`;
  }
  return `project:${scope.workspaceId}:${scope.projectId}`;
};

const getScopeLabel = (scope: AvailableTaskScope) => {
  if (scope.mode === "all") {
    return "All workspaces";
  }
  if (scope.mode === "workspace") {
    return `Workspace: ${scope.workspaceName}`;
  }
  return `Project: ${scope.workspaceName} / ${scope.projectTitle}`;
};

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();
  const [tasks, setTasks] = useState<AvailableTaskItem[]>([]);
  const [destinations, setDestinations] = useState<TaskDestinationWorkspaceItem[]>([]);
  const [selectedScopeKey, setSelectedScopeKey] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const scopes = useMemo<AvailableTaskScope[]>(() => {
    const next: AvailableTaskScope[] = [{ mode: "all" }];
    for (const workspace of destinations) {
      next.push({
        mode: "workspace",
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName,
      });
      for (const project of workspace.projects) {
        next.push({
          mode: "project",
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.workspaceName,
          projectId: project.projectId,
          projectTitle: project.projectTitle,
        });
      }
    }
    return next;
  }, [destinations]);

  const selectedScope = useMemo(
    () => scopes.find((scope) => getScopeKey(scope) === selectedScopeKey) ?? scopes[0] ?? ({ mode: "all" } satisfies AvailableTaskScope),
    [scopes, selectedScopeKey],
  );

  const loadTasks = useCallback(
    async (scope: AvailableTaskScope) => {
      try {
        setIsLoading(true);
        const items = await getPlannerApiClient(preferences).fetchAvailableTasks(scope);
        setTasks(items);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not load tasks.");
      } finally {
        setIsLoading(false);
      }
    },
    [preferences],
  );

  useEffect(() => {
    const client = getPlannerApiClient(preferences);
    setIsLoading(true);
    client
      .fetchTaskDestinations()
      .then((items) => {
        setDestinations(items);
        setError(null);
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Could not load task destinations.");
      })
      .finally(() => setIsLoading(false));
  }, [preferences]);

  useEffect(() => {
    void loadTasks(selectedScope);
  }, [loadTasks, selectedScope]);

  const handleCompleteTask = useCallback(
    async (task: AvailableTaskItem) => {
      try {
        setIsLoading(true);
        await getPlannerApiClient(preferences).completeAvailableTask(task.workspaceId, task.projectId, task.taskId);
        await showToast({ style: Toast.Style.Success, title: "Task marked complete", message: task.title });
      } catch (cause) {
        const message =
          cause instanceof ConfigError || cause instanceof AuthError || cause instanceof Error
            ? cause.message
            : "Could not complete task.";
        await showToast({ style: Toast.Style.Failure, title: "Complete task failed", message });
      } finally {
        await loadTasks(selectedScope);
      }
    },
    [loadTasks, preferences, selectedScope],
  );

  if (error) {
    return (
      <Detail
        markdown={error}
        actions={
          <ActionPanel>
            <Action title="Open Extension Preferences" onAction={openExtensionPreferences} />
          </ActionPanel>
        }
      />
    );
  }

  return (
    <List
      isLoading={isLoading}
      isShowingDetail
      searchBarPlaceholder="Search available tasks"
      searchBarAccessory={
        <List.Dropdown
          tooltip="Task Scope"
          value={getScopeKey(selectedScope)}
          onChange={setSelectedScopeKey}
          storeValue={false}
        >
          <List.Dropdown.Item title="All workspaces" value="all" />
          {destinations.map((workspace) => (
            <List.Dropdown.Section key={workspace.workspaceId} title={workspace.workspaceName}>
              <List.Dropdown.Item
                title="All tasks in workspace"
                value={`workspace:${workspace.workspaceId}`}
              />
              {workspace.projects.map((project) => (
                <List.Dropdown.Item
                  key={project.projectId}
                  title={project.projectTitle}
                  value={`project:${workspace.workspaceId}:${project.projectId}`}
                />
              ))}
            </List.Dropdown.Section>
          ))}
        </List.Dropdown>
      }
    >
      {tasks.length === 0 ? (
        <List.EmptyView
          icon={Icon.CheckCircle}
          title="No Available Tasks"
          description={`Current scope: ${getScopeLabel(selectedScope)}`}
        />
      ) : null}
      {tasks.map((task) => {
        const scope = [task.workspaceName, task.projectTitle, ...task.scopePath].join(" / ");
        return (
          <List.Item
            id={task.taskId}
            key={task.taskId}
            icon={Icon.CheckCircle}
            title={task.title}
            subtitle={task.projectTitle}
            keywords={[task.workspaceName, task.projectTitle, ...task.scopePath, ...task.tags]}
            accessories={[
              { text: scope },
              ...(task.dueDate ? [{ tag: task.dueDate }] : []),
            ]}
            detail={<List.Item.Detail markdown={renderTaskMarkdown(task)} />}
            actions={
              <ActionPanel>
                <Action
                  title="Mark Complete"
                  icon={Icon.Check}
                  onAction={() => void handleCompleteTask(task)}
                />
                <Action.CopyToClipboard title="Copy Title" content={task.title} />
                <Action.CopyToClipboard title="Copy Scope" content={scope} />
                <Action title="Open Planner" onAction={() => openInBrowser(preferences.serverUrl)} />
                <Action
                  title="Refresh"
                  onAction={async () => {
                    try {
                      await loadTasks(selectedScope);
                      await showToast({ style: Toast.Style.Success, title: "Tasks refreshed" });
                    } catch (cause) {
                      const message =
                        cause instanceof ConfigError || cause instanceof AuthError || cause instanceof Error
                          ? cause.message
                          : "Could not refresh tasks.";
                      await showToast({ style: Toast.Style.Failure, title: "Refresh failed", message });
                    }
                  }}
                />
                <Action title="Open Extension Preferences" onAction={openExtensionPreferences} />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
