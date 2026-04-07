from __future__ import annotations

from typing import Any, Callable

from langgraph.graph import END, START, StateGraph

from .formatters import proposal_formatter_node
from .types import GRAPH_NODE_METADATA, OrchestrationState, ROUTE_MAP
from .workers import PlannerWorkers


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
        {"id": "start-planner", "source": START, "target": "planner", "type": "start", "label": "boot"},
        {"id": "planner-supervisor", "source": "planner", "target": "supervisor", "type": "linear", "label": "plan"},
        *[
            {
                "id": f"supervisor-{intent}",
                "source": "supervisor",
                "target": target,
                "type": "conditional",
                "label": intent,
            }
            for intent, target in ROUTE_MAP.items()
        ],
        *[
            {
                "id": f"{node_id}-formatter",
                "source": node_id,
                "target": "proposal_formatter",
                "type": "linear",
                "label": "format proposal",
            }
            for node_id in ROUTE_MAP.values()
        ],
        {"id": "formatter-end", "source": "proposal_formatter", "target": END, "type": "end", "label": "return"},
    ]
    legend = [
        {"kind": "entry", "label": "Entry / Exit", "description": "Lifecycle boundary nodes for the orchestration."},
        {"kind": "planner", "label": "Planner", "description": "Builds intent and context before routing."},
        {"kind": "router", "label": "Router", "description": "Selects the worker branch based on resolved intent."},
        {"kind": "worker", "label": "Worker", "description": "Produces the concrete planning mutation or text draft."},
        {"kind": "formatter", "label": "Formatter", "description": "Packages worker output into a proposal payload."},
        {"kind": "conditional", "label": "Conditional Edge", "description": "A branch selected by the supervisor route."},
    ]
    return {"version": "v1", "source": "langgraph", "nodes": nodes, "edges": edges, "legend": legend}


class PlannerEngine:
    def __init__(self, llm_factory: Callable[[dict[str, Any]], Any]) -> None:
        self._llm_factory = llm_factory
        self._compiled_graph = self._build_graph()

    def _build_graph(self):
        workers = PlannerWorkers(self._llm_factory)
        graph = StateGraph(OrchestrationState)
        graph.add_node("planner", workers.planner_node)
        graph.add_node("supervisor", workers.supervisor_node)
        graph.add_node("describe_node", workers.describe_node_node)
        graph.add_node("define_completion_criteria", workers.completion_criteria_node)
        graph.add_node("create_nodes", workers.create_nodes_node)
        graph.add_node("split_into_subtasks", workers.split_into_subtasks_node)
        graph.add_node("proposal_formatter", proposal_formatter_node)

        graph.add_edge(START, "planner")
        graph.add_edge("planner", "supervisor")
        graph.add_conditional_edges("supervisor", lambda state: state["intent"], ROUTE_MAP)
        graph.add_edge("describe_node", "proposal_formatter")
        graph.add_edge("define_completion_criteria", "proposal_formatter")
        graph.add_edge("create_nodes", "proposal_formatter")
        graph.add_edge("split_into_subtasks", "proposal_formatter")
        graph.add_edge("proposal_formatter", END)
        return graph.compile()

    def run_chat(self, request: Any, settings: dict[str, Any]) -> dict[str, Any]:
        return self._compiled_graph.invoke({"request": request, "settings": settings})

    def get_visualization(self) -> dict[str, Any]:
        return build_graph_visualization()

    @property
    def compiled_graph(self):
        return self._compiled_graph
