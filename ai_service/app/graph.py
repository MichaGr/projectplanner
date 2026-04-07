from __future__ import annotations

from .core.config import get_config
from .integrations.openai_client import build_chat_model
from .planner.context_builder import build_context_bundle as _build_context_bundle
from .planner.context_builder import planner_prompt as _planner_prompt
from .planner.graph import PlannerEngine, build_graph_visualization
from .planner_memory.provider import ProjectMemoryProvider
from .planner_memory.repository import MemoryRepository


def _get_model(settings):
    return build_chat_model(settings)


def build_graph():
    config = get_config()
    memory_provider = ProjectMemoryProvider(MemoryRepository(config.memory_path))
    return PlannerEngine(_get_model, memory_provider).compiled_graph


def get_graph_visualization():
    return build_graph_visualization()
