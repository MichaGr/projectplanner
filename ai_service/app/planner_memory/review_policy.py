from __future__ import annotations

from ..schemas.memory import ContextItem, ReviewIssue


def detect_duplicate_items(existing_items: list[ContextItem], candidates: list[ContextItem]) -> list[ReviewIssue]:
    seen = {(item.kind, item.content.strip().casefold(), tuple(item.linked_node_ids)) for item in existing_items}
    duplicates: list[ReviewIssue] = []
    for candidate in candidates:
        key = (candidate.kind, candidate.content.strip().casefold(), tuple(candidate.linked_node_ids))
        if key in seen:
            duplicates.append(
                ReviewIssue(
                    id=f"issue-dup-{candidate.id}",
                    type="duplication",
                    summary=f"Possible duplicate {candidate.kind}",
                    description=f"The {candidate.kind} item matches existing memory content.",
                    affected_item_ids=[candidate.id],
                    suggested_actions=["Confirm whether this item should supersede or be merged."],
                    created_at=candidate.updated_at,
                )
            )
    return duplicates


def detect_task_title_collisions(existing_titles: list[str], proposed_titles: list[str], created_at: str) -> list[ReviewIssue]:
    normalized = {title.strip().casefold() for title in existing_titles}
    issues: list[ReviewIssue] = []
    for title in proposed_titles:
        if title.strip().casefold() in normalized:
            issues.append(
                ReviewIssue(
                    id=f"issue-task-{title.strip().casefold().replace(' ', '-')}",
                    type="duplication",
                    summary=f"Task title may duplicate existing scope work: {title}",
                    description=f"A nearby task already uses the title '{title}'.",
                    affected_item_ids=[],
                    suggested_actions=["Rename the task or merge it with the existing work item."],
                    created_at=created_at,
                )
            )
    return issues
