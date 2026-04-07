from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .planner import AIContext, PlannerSnapshot


class NotionDatabaseSchemaRequest(BaseModel):
    database_id: str = Field(validation_alias="databaseId")
    token: str | None = None

    model_config = ConfigDict(populate_by_name=True)


class NotionDatabaseProperty(BaseModel):
    id: str
    name: str
    type: str


class NotionDatabaseSchemaResponse(BaseModel):
    database_id: str = Field(serialization_alias="databaseId")
    data_source_id: str = Field(serialization_alias="dataSourceId")
    title: str
    properties: list[NotionDatabaseProperty]

    model_config = ConfigDict(populate_by_name=True)


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
