from __future__ import annotations

import uuid
from datetime import UTC, datetime

from ...schemas.memory import AgentResult, ContextItem, PreferenceUpdateProposal
from ..contracts import AgentCallContext


class MemoryEditAgent:
    def run(self, context: AgentCallContext) -> AgentResult:
        now = datetime.now(UTC).isoformat()
        message = context.request.message.strip()
        lowered = message.lower()
        target_id = context.request.context.targetId

        status_override = None
        for candidate in ("stale", "candidate_for_archive", "archived", "dismissed"):
            if candidate.replace("_", " ") in lowered or candidate in lowered:
                status_override = candidate
                break

        if context.bundle.context_items and ("archive" in lowered or "stale" in lowered or "dismiss" in lowered):
            item = context.bundle.context_items[0].model_copy(update={"status": status_override or "candidate_for_archive", "updated_at": now})
            return AgentResult(
                status="needs_review",
                payload={
                    "action_type": "add_update_memory",
                    "summary": f"Prepared a status update for memory item {item.id}.",
                    "created_items": [],
                    "updated_items": [item],
                    "created_at": now,
                },
            )

        kind = "note"
        if "note:" in lowered or "remember this note" in lowered:
            kind = "note"
        elif "prefer" in lowered or "preference" in lowered:
            proposal = PreferenceUpdateProposal(
                id=f"pref-proposal-{uuid.uuid4().hex[:8]}",
                type="user" if "user" in lowered else "project",
                category="workflow",
                proposed_rule=message,
                evidence_refs=[],
                rationale="The user explicitly asked to record a preference-like memory.",
                created_at=now,
            )
            return AgentResult(
                status="needs_review",
                payload={
                    "action_type": "add_update_memory",
                    "summary": "Prepared a preference update proposal for review.",
                    "created_items": [],
                    "updated_items": [],
                    "created_at": now,
                },
                proposals=[proposal],
            )
        elif "reference" in lowered:
            kind = "reference"
        elif "concept" in lowered:
            kind = "concept"
        elif "decision" in lowered:
            kind = "decision"
        elif "constraint" in lowered:
            kind = "constraint"
        elif "fact" in lowered:
            kind = "fact"
        elif "guideline" in lowered:
            kind = "guideline"
        elif "evaluation" in lowered:
            kind = "evaluation"
        elif "question" in lowered:
            kind = "question"

        item = ContextItem(
            id=f"mem-{uuid.uuid4().hex[:8]}",
            kind=kind,
            content=message,
            scope="node" if target_id else "project",
            linked_node_ids=[target_id] if target_id else [],
            source="chat",
            author="user",
            confidence=0.9,
            created_at=now,
            updated_at=now,
        )
        return AgentResult(
            status="needs_review",
            payload={
                "action_type": "add_update_memory",
                "summary": f"Prepared a {kind} memory item for review.",
                "created_items": [item],
                "updated_items": [],
                "created_at": now,
            },
        )
