from __future__ import annotations

from ..core.errors import ServiceError
from ..repositories.settings_repository import MISSING, SettingsRepository
from ..schemas.settings import AppSettingsResponse, NotionSettingsUpdate, OpenAISettingsUpdate, build_settings_response
from .model_service import ModelService
from .notion_service import NotionService


class SettingsService:
    def __init__(self, repository: SettingsRepository, model_service: ModelService, notion_service: NotionService) -> None:
        self._repository = repository
        self._model_service = model_service
        self._notion_service = notion_service

    def get_settings(self) -> AppSettingsResponse:
        return build_settings_response(self._repository.load())

    def update_openai_settings(self, payload: OpenAISettingsUpdate) -> AppSettingsResponse:
        if payload.api_key is None and payload.selected_model is None:
            raise ServiceError(400, "Provide an API key, a model, or both.")

        settings = self._repository.load()
        api_key = payload.api_key if payload.api_key is not None else settings.api_key
        selected_model = payload.selected_model if payload.selected_model is not None else settings.selected_model

        if payload.selected_model and not api_key:
            raise ServiceError(400, "Configure an API key before choosing a model.")
        if payload.selected_model and api_key:
            available_models = self._model_service.list_supported_models(api_key)
            if not any(model.id == payload.selected_model for model in available_models):
                raise ServiceError(400, "The selected model is not available for this backend configuration.")

        self._repository.update(
            api_key=payload.api_key if payload.api_key is not None else MISSING,
            selected_model=selected_model,
        )
        return self.get_settings()

    def update_notion_settings(self, payload: NotionSettingsUpdate) -> AppSettingsResponse:
        current = self._repository.load()
        token = payload.token.strip() if payload.token is not None and payload.token.strip() else current.notion_token
        notes_database_id = payload.notes_database_id.strip() if payload.notes_database_id else None
        progress_database_id = payload.progress_database_id.strip() if payload.progress_database_id else None
        progress_field_map = {key: value for key, value in payload.progress_field_map.items()}
        notes_field_map = {key: value for key, value in payload.notes_field_map.items()}

        if payload.use_notes_for_ai_context and not notes_database_id:
            raise ServiceError(400, "Provide a notes database ID before enabling Notion AI context.")
        if payload.enable_progress_sync and not progress_database_id:
            raise ServiceError(400, "Provide a progress database ID before enabling Notion progress sync.")
        if (notes_database_id or progress_database_id or payload.use_notes_for_ai_context or payload.enable_progress_sync) and not token:
            raise ServiceError(400, "Provide a Notion integration token before saving Notion settings.")

        if token:
            try:
                if notes_database_id:
                    notes_field_map, _ = self._notion_service.validate_notes_settings(token, notes_database_id, notes_field_map)
                if progress_database_id:
                    progress_field_map, _ = self._notion_service.validate_progress_settings(token, progress_database_id, progress_field_map)
            except RuntimeError as error:
                raise ServiceError(400, str(error)) from error

        self._repository.update(
            notion_token=payload.token.strip() if payload.token is not None and payload.token.strip() else MISSING,
            notion_notes_database_id=notes_database_id,
            notion_progress_database_id=progress_database_id,
            notion_use_notes_for_ai_context=payload.use_notes_for_ai_context,
            notion_enable_progress_sync=payload.enable_progress_sync,
            notion_progress_field_map=progress_field_map,
            notion_notes_field_map=notes_field_map,
        )
        return self.get_settings()
