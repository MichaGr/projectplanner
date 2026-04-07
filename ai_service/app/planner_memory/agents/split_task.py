from __future__ import annotations

from ...schemas.memory import AgentResult
from ..contracts import AgentCallContext


class SplitTaskAgent:
    def run(self, context: AgentCallContext) -> AgentResult:
        _ = context
        return AgentResult(status="blocked", warnings=["The memory-aware split_task flow is not implemented yet."])
