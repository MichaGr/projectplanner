import type { DestinationOption, TaskDestinationGroupItem, TaskDestinationWorkspaceItem } from "./types";

const appendGroupOptions = (
  options: DestinationOption[],
  workspace: TaskDestinationWorkspaceItem,
  project: TaskDestinationWorkspaceItem["projects"][number],
  groups: TaskDestinationGroupItem[],
) => {
  for (const group of groups) {
    options.push({
      key: `${workspace.workspaceId}:${project.projectId}:group:${group.groupId}`,
      value: `${workspace.workspaceId}:${project.projectId}:${group.groupId}`,
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.workspaceName,
      projectId: project.projectId,
      projectTitle: project.projectTitle,
      parentGroupId: group.groupId,
      label: `${"  ".repeat(Math.max(group.path.length - 1, 0))}${group.title}`,
      helper: `${workspace.workspaceName} / ${project.projectTitle}`,
    });
    appendGroupOptions(options, workspace, project, group.children);
  }
};

export const flattenDestinations = (workspaces: TaskDestinationWorkspaceItem[]): DestinationOption[] => {
  const options: DestinationOption[] = [];
  for (const workspace of workspaces) {
    for (const project of workspace.projects) {
      options.push({
        key: `${workspace.workspaceId}:${project.projectId}:root`,
        value: `${workspace.workspaceId}:${project.projectId}:root`,
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName,
        projectId: project.projectId,
        projectTitle: project.projectTitle,
        parentGroupId: null,
        label: `${workspace.workspaceName} / ${project.projectTitle}`,
        helper: `${workspace.workspaceName} / ${project.projectTitle}`,
      });
      appendGroupOptions(options, workspace, project, project.groups);
    }
  }
  return options;
};
