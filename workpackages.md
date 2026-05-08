# Work Packages

## Baseline From Current Repository

- `src/` already contains a single-assistant UI with chat, proposal review, and proposal apply.
- `ai_service/app/main.py` already contains a lightweight workflow pipeline: intent detection, workflow context fetch, Supermemory lookup, proposal generation, validation, and apply-time memory storage.
- `workflow_service/app/main.py` already owns the persistent workflow graph and already computes useful graph context summaries.
- The node and task management system in this repository is the workflow graph in `workflow_service`: projects, nodes, and edges are the canonical source of truth.
- If a dedicated task-graph MCP server is added, it should be implemented as an MCP interface over `workflow_service`, not as a separate node store.
- Notion integration is not present in the codebase today.
- Supermemory is currently used through direct HTTP calls, not through a richer MCP abstraction.

## MCP Capability Notes

- Supermemory already provides persistent memory, semantic search, hybrid memory plus document retrieval, project isolation via `containerTag` or `containerTags`, and metadata filtering. Source: `supermemory.ai/docs/search`, `supermemory.ai/docs/search/filtering`, `supermemory.ai/docs/supermemory-mcp/introduction`.
- Notion MCP is positioned as real-time read and write access to Notion workspace content for MCP-compatible assistants. The official Notion API also exposes search, page retrieval, block append, and data-source query operations. Source: `notion.com/help/notion-mcp`, `developers.notion.com/reference/post-search`, `developers.notion.com/reference/patch-block-children`, `developers.notion.com/reference/query-a-data-source`.

## Work Packages

### WP1. Add Shared Semantic Identity To Workflow Data

- Goal: introduce stable IDs that can map one concept across graph, memory, notes, and future reflections.
- Scope:
  - Extend workflow models with fields such as `concept_id`, `external_refs`, and optional `source_kind`.
  - Include these fields in API payloads and serialization.
- Likely files:
  - `workflow_service/app/main.py`
  - `src/App.tsx`
  - `src/api.ts`
- Done when:
  - Nodes and root project metadata can store semantic identity fields.
  - Graph fetch and graph mutation APIs round-trip the new fields without loss.
  - Existing workflows still load safely when these fields are missing.

### WP1A. Expose `workflow_service` As Task-Graph MCP

- Goal: make the existing node and task graph available through MCP without creating a second graph implementation.
- Scope:
  - Define MCP tools and resources for reading projects, nodes, edges, graph context, and approved graph mutations.
  - Map MCP operations directly onto existing `workflow_service` API and validation rules.
- Likely files:
  - `workflow_service/app/main.py`
  - new MCP server module or wrapper for `workflow_service`
- Done when:
  - An MCP client can inspect workflow graph state through the same canonical backend data model.
  - MCP mutation paths reuse existing graph validation and persistence behavior.
  - There is no duplicate node or task storage outside `workflow_service`.

### WP2. Persist Project-Level Memory Scope Metadata

- Goal: stop using only raw `projectId` assumptions and define an explicit memory scope contract.
- Scope:
  - Add project-level settings for Supermemory scope, container tags, and retrieval defaults.
  - Expose them from the workflow backend so the AI service does not hardcode memory scoping rules.
- Likely files:
  - `workflow_service/app/main.py`
  - `src/api.ts`
  - `src/App.tsx`
- Done when:
  - Project settings include memory scope configuration.
  - The AI service can fetch the scope configuration from workflow context instead of inferring it ad hoc.

### WP3. Replace Direct Supermemory Calls With A Dedicated Memory Adapter

- Goal: isolate Supermemory specifics behind an application-layer adapter before adding richer governance.
- Scope:
  - Extract `SupermemoryClient` into a module with normalized `search_memories`, `search_documents`, and `store_memory` methods.
  - Update current request payloads to use official scoping and filtering primitives consistently.
- Likely files:
  - `ai_service/app/main.py`
  - new file such as `ai_service/app/memory_adapter.py`
- Done when:
  - All Supermemory access goes through one adapter.
  - Search requests consistently pass project scope and metadata filters.
  - Store requests consistently tag memory type and touched entities.

### WP4. Introduce Memory Governance Rules

- Goal: decide what should become durable memory instead of storing every applied proposal summary.
- Scope:
  - Add a memory classification step with categories like `decision`, `preference`, `architecture`, `temporary`, `rejected`.
  - Only persist high-signal categories by policy.
- Likely files:
  - `ai_service/app/main.py`
  - `ai_service/app/memory_adapter.py`
  - new file such as `ai_service/app/memory_policy.py`
- Done when:
  - Proposal apply uses explicit memory eligibility rules.
  - Rejected or low-signal content is excluded from durable memory.
  - Stored memories include metadata describing category and confidence.

### WP5. Refactor AI Service Around Cognitive Workflows

- Goal: align the existing agent graph with the proposed architecture without introducing multiple visible assistants.
- Scope:
  - Replace generic intent handling with explicit workflows: `knowledge`, `planning`, `reflection`, `memory`.
  - Keep the public API as one conversational assistant.
- Likely files:
  - `ai_service/app/main.py`
  - new files such as `ai_service/app/workflows.py` or `ai_service/app/router.py`
- Done when:
  - Requests are routed into named internal workflows.
  - Existing `/api/chat` remains stable for the frontend.
  - Workflow type is visible in logs and response payloads.

### WP6. Expand Context Assembly Into A First-Class Layer

- Goal: make context assembly the core system component rather than a thin fetch-plus-memory step.
- Scope:
  - Build a context assembler that merges workflow graph context, memory retrieval, and later Notion retrieval into one ranked bundle.
  - Add simple token-budget and ranking logic.
- Likely files:
  - `ai_service/app/main.py`
  - new file such as `ai_service/app/context_assembly.py`
- Done when:
  - Chat requests use a dedicated assembly function.
  - Returned context items carry source, rank, and reason metadata.
  - Low-value context is trimmed before reasoning.

### WP7. Add Planning Guardrails And Decomposition Limits

- Goal: prevent runaway task generation and low-signal proposals.
- Scope:
  - Add limits for proposal size, recursion depth, edge creation count, and decomposition confidence.
  - Return clarification instead of generating weak plans.
- Likely files:
  - `ai_service/app/main.py`
  - `src/AiPanel.tsx`
- Done when:
  - Planning proposals enforce configurable caps.
  - Low-confidence planning requests ask focused follow-up questions.
  - Proposal payloads include guardrail metadata for review.

### WP8. Add Rich Proposal Diffs Instead Of Blind Replace-Graph Review

- Goal: make approval safer and more understandable than the current “apply proposal” flow.
- Scope:
  - Generate a human-readable diff summary for node adds, updates, deletes, and edge changes.
  - Prefer structured operation bundles over full graph replacement when possible.
- Likely files:
  - `ai_service/app/main.py`
  - `workflow_service/app/main.py`
  - `src/AiPanel.tsx`
  - `src/api.ts`
- Done when:
  - The assistant response includes a structured diff preview.
  - The frontend shows proposed changes by type.
  - Small proposals no longer require full graph replacement.

### WP9. Add Explicit Approval States And Proposal History

- Goal: turn proposal review into a durable workflow instead of an in-memory transient object.
- Scope:
  - Persist proposals with states like `draft`, `approved`, `applied`, `rejected`, `expired`.
  - Record who approved and when.
- Likely files:
  - `ai_service/app/main.py`
  - `workflow_service/app/main.py`
  - `src/AiPanel.tsx`
- Done when:
  - Proposal state survives service restart.
  - Applied and rejected proposals are queryable.
  - The UI can display prior proposal outcomes.

### WP10. Add Notion Retrieval Integration For Knowledge Workflow

- Goal: introduce external knowledge retrieval without mixing it into planning logic prematurely.
- Scope:
  - Add a Notion adapter for search and page retrieval first.
  - Feed retrieved Notion documents into the context assembly layer as read-only sources.
- Likely files:
  - new file such as `ai_service/app/notion_adapter.py`
  - `ai_service/app/context_assembly.py`
  - `docker-compose.yml`
- Done when:
  - The AI service can search Notion and retrieve selected page content using configured credentials.
  - Context assembly can include Notion results with source labels.
  - No graph mutation depends on Notion write access yet.

### WP11. Add Notion Writeback For Approved Knowledge And Reflection Outputs

- Goal: support controlled write flows only after approval mechanics are in place.
- Scope:
  - Add page creation or block append actions for approved summaries, plans, or reflections.
  - Attach semantic identity metadata so Notion pages can map back to graph concepts.
- Likely files:
  - `ai_service/app/notion_adapter.py`
  - `src/AiPanel.tsx`
- Done when:
  - Approved outputs can be written to Notion deliberately.
  - Written pages include enough metadata to reconnect them to project and concept IDs.
  - The UI makes writeback opt-in.

### WP12. Add Reflection Workflow Endpoint And UI Entry Point

- Goal: support architecture reflection and bottleneck analysis as a first-class workflow.
- Scope:
  - Add a reflection mode that assembles graph, memory, and Notion knowledge and returns structured synthesis.
  - Add a lightweight frontend affordance to trigger reflection separately from task decomposition.
- Likely files:
  - `ai_service/app/main.py`
  - `src/AiPanel.tsx`
- Done when:
  - Users can request reflection without generating graph changes.
  - Responses include themes, bottlenecks, and suggested follow-ups.
  - Reflection outputs can optionally feed memory consolidation.

### WP13. Add Memory Consolidation Jobs

- Goal: separate “memory capture” from “memory consolidation” so durable memory quality improves over time.
- Scope:
  - Add a background or on-demand pass that deduplicates stored memories, merges repeated decisions, and marks stale items.
  - Use Supermemory metadata and project scoping rather than building custom vector infrastructure.
- Likely files:
  - `ai_service/app/main.py`
  - new file such as `ai_service/app/memory_consolidation.py`
- Done when:
  - Consolidation can run safely per project.
  - Duplicate or stale memory candidates are detected and logged.
  - Consolidation policies are explicit and testable.

### WP14. Add Tests For Context, Governance, And Approval Paths

- Goal: cover the new application-layer intelligence where most failure risk now lives.
- Scope:
  - Add backend tests for identity serialization, context assembly, planning guardrails, memory governance, and proposal approval states.
  - Add a minimal frontend test pass for proposal review rendering.
- Likely files:
  - new test files under `ai_service/` and `workflow_service/`
  - frontend test setup if introduced
- Done when:
  - Critical workflow paths have automated coverage.
  - At least one regression test exists for each new policy layer.

## Suggested Delivery Order

1. `WP1` Shared semantic identity
2. `WP1A` Expose `workflow_service` as Task-Graph MCP
3. `WP2` Project memory scope metadata
4. `WP3` Supermemory adapter
5. `WP4` Memory governance
6. `WP6` Context assembly layer
7. `WP7` Planning guardrails
8. `WP8` Rich proposal diffs
9. `WP9` Approval states and history
10. `WP5` Cognitive workflow refactor
11. `WP10` Notion retrieval
12. `WP12` Reflection workflow
13. `WP11` Notion writeback
14. `WP13` Memory consolidation jobs
15. `WP14` Test coverage

## Why This Breakdown Fits The Current Repo

- It preserves the current single-assistant UX in `src/AiPanel.tsx`.
- It builds on the existing `workflow-service` as the source of truth instead of bypassing it.
- It makes the MCP framing explicit: the future task-graph MCP layer should wrap `workflow_service`, which already is the real node management system.
- It treats Supermemory as infrastructure you configure and govern, not infrastructure you rebuild.
- It introduces Notion in two phases: retrieval first, writes later, which reduces approval and data-integrity risk.
