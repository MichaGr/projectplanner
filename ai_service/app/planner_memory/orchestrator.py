from __future__ import annotations

from typing import Any

from ..schemas.memory import ActionType
from ..schemas.planner import AIContextBundle, AIPlannerOutput, AIResolvedIntent
from .agents.consolidation import ConsolidationAgent
from .agents.formatter import FormatterAgent
from .agents.memory_edit import MemoryEditAgent
from .agents.reviewer import ReviewerAgent
from .agents.review_memory import ReviewMemoryAgent
from .agents.rework_graph import ReworkGraphAgent
from .agents.split_task import SplitTaskAgent
from .agents.task_draft import TaskDraftAgent
from .assembler import ContextAssembler
from .contracts import AgentCallContext
from .provider import MemoryProvider


class ActionOrchestrator:
    def __init__(self, llm_factory, assembler: ContextAssembler, provider: MemoryProvider) -> None:
        self._llm_factory = llm_factory
        self._assembler = assembler
        self._provider = provider
        self._agents = {
            "task_draft": TaskDraftAgent(llm_factory),
            "memory_edit": MemoryEditAgent(),
            "reviewer": ReviewerAgent(),
            "formatter": FormatterAgent(),
            "consolidation": ConsolidationAgent(),
            "split_task": SplitTaskAgent(),
            "review_memory": ReviewMemoryAgent(),
            "rework_graph": ReworkGraphAgent(),
        }

    def run(self, request, settings: dict[str, Any]) -> dict[str, Any]:
        action = self._resolve_action(request.message)
        bundle = self._assembler.build_bundle(action, request)
        planner_output = AIPlannerOutput(
            resolvedIntent=AIResolvedIntent(intent=action, confidence="medium", rationale=f"Resolved action {action}."),
            intentSummary=f"Handling {action.replace('_', ' ')}.",
            contextSummary=bundle.scope_summary,
            openQuestions=[],
            contextBundle=AIContextBundle.model_validate(bundle.graph_context),
        )

        agent_name = self._initial_agent(action)
        payload: dict[str, Any] = {}
        warnings: list[str] = []
        proposals = []
        trace: list[dict[str, Any]] = []

        for _ in range(8):
            agent = self._agents[agent_name]
            result = agent.run(
                AgentCallContext(
                    action=action,
                    request=request,
                    bundle=bundle,
                    settings=settings,
                    payload=payload,
                    warnings=warnings,
                    proposals=proposals,
                )
            )
            trace.append({"agent": agent_name, "status": result.status})
            payload = result.payload
            warnings = result.warnings
            proposals = result.proposals

            if result.status == "needs_more_context":
                for retrieval in result.retrieval_requests:
                    targeted = self._provider.retrieve_on_demand(request.projectId, retrieval.query_spec)
                    bundle = self._assembler.add_targeted_context(bundle, targeted)
                agent_name = result.next_agent_hint or agent_name
                continue
            if result.status == "needs_review":
                agent_name = "reviewer"
                continue
            if result.status == "needs_formatting":
                agent_name = "formatter"
                continue
            if result.status == "needs_consolidation":
                agent_name = "consolidation"
                continue
            if result.status == "blocked":
                detail = result.warnings[0] if result.warnings else f"{action} is not available."
                raise ValueError(detail)
            if result.status == "completed":
                committed = self._commit(request.projectId, payload)
                payload.update(committed)
                break

        return {
            "planner_output": planner_output,
            "response_message": payload.get("message", "Prepared a result."),
            "proposal": payload.get("proposal"),
            "memory_result": payload.get("memory_result"),
            "trace": trace,
        }

    def _resolve_action(self, message: str) -> ActionType:
        lowered = message.lower()
        if "completion" in lowered or "acceptance" in lowered or "criteria" in lowered:
            return "define_completion_criteria"
        if "split" in lowered or "subtask" in lowered or "decompose" in lowered or "break down" in lowered:
            return "split_into_subtasks"
        if "create" in lowered or "add task" in lowered or "new task" in lowered or "new node" in lowered:
            return "create_task"
        if "remember" in lowered or "memory" in lowered or "preference" in lowered:
            return "add_update_memory"
        return "describe_node"

    @staticmethod
    def _initial_agent(action: ActionType) -> str:
        if action == "add_update_memory":
            return "memory_edit"
        if action == "review_memory":
            return "review_memory"
        if action == "rework_graph":
            return "rework_graph"
        if action == "split_task":
            return "split_task"
        return "task_draft"

    def _commit(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        created_items = payload.get("created_items", [])
        updated_items = payload.get("updated_items", [])
        review_issues = payload.get("review_issues", [])
        session_summary = payload.get("session_summary")
        preference_proposals = payload.get("preference_proposals", [])

        if created_items:
            self._provider.create_items(project_id, created_items)
        if updated_items:
            self._provider.update_items(project_id, updated_items)
        if review_issues:
            self._provider.create_review_issues(project_id, review_issues)
        if session_summary:
            self._provider.store_session_summary(project_id, session_summary)
        if preference_proposals:
            self._provider.propose_preference_updates(project_id, preference_proposals)
        return payload
