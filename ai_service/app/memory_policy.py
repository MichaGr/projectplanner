from __future__ import annotations

from typing import Any


def classify_memory(
    workflow: str,
    intent: str,
    proposal_status: str,
    summary: str,
) -> dict[str, Any]:
    if proposal_status == "rejected":
        return {"category": "rejected", "confidence": 0.95, "shouldStore": False}
    if workflow == "reflection":
        return {"category": "architecture", "confidence": 0.8, "shouldStore": True}
    if intent in {"create_tasks", "update_task"}:
        return {"category": "decision", "confidence": 0.75, "shouldStore": True}
    if "prefer" in summary.lower():
        return {"category": "preference", "confidence": 0.7, "shouldStore": True}
    return {"category": "temporary", "confidence": 0.5, "shouldStore": False}
