from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class StoredSettings(BaseModel):
    api_key: str | None = None
    selected_model: str | None = None
    notion_token: str | None = None
    notion_notes_database_id: str | None = None
    notion_progress_database_id: str | None = None
    notion_use_notes_for_ai_context: bool = False
    notion_enable_progress_sync: bool = False
    notion_progress_field_map: dict[str, str | None] = Field(default_factory=dict)
    notion_notes_field_map: dict[str, str | None] = Field(default_factory=dict)


class OpenAISettingsSummary(BaseModel):
    has_api_key: bool = Field(serialization_alias="hasApiKey")
    selected_model: str | None = Field(default=None, serialization_alias="selectedModel")

    model_config = ConfigDict(populate_by_name=True)


class NotionSettingsSummary(BaseModel):
    token_configured: bool = Field(serialization_alias="tokenConfigured")
    notes_database_id: str | None = Field(default=None, serialization_alias="notesDatabaseId")
    progress_database_id: str | None = Field(default=None, serialization_alias="progressDatabaseId")
    use_notes_for_ai_context: bool = Field(serialization_alias="useNotesForAiContext")
    enable_progress_sync: bool = Field(serialization_alias="enableProgressSync")
    progress_field_map: dict[str, str | None] = Field(default_factory=dict, serialization_alias="progressFieldMap")
    notes_field_map: dict[str, str | None] = Field(default_factory=dict, serialization_alias="notesFieldMap")

    model_config = ConfigDict(populate_by_name=True)


class AppSettingsResponse(BaseModel):
    backend_status: Literal["online", "offline"] = Field(serialization_alias="backendStatus")
    openai: OpenAISettingsSummary
    notion: NotionSettingsSummary

    model_config = ConfigDict(populate_by_name=True)


class ModelOption(BaseModel):
    id: str
    label: str
    owned_by: str | None = Field(default=None, serialization_alias="ownedBy")

    model_config = ConfigDict(populate_by_name=True)


class OpenAISettingsUpdate(BaseModel):
    api_key: str | None = Field(default=None, validation_alias="apiKey")
    selected_model: str | None = Field(default=None, validation_alias="selectedModel")

    model_config = ConfigDict(populate_by_name=True)


class NotionSettingsUpdate(BaseModel):
    token: str | None = None
    notes_database_id: str | None = Field(default=None, validation_alias="notesDatabaseId")
    progress_database_id: str | None = Field(default=None, validation_alias="progressDatabaseId")
    use_notes_for_ai_context: bool = Field(default=False, validation_alias="useNotesForAiContext")
    enable_progress_sync: bool = Field(default=False, validation_alias="enableProgressSync")
    progress_field_map: dict[str, str | None] = Field(default_factory=dict, validation_alias="progressFieldMap")
    notes_field_map: dict[str, str | None] = Field(default_factory=dict, validation_alias="notesFieldMap")

    model_config = ConfigDict(populate_by_name=True)


def build_settings_response(settings: StoredSettings) -> AppSettingsResponse:
    return AppSettingsResponse(
        backend_status="online",
        openai=OpenAISettingsSummary(
            has_api_key=bool(settings.api_key),
            selected_model=settings.selected_model,
        ),
        notion=NotionSettingsSummary(
            token_configured=bool(settings.notion_token),
            notes_database_id=settings.notion_notes_database_id,
            progress_database_id=settings.notion_progress_database_id,
            use_notes_for_ai_context=settings.notion_use_notes_for_ai_context,
            enable_progress_sync=settings.notion_enable_progress_sync,
            progress_field_map=settings.notion_progress_field_map,
            notes_field_map=settings.notion_notes_field_map,
        ),
    )
