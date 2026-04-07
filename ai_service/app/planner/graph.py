from __future__ import annotations

from typing import Any, Callable

from ..planner_memory.assembler import ContextAssembler
from ..planner_memory.orchestrator import ActionOrchestrator
from ..planner_memory.provider import MemoryProvider

GRAPH_NODE_METADATA = {
    "__start__": {
        "label": "START",
        "kind": "entry",
        "description": "Entry point for the orchestration flow.",
        "inputs": [],
        "outputs": ["request"],
    },
    "router": {
        "label": "Router",
        "kind": "router",
        "description": "Selects the action flow for the request.",
        "inputs": ["request"],
        "outputs": ["action"],
    },
    "context_assembler": {
        "label": "Context Assembler",
        "kind": "planner",
        "description": "Builds the action-specific graph and memory bundle.",
        "inputs": ["action", "request"],
        "outputs": ["bundle"],
    },
    "task_draft": {
        "label": "Task Draft",
        "kind": "worker",
        "description": "Drafts graph actions and returns control to the orchestrator.",
        "inputs": ["bundle"],
        "outputs": ["handoff"],
    },
    "memory_edit": {
        "label": "Memory Edit",
        "kind": "worker",
        "description": "Creates or updates memory items and returns control to the orchestrator.",
        "inputs": ["bundle"],
        "outputs": ["handoff"],
    },
    "reviewer": {
        "label": "Reviewer",
        "kind": "worker",
        "description": "Checks drafts against memory and scope constraints.",
        "inputs": ["handoff"],
        "outputs": ["handoff"],
    },
    "formatter": {
        "label": "Formatter",
        "kind": "formatter",
        "description": "Builds the response payload that goes back to the API.",
        "inputs": ["handoff"],
        "outputs": ["formatted result"],
    },
    "consolidation": {
        "label": "Consolidation",
        "kind": "worker",
        "description": "Prepares writes, proposals, issues, and session summaries.",
        "inputs": ["formatted result"],
        "outputs": ["finalized result"],
    },
    "__end__": {
        "label": "END",
        "kind": "terminal",
        "description": "Terminal node that returns the orchestrated response.",
        "inputs": ["finalized result"],
        "outputs": [],
    },
}


def build_graph_visualization() -> dict[str, Any]:
    nodes = [
        {
            "id": node_id,
            "label": metadata["label"],
            "kind": metadata["kind"],
            "description": metadata["description"],
            "inputs": metadata["inputs"],
            "outputs": metadata["outputs"],
        }
        for node_id, metadata in GRAPH_NODE_METADATA.items()
    ]
    edges = [
        {"id": "start-router", "source": "__start__", "target": "router", "type": "start", "label": "route"},
        {"id": "router-context", "source": "router", "target": "context_assembler", "type": "linear", "label": "assemble"},
        {"id": "context-task", "source": "context_assembler", "target": "task_draft", "type": "conditional", "label": "graph action"},
        {"id": "context-memory", "source": "context_assembler", "target": "memory_edit", "type": "conditional", "label": "memory action"},
        {"id": "draft-reviewer", "source": "task_draft", "target": "reviewer", "type": "handoff", "label": "review"},
        {"id": "memory-reviewer", "source": "memory_edit", "target": "reviewer", "type": "handoff", "label": "review"},
        {"id": "reviewer-formatter", "source": "reviewer", "target": "formatter", "type": "handoff", "label": "format"},
        {"id": "formatter-consolidation", "source": "formatter", "target": "consolidation", "type": "handoff", "label": "consolidate"},
        {"id": "consolidation-end", "source": "consolidation", "target": "__end__", "type": "end", "label": "return"},
    ]
    return {"version": "v2", "source": "agent-orchestrator", "nodes": nodes, "edges": edges}


class _CompiledPlannerGraph:
    def __init__(self, engine: "PlannerEngine") -> None:
        self._engine = engine

    def invoke(self, state: dict[str, Any]) -> dict[str, Any]:
        return self._engine.run_state(state["request"], state["settings"])


class PlannerEngine:
    def __init__(self, llm_factory: Callable[[dict[str, Any]], Any], memory_provider: MemoryProvider) -> None:
        self._orchestrator = ActionOrchestrator(llm_factory, ContextAssembler(memory_provider), memory_provider)
        self._compiled_graph = _CompiledPlannerGraph(self)

    def run_chat(self, request: Any, settings: dict[str, Any]) -> dict[str, Any]:
        return self._orchestrator.run(request, settings)

    def run_state(self, request: Any, settings: dict[str, Any]) -> dict[str, Any]:
        return self._orchestrator.run(request, settings)

    def get_visualization(self) -> dict[str, Any]:
        return build_graph_visualization()

    @property
    def compiled_graph(self):
        return self._compiled_graph
