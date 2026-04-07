from __future__ import annotations

from ..core.errors import ServiceError
from ..integrations.openai_client import OpenAIModelClient
from ..schemas.settings import ModelOption


class ModelService:
    def __init__(self, client: OpenAIModelClient) -> None:
        self._client = client

    @staticmethod
    def is_supported_model(model_id: str) -> bool:
        blocked_prefixes = ("omni-moderation", "text-embedding", "whisper", "tts", "dall-e", "babbage", "davinci")
        if model_id.startswith(blocked_prefixes):
            return False
        return model_id.startswith(("gpt-", "o1", "o3", "o4"))

    def list_supported_models(self, api_key: str) -> list[ModelOption]:
        try:
            models = self._client.list_models(api_key)
        except Exception as error:
            raise ServiceError(502, f"Could not load models from OpenAI: {error}") from error

        filtered = [
            ModelOption(id=model.id, label=model.id, owned_by=getattr(model, "owned_by", None))
            for model in models
            if self.is_supported_model(model.id)
        ]
        filtered.sort(key=lambda model: model.id)
        return filtered
