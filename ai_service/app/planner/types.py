from __future__ import annotations

from typing import Any, Literal, TypedDict

from pydantic import BaseModel, Field

from ..schemas.planner import AIChatRequest, AIPlannerOutput, AIProposal

INTENT_LITERAL = Literal["describe_node", "define_completion_criteria", "create_nodes", "split_into_subtasks"]
MAX_CONTEXT_NODES = 5
ROUTE_MAP: dict[INTENT_LITERAL, str] = {
    "describe_node": "describe_node",
    "define_completion_criteria": "define_completion_criteria",
    "create_nodes": "create_nodes",
    "split_into_subtasks": "split_into_subtasks",
}
GRAPH_NODE_METADATA = {
    "__start__": {
        "label": "START",
        "kind": "entry",
        "description": "Entry point for the AI orchestration flow.",
        "inputs": [],
        "outputs": ["Pass orchestration state into planner."],
    },
    "planner": {
        "label": "Planner",
        "kind": "planner",
        "description": "Builds context, resolves user intent, and prepares the planning summary.",
        "inputs": ["AI chat request", "Current graph context", "Optional uploaded documents"],
        "outputs": ["planner_output"],
    },
    "supervisor": {
        "label": "Supervisor",
        "kind": "router",
        "description": "Chooses the worker path that should handle the current request.",
        "inputs": ["planner_output"],
        "outputs": ["intent route"],
    },
    "describe_node": {
        "label": "Describe Node",
        "kind": "worker",
        "description": "Drafts a stronger node or root description.",
        "inputs": ["planner_output", "request"],
        "outputs": ["description update operation"],
    },
    "define_completion_criteria": {
        "label": "Completion Criteria",
        "kind": "worker",
        "description": "Drafts concrete completion criteria for the selected target.",
        "inputs": ["planner_output", "request"],
        "outputs": ["completion criteria update operation"],
    },
    "create_nodes": {
        "label": "Create Nodes",
        "kind": "worker",
        "description": "Creates new task proposals inside the current scope.",
        "inputs": ["planner_output", "request"],
        "outputs": ["create_tasks operation"],
    },
    "split_into_subtasks": {
        "label": "Split Into Subtasks",
        "kind": "worker",
        "description": "Builds a node-group breakdown and prerequisite edges for subtasks.",
        "inputs": ["planner_output", "request"],
        "outputs": ["create_group", "create_tasks", "create_edges"],
    },
    "proposal_formatter": {
        "label": "Proposal Formatter",
        "kind": "formatter",
        "description": "Converts worker output into the reviewable AI proposal returned to the frontend.",
        "inputs": ["worker_output", "planner_output", "request"],
        "outputs": ["proposal", "response_message"],
    },
    "__end__": {
        "label": "END",
        "kind": "terminal",
        "description": "Terminal node that finishes orchestration after the proposal is prepared.",
        "inputs": ["proposal"],
        "outputs": [],
    },
}


class PlannerDecision(BaseModel):
    intent: INTENT_LITERAL
    confidence: Literal["low", "medium", "high"]
    intentSummary: str
    contextSummary: str
    questions: list[str] = Field(default_factory=list)


class DraftNode(BaseModel):
    title: str
    description: str = ""
    completionCriteria: str = ""


class DraftNodeList(BaseModel):
    summary: str
    nodes: list[DraftNode] = Field(default_factory=list)
    changePlan: list[str] = Field(default_factory=list)


class DraftDependency(BaseModel):
    sourceTitle: str
    targetTitle: str
    rationale: str = ""


class DraftSplitPlan(BaseModel):
    summary: str
    nodes: list[DraftNode] = Field(default_factory=list)
    dependencies: list[DraftDependency] = Field(default_factory=list)
    changePlan: list[str] = Field(default_factory=list)
    dependencySummary: str = ""


class DraftText(BaseModel):
    summary: str
    content: str
    changePlan: list[str] = Field(default_factory=list)


class OrchestrationState(TypedDict, total=False):
    request: AIChatRequest
    settings: dict[str, Any]
    planner_output: AIPlannerOutput
    intent: str
    worker_output: dict[str, Any]
    response_message: str
    proposal: AIProposal | None
