from __future__ import annotations

from typing import Any

from langchain_openai import ChatOpenAI
from openai import OpenAI


class OpenAIModelClient:
    def list_models(self, api_key: str) -> list[Any]:
        client = OpenAI(api_key=api_key)
        models = client.models.list()
        return list(models.data)


def build_chat_model(settings: dict[str, Any]) -> ChatOpenAI:
    api_key = settings.get("api_key")
    model_name = settings.get("selected_model") or "gpt-4.1-mini"
    if not api_key:
        raise ValueError("OpenAI API key is not configured on the backend.")
    return ChatOpenAI(api_key=api_key, model=model_name, temperature=0.2)
