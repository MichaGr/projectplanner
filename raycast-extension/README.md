# Project Planner Raycast Extension

This private Raycast extension lives inside the main repo and talks to the hosted Project Planner instance over the existing session-based login flow.

## Commands

- `Add Task` creates a task in a selected workspace, project, or node group.
- `List Available Tasks` shows actionable tasks from the hosted planner.

## Preferences

- `Server URL`
- `Username`
- `Password`

## Local development

1. `cd raycast-extension`
2. `npm install`
3. `npm run dev`

Then open Raycast and search for `Project Planner`.
