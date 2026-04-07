from __future__ import annotations

import uuid
from datetime import UTC, datetime

from ...schemas.memory import AgentResult, AIMemoryResult, ContextItem, PreferenceUpdateProposal, ReviewIssue, SessionSummary
from ..contracts import AgentCallContext


class ConsolidationAgent:
    def run(self, context: AgentCallContext) -> AgentResult:
        payload = context.payload
        review_issues = [
            issue if isinstance(issue, ReviewIssue) else ReviewIssue.model_validate(issue) for issue in payload.get("review_issues", [])
        ]
        created_items = [
            item if isinstance(item, ContextItem) else ContextItem.model_validate(item) for item in payload.get("created_items", [])
        ]
        updated_items = [
            item if isinstance(item, ContextItem) else ContextItem.model_validate(item) for item in payload.get("updated_items", [])
        ]
        proposals = [
            proposal if isinstance(proposal, PreferenceUpdateProposal) else PreferenceUpdateProposal.model_validate(proposal)
            for proposal in context.proposals
        ]
        touched_node_ids = [context.request.context.targetId] if context.request.context.targetId else []
        touched_memory_item_ids = [item.id for item in [*created_items, *updated_items]]
        session_summary = SessionSummary(
            id=f"summary-{uuid.uuid4().hex[:8]}",
            action_type=context.action,
            summary=payload["summary"],
            touched_node_ids=touched_node_ids,
            touched_memory_item_ids=touched_memory_item_ids,
            created_items=touched_memory_item_ids,
            proposed_updates=[proposal.id for proposal in proposals],
            created_at=datetime.now(UTC).isoformat(),
        )
        next_payload = dict(payload)
        if "memory_result" in next_payload:
            memory_result = next_payload["memory_result"]
            if isinstance(memory_result, AIMemoryResult):
                next_payload["memory_result"] = memory_result.model_copy(update={"sessionSummary": session_summary})
        next_payload["session_summary"] = session_summary
        next_payload["review_issues"] = review_issues
        next_payload["created_items"] = created_items
        next_payload["updated_items"] = updated_items
        next_payload["preference_proposals"] = proposals
        return AgentResult(status="completed", payload=next_payload, warnings=context.warnings, proposals=proposals)
