from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


ActionType = Literal[
    "describe_node",
    "define_completion_criteria",
    "create_task",
    "split_task",
    "split_into_subtasks",
    "rework_graph",
    "review_memory",
    "add_update_memory",
]
ContextItemKind = Literal[
    "reference",
    "note",
    "evaluation",
    "concept",
    "fact",
    "guideline",
    "constraint",
    "decision",
    "question",
]
ContextScope = Literal["global", "project", "node"]
ContextItemStatus = Literal["active", "stale", "candidate_for_archive", "archived", "dismissed"]
PreferenceType = Literal["user", "project"]
PreferenceStatus = Literal["active", "questioned", "superseded"]
ReviewIssueType = Literal[
    "conflict",
    "duplication",
    "staleness",
    "missing_dependency",
    "preference_drift",
    "prune_candidate",
]
ReviewIssueStatus = Literal["open", "reviewed", "resolved", "dismissed"]
AgentStatus = Literal[
    "completed",
    "needs_more_context",
    "needs_review",
    "needs_formatting",
    "needs_consolidation",
    "blocked",
]


class ContextItem(BaseModel):
    id: str
    kind: ContextItemKind
    content: str
    scope: ContextScope = "project"
    linked_node_ids: list[str] = Field(default_factory=list)
    refers_to_context_id: str | None = None
    derived_from_context_id: str | None = None
    status: ContextItemStatus = "active"
    source: str = "assistant"
    author: str = "assistant"
    confidence: float = 0.7
    created_at: str
    updated_at: str


class Preference(BaseModel):
    id: str
    type: PreferenceType
    category: str
    rule: str
    status: PreferenceStatus = "active"
    evidence_refs: list[str] = Field(default_factory=list)
    updated_by: str = "assistant"
    updated_at: str


class ReviewIssue(BaseModel):
    id: str
    type: ReviewIssueType
    summary: str
    description: str
    affected_item_ids: list[str] = Field(default_factory=list)
    suggested_actions: list[str] = Field(default_factory=list)
    status: ReviewIssueStatus = "open"
    created_at: str
    resolved_at: str | None = None


class SessionSummary(BaseModel):
    id: str
    action_type: ActionType
    summary: str
    touched_node_ids: list[str] = Field(default_factory=list)
    touched_memory_item_ids: list[str] = Field(default_factory=list)
    created_items: list[str] = Field(default_factory=list)
    proposed_updates: list[str] = Field(default_factory=list)
    created_at: str


class PreferenceUpdateProposal(BaseModel):
    id: str
    type: PreferenceType
    category: str
    proposed_rule: str
    evidence_refs: list[str] = Field(default_factory=list)
    rationale: str
    status: Literal["pending_review", "accepted", "rejected"] = "pending_review"
    created_at: str


class MemoryRetrievalRequest(BaseModel):
    purpose: str
    query_spec: dict[str, Any] = Field(default_factory=dict)


class ActionMemoryBundle(BaseModel):
    action_type: ActionType
    scope_summary: str = ""
    graph_context: dict[str, Any] = Field(default_factory=dict)
    context_items: list[ContextItem] = Field(default_factory=list)
    preferences: list[Preference] = Field(default_factory=list)
    review_issues: list[ReviewIssue] = Field(default_factory=list)
    session_summaries: list[SessionSummary] = Field(default_factory=list)
    targeted_context: list[dict[str, Any]] = Field(default_factory=list)


class AgentResult(BaseModel):
    status: AgentStatus
    payload: dict[str, Any] = Field(default_factory=dict)
    retrieval_requests: list[MemoryRetrievalRequest] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    proposals: list[PreferenceUpdateProposal] = Field(default_factory=list)
    next_agent_hint: str | None = None


class AIMemoryResult(BaseModel):
    actionType: ActionType
    summary: str
    createdItems: list[ContextItem] = Field(default_factory=list)
    updatedItems: list[ContextItem] = Field(default_factory=list)
    reviewIssues: list[ReviewIssue] = Field(default_factory=list)
    preferenceProposals: list[PreferenceUpdateProposal] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    sessionSummary: SessionSummary | None = None
