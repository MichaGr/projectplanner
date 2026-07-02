export type AvailableTaskItem = {
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectTitle: string;
  taskId: string;
  title: string;
  description: string;
  dueDate: string | null;
  doDate: string | null;
  tags: string[];
  scopePath: string[];
};

export type AvailableTaskScope =
  | { mode: "all" }
  | { mode: "workspace"; workspaceId: string; workspaceName: string }
  | { mode: "project"; workspaceId: string; workspaceName: string; projectId: string; projectTitle: string };

export type CompleteTaskResponse = {
  workspaceId: string;
  projectId: string;
  taskId: string;
  status: "done";
  graphVersion: number;
};

export type TaskDestinationGroupItem = {
  groupId: string;
  title: string;
  path: string[];
  children: TaskDestinationGroupItem[];
};

export type TaskDestinationProjectItem = {
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectTitle: string;
  rootLabel: string;
  groups: TaskDestinationGroupItem[];
};

export type TaskDestinationWorkspaceItem = {
  workspaceId: string;
  workspaceName: string;
  projects: TaskDestinationProjectItem[];
};

export type CreateTaskPayload = {
  workspaceId: string;
  projectId: string;
  parentGroupId: string | null;
  title: string;
  description: string;
  dueDate: string | null;
  doDate: string | null;
  tags: string[];
};

export type CreateTaskResponse = {
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectTitle: string;
  parentGroupId: string | null;
  taskId: string;
  title: string;
  graphVersion: number;
};

export type DestinationOption = {
  key: string;
  value: string;
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectTitle: string;
  parentGroupId: string | null;
  label: string;
  helper: string;
};
