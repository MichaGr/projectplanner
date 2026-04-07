from __future__ import annotations

from ..core.errors import ServiceError
from ..planner.graph import PlannerEngine
from ..repositories.settings_repository import SettingsRepository
from ..schemas.planner import AIChatRequest, AIChatResponse
from .notion_service import NotionService


class ChatService:
    def __init__(self, repository: SettingsRepository, notion_service: NotionService, planner_engine: PlannerEngine) -> None:
        self._repository = repository
        self._notion_service = notion_service
        self._planner_engine = planner_engine

    def chat(self, payload: AIChatRequest) -> AIChatResponse:
        settings = self._repository.load()
        if not settings.api_key:
            raise ServiceError(400, "Configure the OpenAI API key in Settings before using AI assistance.")

        request_payload = payload
        if settings.notion_use_notes_for_ai_context and settings.notion_token and settings.notion_notes_database_id:
            notion_documents = self._notion_service.fetch_context_documents(
                token=settings.notion_token,
                database_id=settings.notion_notes_database_id,
                message=payload.message,
                context=payload.context,
                snapshot=payload.project,
                notes_field_map=settings.notion_notes_field_map,
            )
            if notion_documents:
                request_payload = payload.model_copy(update={"documents": [*payload.documents, *notion_documents]})

        try:
            result = self._planner_engine.run_chat(request_payload, settings.model_dump())
        except ValueError as error:
            raise ServiceError(400, str(error)) from error
        except Exception as error:
            raise ServiceError(502, f"AI orchestration failed: {error}") from error

        return AIChatResponse(
            message=result.get("response_message", "Prepared a proposal."),
            proposal=result.get("proposal"),
            memoryResult=result.get("memory_result"),
        )
