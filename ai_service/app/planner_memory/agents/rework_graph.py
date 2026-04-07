from __future__ import annotations

from ...schemas.memory import AgentResult
from ..contracts import AgentCallContext


class ReworkGraphAgent:
    def run(self, context: AgentCallContext) -> AgentResult:
        _ = context
        return AgentResult(status="blocked", warnings=["The rework_graph flow is not implemented yet."])
