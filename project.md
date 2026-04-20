# Project Planner

This document describes the current architecture after AI functionality was removed while workflow persistence was kept.

## Objective

Project Planner is a workflow builder for modeling projects as graphs of tasks and groups.

Primary capabilities:

- create and organize tasks and node groups,
- define dependency edges,
- track available work based on completed blockers,
- edit workflow metadata and node details,
- persist workflows in PostgreSQL through a backend API,
- import and export workflow JSON files manually.

## Product Shape

The product currently centers on one main workspace:

- `Echo`: the workflow canvas.

Key interaction rules:

- nodes are `task` or `group`,
- groups define nested scopes,
- edges represent dependencies,
- tasks become available when blockers are complete,
- workflow state is loaded from and saved to the backend service,
- import/export remains available for manual transfer and backup.

Removed for now:

- AI assistant
- AI graph view
- OpenAI integration
- Notion integration
- PDF context upload

## Architecture

### Frontend

- Stack: React 18, TypeScript, Vite, `@xyflow/react`
- Main file: `src/App.tsx`
- API client: `src/api.ts`

Frontend responsibilities:

- render and edit the workflow graph,
- maintain UI state such as tabs and selection,
- load and persist workflows through backend graph APIs,
- handle JSON import/export.

### Backend

- Service name: `workflow-service`
- Stack: FastAPI + SQLAlchemy + PostgreSQL driver
- Entry point: `workflow_service/app/main.py`

Backend responsibilities:

- expose workflow graph CRUD endpoints,
- persist projects, nodes, and edges in PostgreSQL,
- validate graph mutations,
- reject duplicate or invalid dependency edges,
- serve as the source of truth for workflow state.

### Data Layer

- Database: PostgreSQL
- Compose service: `postgres`

Stored entities:

- `projects` for root workflow metadata,
- `nodes` for tasks and groups,
- `edges` for dependencies.

## API Surface

The active public API is workflow-only:

- `GET /api/health`
- `POST /api/projects`
- `GET /api/projects`
- `GET /api/projects/{project_id}/graph`
- `PATCH /api/projects/{project_id}`
- `POST /api/projects/{project_id}/operations`

There are no active AI, OpenAI, model, settings, or Notion endpoints.

## Runtime

- `docker-compose.yml` runs:
  - `project-planner`
  - `workflow-service`
  - `postgres`
- nginx serves the frontend and proxies `/api/...` to `workflow-service`

## Current Notes

- Workflow persistence is server-backed and PostgreSQL-backed.
- Browser local storage is still used for local UI continuity, but not as the primary workflow source of truth.
- If AI returns later, it should be designed as a fresh feature on top of the workflow stack rather than restoring the removed implementation.
