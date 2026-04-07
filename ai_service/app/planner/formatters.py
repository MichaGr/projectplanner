from __future__ import annotations

import uuid

from ..schemas.planner import AIProposal
from .context_builder import coerce_planner_output, coerce_request, describe_affected_targets
from .types import OrchestrationState


def proposal_formatter_node(state: OrchestrationState) -> OrchestrationState:
    request = coerce_request(state["request"])
    planner_output = coerce_planner_output(state["planner_output"])
    output = state["worker_output"]
    proposal = AIProposal(
        proposalId=f"proposal-{uuid.uuid4().hex[:10]}",
        summary=output["summary"],
        context=request.context,
        intentSummary=planner_output.intentSummary,
        contextSummary=planner_output.contextSummary,
        changePlan=output.get("change_plan", []),
        affectedTargets=output.get("affected_targets") or describe_affected_targets(output["operations"], request),
        openQuestions=planner_output.openQuestions,
        operations=output["operations"],
    )
    return {"proposal": proposal, "response_message": output["message"]}
