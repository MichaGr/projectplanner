import asyncio

from app.context_assembly import assemble_context_bundle, score_context_bundle
from app.memory_policy import classify_memory
from app.main import infer_intent_mode_workflow


def test_infer_reflection_workflow():
    intent, mode, workflow = infer_intent_mode_workflow("Reflect on the architecture bottlenecks")
    assert intent == "reflect"
    assert mode == "analyze"
    assert workflow == "reflection"


def test_memory_policy_rejects_rejected_content():
    result = classify_memory("planning", "create_tasks", "rejected", "Rejected draft")
    assert result["category"] == "rejected"
    assert result["shouldStore"] is False


def test_context_bundle_scoring_and_sources():
    workflow_context = {
        "graphContext": {
            "root": {"title": "Main Graph"},
            "summaries": {"rootWorkstreams": [{"id": "x", "title": "X", "kind": "task"}]},
            "scope": {"activeScopeTitle": "Main Graph"},
        }
    }
    memory_context = [{"summary": "Known preference"}]
    notion_context = [{"id": "page-1", "object": "page"}]
    bundle = assemble_context_bundle(workflow_context, memory_context, notion_context, "reflection")
    assert bundle[0]["source"] == "task-graph"
    score = score_context_bundle(workflow_context["graphContext"], memory_context, notion_context, ["node-1"], "Help me plan this workstream")
    assert score >= 0.8
