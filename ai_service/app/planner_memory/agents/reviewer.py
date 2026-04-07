from __future__ import annotations

from ...schemas.memory import AgentResult, ContextItem, ReviewIssue
from ..contracts import AgentCallContext
from ..review_policy import detect_duplicate_items, detect_task_title_collisions


class ReviewerAgent:
    def run(self, context: AgentCallContext) -> AgentResult:
        payload = dict(context.payload)
        warnings = list(context.warnings)
        review_issues: list[ReviewIssue] = list(payload.get("review_issues", []))
        created_at = payload.get("created_at")

        if context.action == "create_task":
            surrounding = context.bundle.graph_context.get("surroundingNodes", [])
            existing_titles = [node["title"] for node in surrounding]
            target = context.bundle.graph_context.get("target")
            if target:
                existing_titles.append(target["title"])
            review_issues.extend(detect_task_title_collisions(existing_titles, payload.get("proposed_task_titles", []), created_at))
            warnings.extend(issue.summary for issue in review_issues)
        elif context.action == "add_update_memory":
            created_items = [item if isinstance(item, ContextItem) else ContextItem.model_validate(item) for item in payload.get("created_items", [])]
            updated_items = [item if isinstance(item, ContextItem) else ContextItem.model_validate(item) for item in payload.get("updated_items", [])]
            review_issues.extend(detect_duplicate_items(context.bundle.context_items, created_items + updated_items))
            warnings.extend(issue.summary for issue in review_issues)

        payload["review_issues"] = review_issues
        return AgentResult(status="needs_formatting", payload=payload, warnings=warnings, proposals=context.proposals)
