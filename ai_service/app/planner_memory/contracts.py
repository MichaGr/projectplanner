from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..schemas.memory import ActionMemoryBundle, ActionType, PreferenceUpdateProposal
from ..schemas.planner import AIChatRequest


@dataclass
class AgentCallContext:
    action: ActionType
    request: AIChatRequest
    bundle: ActionMemoryBundle
    settings: dict[str, Any]
    payload: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    proposals: list[PreferenceUpdateProposal] = field(default_factory=list)
