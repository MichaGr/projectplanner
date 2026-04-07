from __future__ import annotations

from ...schemas.memory import AgentResult
from ..contracts import AgentCallContext


class ReviewMemoryAgent:
    def run(self, context: AgentCallContext) -> AgentResult:
        _ = context
        return AgentResult(status="blocked", warnings=["The review_memory flow is not implemented yet."])
