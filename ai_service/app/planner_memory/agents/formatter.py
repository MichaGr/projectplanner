from __future__ import annotations

import uuid

from ...schemas.memory import AIMemoryResult, AgentResult, ContextItem, PreferenceUpdateProposal, ReviewIssue
from ...schemas.planner import AIProposal
from ..contracts import AgentCallContext


class FormatterAgent:
    def run(self, context: AgentCallContext) -> AgentResult:
        payload = context.payload
        if context.action in {"create_task", "describe_node", "define_completion_criteria", "split_task", "split_into_subtasks"}:
            proposal = AIProposal(
                proposalId=f"proposal-{uuid.uuid4().hex[:10]}",
                summary=payload["summary"],
                context=context.request.context,
                intentSummary=f"Handling {context.action.replace('_', ' ')}.",
                contextSummary=context.bundle.scope_summary,
                changePlan=payload.get("change_plan", []),
                affectedTargets=payload.get("affected_targets", []),
                openQuestions=[],
                operations=payload["operations"],
            )
            next_payload = dict(payload)
            next_payload["proposal"] = proposal
            return AgentResult(status="needs_consolidation", payload=next_payload, warnings=context.warnings, proposals=context.proposals)

        created_items = [
            item if isinstance(item, ContextItem) else ContextItem.model_validate(item) for item in payload.get("created_items", [])
        ]
        updated_items = [
            item if isinstance(item, ContextItem) else ContextItem.model_validate(item) for item in payload.get("updated_items", [])
        ]
        review_issues = [
            issue if isinstance(issue, ReviewIssue) else ReviewIssue.model_validate(issue) for issue in payload.get("review_issues", [])
        ]
        proposals = [
            proposal if isinstance(proposal, PreferenceUpdateProposal) else PreferenceUpdateProposal.model_validate(proposal)
            for proposal in context.proposals
        ]
        memory_result = AIMemoryResult(
            actionType="add_update_memory",
            summary=payload["summary"],
            createdItems=created_items,
            updatedItems=updated_items,
            reviewIssues=review_issues,
            preferenceProposals=proposals,
            warnings=context.warnings,
        )
        next_payload = dict(payload)
        next_payload["memory_result"] = memory_result
        return AgentResult(status="needs_consolidation", payload=next_payload, warnings=context.warnings, proposals=proposals)
