from __future__ import annotations

from ..schemas.memory import ContextItemStatus, PreferenceStatus

ALLOWED_CONTEXT_STATUS_TRANSITIONS: dict[ContextItemStatus, set[ContextItemStatus]] = {
    "active": {"stale", "candidate_for_archive", "dismissed", "archived"},
    "stale": {"active", "candidate_for_archive", "archived", "dismissed"},
    "candidate_for_archive": {"active", "archived", "dismissed"},
    "archived": set(),
    "dismissed": set(),
}
ALLOWED_PREFERENCE_STATUS_TRANSITIONS: dict[PreferenceStatus, set[PreferenceStatus]] = {
    "active": {"questioned", "superseded"},
    "questioned": {"active", "superseded"},
    "superseded": set(),
}


def can_transition_context_status(current: ContextItemStatus, nxt: ContextItemStatus) -> bool:
    return nxt == current or nxt in ALLOWED_CONTEXT_STATUS_TRANSITIONS[current]


def can_transition_preference_status(current: PreferenceStatus, nxt: PreferenceStatus) -> bool:
    return nxt == current or nxt in ALLOWED_PREFERENCE_STATUS_TRANSITIONS[current]
