from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class Position(BaseModel):
    x: float
    y: float


class Size(BaseModel):
    width: float
    height: float


class RootRecord(BaseModel):
    title: str
    description: str
    completionCriteria: str
    tags: list[str] = Field(default_factory=list)


class PlannerNodeRecord(BaseModel):
    id: str
    kind: Literal["task", "group"]
    title: str
    status: Literal["todo", "done"]
    position: Position
    description: str
    completionCriteria: str
    tags: list[str] = Field(default_factory=list)
    parentId: str | None = None
    size: Size | None = None


class PlannerEdgeRecord(BaseModel):
    id: str
    source: str
    target: str


class PlannerSnapshot(BaseModel):
    root: RootRecord
    nodes: list[PlannerNodeRecord]
    edges: list[PlannerEdgeRecord]


class AppSettingsResponse(BaseModel):
    backendStatus: Literal["online", "offline"]
    openai: dict[str, Any]
    notion: dict[str, Any]


class ModelOption(BaseModel):
    id: str
    label: str
    ownedBy: str | None = None


class AIContext(BaseModel):
    targetType: Literal["root", "group", "node"]
    targetId: str | None = None
    targetTitle: str
    scopeId: str | None = None


class AIResolvedIntent(BaseModel):
    intent: Literal["describe_node", "define_completion_criteria", "create_nodes", "split_into_subtasks"]
    confidence: Literal["low", "medium", "high"] = "medium"
    rationale: str = ""


class AINodeContextSummary(BaseModel):
    id: str
    kind: Literal["task", "group"]
    title: str
    parentId: str | None = None
    description: str = ""
    completionCriteria: str = ""
    status: Literal["todo", "done"] = "todo"
    relationship: str


class AIContextBundle(BaseModel):
    target: AINodeContextSummary | None = None
    ancestorGroup: AINodeContextSummary | None = None
    surroundingNodes: list[AINodeContextSummary] = Field(default_factory=list)
    blockingNodes: list[AINodeContextSummary] = Field(default_factory=list)
    scopeSummary: str = ""


class AIPlannerOutput(BaseModel):
    resolvedIntent: AIResolvedIntent
    intentSummary: str
    contextSummary: str
    openQuestions: list[str] = Field(default_factory=list)
    contextBundle: AIContextBundle


class AIConversationMessage(BaseModel):
    id: str
    role: Literal["user", "assistant", "system"]
    content: str


class AIDocument(BaseModel):
    id: str
    name: str
    pageCount: int
    excerpt: str
    content: str


class UpdateNodeFieldsOperation(BaseModel):
    type: Literal["update_node_fields"] = "update_node_fields"
    targetType: Literal["root", "node"]
    targetId: str
    fields: dict[str, str]


class CreateGroupPayload(BaseModel):
    id: str
    title: str
    description: str
    completionCriteria: str
    parentId: str | None = None
    position: Position
    tags: list[str] = Field(default_factory=list)
    size: Size | None = None


class CreateGroupOperation(BaseModel):
    type: Literal["create_group"] = "create_group"
    group: CreateGroupPayload


class CreateTaskPayload(BaseModel):
    id: str
    title: str
    description: str
    completionCriteria: str
    parentId: str | None = None
    position: Position
    tags: list[str] = Field(default_factory=list)


class CreateTasksOperation(BaseModel):
    type: Literal["create_tasks"] = "create_tasks"
    tasks: list[CreateTaskPayload]


class CreateEdgePayload(BaseModel):
    id: str
    source: str
    target: str


class CreateEdgesOperation(BaseModel):
    type: Literal["create_edges"] = "create_edges"
    edges: list[CreateEdgePayload]


GraphMutationOperation = UpdateNodeFieldsOperation | CreateGroupOperation | CreateTasksOperation | CreateEdgesOperation


class AIProposal(BaseModel):
    proposalId: str
    summary: str
    context: AIContext
    intentSummary: str
    contextSummary: str
    changePlan: list[str] = Field(default_factory=list)
    affectedTargets: list[str] = Field(default_factory=list)
    openQuestions: list[str] = Field(default_factory=list)
    operations: list[GraphMutationOperation]


class AIChatRequest(BaseModel):
    message: str
    context: AIContext
    project: PlannerSnapshot
    conversation: list[AIConversationMessage] = Field(default_factory=list)
    documents: list[AIDocument] = Field(default_factory=list)


class AIChatResponse(BaseModel):
    message: str
    proposal: AIProposal | None = None


class ApplyProposalRequest(BaseModel):
    proposal: AIProposal


class OpenAISettingsUpdate(BaseModel):
    apiKey: str | None = None
    selectedModel: str | None = None


class NotionSettingsUpdate(BaseModel):
    token: str | None = None
    notesDatabaseId: str | None = None
    progressDatabaseId: str | None = None
    useNotesForAiContext: bool = False
    enableProgressSync: bool = False
    progressFieldMap: dict[str, str | None] = Field(default_factory=dict)
    notesFieldMap: dict[str, str | None] = Field(default_factory=dict)


class NotionDatabaseSchemaRequest(BaseModel):
    databaseId: str
    token: str | None = None


class NotionDatabaseProperty(BaseModel):
    id: str
    name: str
    type: str


class NotionDatabaseSchemaResponse(BaseModel):
    databaseId: str
    dataSourceId: str
    title: str
    properties: list[NotionDatabaseProperty]


class NotionProgressEntry(BaseModel):
    type: Literal[
        "create_node",
        "update_node",
        "update_root",
        "status_change",
        "create_edge",
        "delete_node",
        "delete_edge",
        "apply_proposal",
    ]
    title: str
    detail: str = ""
    scopeTitle: str | None = None
    completed: bool = False


class NotionProgressSyncRequest(BaseModel):
    project: PlannerSnapshot
    context: AIContext
    entries: list[NotionProgressEntry] = Field(default_factory=list)
