from __future__ import annotations

from ..planner.context_builder import build_context_bundle, find_target_node
from ..schemas.memory import ActionMemoryBundle, ActionType, ContextItem, Preference, ReviewIssue, SessionSummary
from ..schemas.planner import AIChatRequest
from .provider import MemoryProvider


class ContextAssembler:
    def __init__(self, provider: MemoryProvider) -> None:
        self._provider = provider

    def build_bundle(self, action_type: ActionType, request: AIChatRequest) -> ActionMemoryBundle:
        memory_snapshot = self._provider.retrieve_for_action(request.projectId, action_type)
        graph_context = build_context_bundle(request).model_dump()
        target = find_target_node(request)
        linked_node_ids = {request.context.targetId} if request.context.targetId else set()
        if target and target.parentId:
            linked_node_ids.add(target.parentId)
        context_items = [
            ContextItem.model_validate(item)
            for item in memory_snapshot["context_items"]
            if not linked_node_ids or linked_node_ids.intersection(set(item.get("linked_node_ids", [])))
        ]
        preferences = [Preference.model_validate(item) for item in memory_snapshot["preferences"]]
        review_issues = [ReviewIssue.model_validate(item) for item in memory_snapshot["review_issues"]]
        session_summaries = [SessionSummary.model_validate(item) for item in memory_snapshot["session_summaries"][-5:]]
        return ActionMemoryBundle(
            action_type=action_type,
            scope_summary=graph_context.get("scopeSummary", ""),
            graph_context=graph_context,
            context_items=context_items,
            preferences=preferences,
            review_issues=review_issues,
            session_summaries=session_summaries,
        )

    def add_targeted_context(self, bundle: ActionMemoryBundle, payload: dict) -> ActionMemoryBundle:
        targeted = [*bundle.targeted_context, payload]
        return bundle.model_copy(update={"targeted_context": targeted})
