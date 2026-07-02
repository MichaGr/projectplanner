import { describe, expect, it } from "vitest";
import { flattenDestinations } from "./destinations";

describe("flattenDestinations", () => {
  it("flattens project roots and nested groups for the dropdown", () => {
    const options = flattenDestinations([
      {
        workspaceId: "workspace-1",
        workspaceName: "Workspace",
        projects: [
          {
            workspaceId: "workspace-1",
            workspaceName: "Workspace",
            projectId: "project-1",
            projectTitle: "Project",
            rootLabel: "Project root",
            groups: [
              {
                groupId: "group-a",
                title: "Group A",
                path: ["Group A"],
                children: [
                  {
                    groupId: "group-b",
                    title: "Group B",
                    path: ["Group A", "Group B"],
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);

    expect(options.map((option) => option.label)).toEqual(["Workspace / Project", "Group A", "  Group B"]);
    expect(options.map((option) => option.parentGroupId)).toEqual([null, "group-a", "group-b"]);
  });
});
