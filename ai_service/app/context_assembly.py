from __future__ import annotations

from typing import Any


def score_context_bundle(
    graph_context: dict[str, Any],
    memory_context: list[dict[str, Any]],
    notion_context: list[dict[str, Any]],
    selected_node_ids: list[str],
    message: str,
) -> float:
    score = 0.3
    if graph_context.get("summaries", {}).get("rootWorkstreams"):
        score += 0.2
    if selected_node_ids:
        score += 0.2
    if memory_context:
        score += 0.1
    if notion_context:
        score += 0.1
    if len(message.split()) >= 6:
        score += 0.1
    return max(0.0, min(1.0, score))


def assemble_context_bundle(
    workflow_context: dict[str, Any],
    memory_context: list[dict[str, Any]],
    notion_context: list[dict[str, Any]],
    workflow: str,
) -> list[dict[str, Any]]:
    bundle: list[dict[str, Any]] = []
    graph_context = workflow_context.get("graphContext", {})

    bundle.append(
        {
            "source": "task-graph",
            "reason": "Canonical workflow graph state",
            "score": 1.0,
            "content": {
                "root": graph_context.get("root", {}),
                "summaries": graph_context.get("summaries", {}),
                "scope": graph_context.get("scope", {}),
            },
        }
    )

    for index, item in enumerate(memory_context[:4]):
        bundle.append(
            {
                "source": "supermemory",
                "reason": "Project-scoped retrieved memory",
                "score": max(0.2, 0.9 - index * 0.1),
                "content": item,
            }
        )

    if workflow in {"knowledge", "reflection"}:
        for index, item in enumerate(notion_context[:4]):
            bundle.append(
                {
                    "source": "notion",
                    "reason": "Knowledge workflow external source",
                    "score": max(0.2, 0.8 - index * 0.1),
                    "content": item,
                }
            )

    return sorted(bundle, key=lambda item: item["score"], reverse=True)
