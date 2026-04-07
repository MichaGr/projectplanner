from __future__ import annotations

from .integrations.openai_client import build_chat_model
from .planner.context_builder import build_context_bundle as _build_context_bundle
from .planner.context_builder import planner_prompt as _planner_prompt
from .planner.graph import PlannerEngine, build_graph_visualization


def _get_model(settings):
    return build_chat_model(settings)


def build_graph():
    return PlannerEngine(_get_model).compiled_graph


def get_graph_visualization():
    return build_graph_visualization()
