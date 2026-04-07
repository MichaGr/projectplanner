from __future__ import annotations

from typing import Protocol

from ..schemas.memory import (
    ActionType,
    ContextItem,
    Preference,
    PreferenceUpdateProposal,
    ReviewIssue,
    SessionSummary,
)
from .models import can_transition_context_status
from .repository import MemoryRepository


class MemoryProvider(Protocol):
    def retrieve_for_action(self, project_id: str, action_type: ActionType) -> dict: ...
    def retrieve_on_demand(self, project_id: str, query_spec: dict) -> dict: ...
    def create_items(self, project_id: str, items: list[ContextItem]) -> list[ContextItem]: ...
    def update_items(self, project_id: str, updates: list[ContextItem]) -> list[ContextItem]: ...
    def create_review_issues(self, project_id: str, issues: list[ReviewIssue]) -> list[ReviewIssue]: ...
    def store_session_summary(self, project_id: str, summary: SessionSummary) -> SessionSummary: ...
    def propose_preference_updates(
        self, project_id: str, proposals: list[PreferenceUpdateProposal]
    ) -> list[PreferenceUpdateProposal]: ...


class ProjectMemoryProvider:
    def __init__(self, repository: MemoryRepository) -> None:
        self._repository = repository

    def retrieve_for_action(self, project_id: str, action_type: ActionType) -> dict:
        project = self._repository.get_project(project_id)
        return {
            "action_type": action_type,
            "context_items": project["context_items"],
            "preferences": [*project["preferences"]["user"], *project["preferences"]["project"]],
            "review_issues": project["review_issues"],
            "session_summaries": project["session_summaries"],
        }

    def retrieve_on_demand(self, project_id: str, query_spec: dict) -> dict:
        project = self._repository.get_project(project_id)
        item_ids = set(query_spec.get("item_ids", []))
        node_ids = set(query_spec.get("linked_node_ids", []))
        kinds = set(query_spec.get("kinds", []))

        filtered_items = project["context_items"]
        if item_ids:
            filtered_items = [item for item in filtered_items if item["id"] in item_ids]
        if node_ids:
            filtered_items = [
                item for item in filtered_items if node_ids.intersection(set(item.get("linked_node_ids", [])))
            ]
        if kinds:
            filtered_items = [item for item in filtered_items if item["kind"] in kinds]

        return {"items": filtered_items, "review_issues": project["review_issues"]}

    def create_items(self, project_id: str, items: list[ContextItem]) -> list[ContextItem]:
        project = self._repository.get_project(project_id)
        project["context_items"].extend(item.model_dump() for item in items)
        self._repository.update_project(project_id, project)
        return items

    def update_items(self, project_id: str, updates: list[ContextItem]) -> list[ContextItem]:
        project = self._repository.get_project(project_id)
        by_id = {item["id"]: item for item in project["context_items"]}
        for update in updates:
            current = by_id.get(update.id)
            if current is None:
                continue
            if not can_transition_context_status(current["status"], update.status):
                continue
            by_id[update.id] = update.model_dump()
        project["context_items"] = list(by_id.values())
        self._repository.update_project(project_id, project)
        return updates

    def create_review_issues(self, project_id: str, issues: list[ReviewIssue]) -> list[ReviewIssue]:
        project = self._repository.get_project(project_id)
        project["review_issues"].extend(issue.model_dump() for issue in issues)
        self._repository.update_project(project_id, project)
        return issues

    def store_session_summary(self, project_id: str, summary: SessionSummary) -> SessionSummary:
        project = self._repository.get_project(project_id)
        project["session_summaries"].append(summary.model_dump())
        self._repository.update_project(project_id, project)
        return summary

    def propose_preference_updates(
        self, project_id: str, proposals: list[PreferenceUpdateProposal]
    ) -> list[PreferenceUpdateProposal]:
        _ = project_id
        return proposals
