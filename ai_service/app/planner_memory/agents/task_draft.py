from __future__ import annotations

import uuid
from datetime import UTC, datetime

from ...planner.context_builder import (
    document_context_text,
    find_target_node,
    next_position,
    resolve_draft_dependencies,
    resolve_parent_id,
    worker_context_text,
)
from ...planner.types import DraftDependency, DraftNode, DraftNodeList, DraftSplitPlan, DraftText
from ...schemas.memory import AgentResult, MemoryRetrievalRequest
from ...schemas.planner import (
    AIContextBundle,
    AIPlannerOutput,
    AIResolvedIntent,
    CreateEdgePayload,
    CreateEdgesOperation,
    CreateGroupOperation,
    CreateGroupPayload,
    CreateTaskPayload,
    CreateTasksOperation,
    Position,
    Size,
    UpdateNodeFieldsOperation,
)
from ..contracts import AgentCallContext


class TaskDraftAgent:
    def __init__(self, llm_factory) -> None:
        self._llm_factory = llm_factory

    def run(self, context: AgentCallContext) -> AgentResult:
        if context.action == "create_task":
            return self._create_task(context)
        if context.action == "describe_node":
            return self._describe_node(context)
        if context.action == "define_completion_criteria":
            return self._completion_criteria(context)
        if context.action in {"split_task", "split_into_subtasks"}:
            return self._split_task(context)
        return AgentResult(status="blocked", payload={}, warnings=[f"Unsupported task action: {context.action}"])

    def _create_task(self, context: AgentCallContext) -> AgentResult:
        request = context.request
        target_title = request.context.targetTitle
        parent_id = resolve_parent_id(request)
        if not context.bundle.targeted_context and ("context" in request.message.lower() or "memory" in request.message.lower()):
            linked_node_ids = [request.context.targetId] if request.context.targetId else []
            return AgentResult(
                status="needs_more_context",
                payload=context.payload,
                retrieval_requests=[
                    MemoryRetrievalRequest(
                        purpose="Fetch additional memory linked to the current scope before drafting tasks.",
                        query_spec={"linked_node_ids": linked_node_ids},
                    )
                ],
                next_agent_hint="task_draft",
            )

        try:
            llm = self._llm_factory(context.settings)
            planner_output = AIPlannerOutput(
                resolvedIntent=AIResolvedIntent(intent="create_task", confidence="medium", rationale="Drafting new tasks."),
                intentSummary=f"Create tasks for {target_title}.",
                contextSummary=context.bundle.scope_summary,
                openQuestions=[],
                contextBundle=AIContextBundle.model_validate(context.bundle.graph_context),
            )
            draft = llm.with_structured_output(DraftNodeList).invoke(
                [
                    (
                        "system",
                        "Create 2 to 4 concise project-planning tasks. Each task must have a concrete deliverable and clear completion criteria.",
                    ),
                    (
                        "human",
                        f"Context title: {target_title}\nUser request: {request.message}\n"
                        f"{worker_context_text(planner_output)}\n{document_context_text(request.documents)}",
                    ),
                ]
            )
            nodes = draft.nodes
            summary = draft.summary
            change_plan = draft.changePlan or [f"Add new tasks in the {target_title} scope."]
        except Exception:
            nodes = [
                DraftNode(
                    title=f"Plan {target_title}",
                    description=f"Define the scoped execution plan for {target_title}.",
                    completionCriteria="A written execution plan exists with concrete steps and deliverables.",
                ),
                DraftNode(
                    title=f"Execute {target_title}",
                    description=f"Produce the main deliverable for {target_title}.",
                    completionCriteria="The requested deliverable exists in a reviewable form.",
                ),
            ]
            summary = f"Create new tasks in the {target_title} scope."
            change_plan = [summary]

        tasks = [
            CreateTaskPayload(
                id=f"task-{uuid.uuid4().hex[:8]}",
                title=node.title,
                description=node.description,
                completionCriteria=node.completionCriteria,
                parentId=parent_id,
                position=next_position(request, parent_id, index),
                tags=[],
            )
            for index, node in enumerate(nodes)
        ]
        return AgentResult(
            status="needs_review",
            payload={
                "action_type": "create_task",
                "summary": summary,
                "message": f"Prepared {len(tasks)} task proposals.",
                "operations": [CreateTasksOperation(tasks=tasks)],
                "change_plan": change_plan,
                "affected_targets": [task.title for task in tasks],
                "proposed_task_titles": [task.title for task in tasks],
                "created_at": datetime.now(UTC).isoformat(),
            },
        )

    def _describe_node(self, context: AgentCallContext) -> AgentResult:
        request = context.request
        target_node = find_target_node(request)
        title = target_node.title if target_node else request.project.root.title
        try:
            llm = self._llm_factory(context.settings)
            draft = llm.with_structured_output(DraftText).invoke(
                [
                    (
                        "system",
                        "Write one concise but specific project-planning description for the provided target.",
                    ),
                    (
                        "human",
                        f"Target title: {title}\nUser request: {request.message}\n"
                        f"Existing description: {(target_node.description if target_node else request.project.root.description) or '(empty)'}",
                    ),
                ]
            )
            content = draft.content
            change_plan = draft.changePlan or [f"Rewrite the description for {title}."]
        except Exception:
            content = f"Produce a concrete deliverable for {title.lower()} with clear scope and a visible outcome."
            change_plan = [f"Strengthen the description for {title}."]
        return AgentResult(
            status="needs_formatting",
            payload={
                "action_type": "describe_node",
                "summary": f"Draft a stronger description for {title}.",
                "message": "Prepared a description update for review.",
                "operations": [
                    UpdateNodeFieldsOperation(
                        targetType="root" if request.context.targetType == "root" else "node",
                        targetId=request.context.targetId or "root",
                        fields={"description": content},
                    )
                ],
                "change_plan": change_plan,
                "affected_targets": [title],
            },
        )

    def _completion_criteria(self, context: AgentCallContext) -> AgentResult:
        request = context.request
        target_node = find_target_node(request)
        title = target_node.title if target_node else request.project.root.title
        try:
            llm = self._llm_factory(context.settings)
            draft = llm.with_structured_output(DraftText).invoke(
                [
                    (
                        "system",
                        "Write concise but specific completion criteria for the provided target.",
                    ),
                    (
                        "human",
                        f"Target title: {title}\nUser request: {request.message}\n"
                        f"Existing criteria: {(target_node.completionCriteria if target_node else request.project.root.completionCriteria) or '(empty)'}",
                    ),
                ]
            )
            content = draft.content
            change_plan = draft.changePlan or [f"Replace vague completion criteria on {title}."]
        except Exception:
            content = f"Completion is clear when {title.lower()} has a documented outcome and no unresolved blockers."
            change_plan = [f"Make completion criteria for {title} more specific."]
        return AgentResult(
            status="needs_formatting",
            payload={
                "action_type": "define_completion_criteria",
                "summary": f"Draft completion criteria for {title}.",
                "message": "Prepared completion criteria for review.",
                "operations": [
                    UpdateNodeFieldsOperation(
                        targetType="root" if request.context.targetType == "root" else "node",
                        targetId=request.context.targetId or "root",
                        fields={"completionCriteria": content},
                    )
                ],
                "change_plan": change_plan,
                "affected_targets": [title],
            },
        )

    def _split_task(self, context: AgentCallContext) -> AgentResult:
        request = context.request
        target_node = find_target_node(request)
        if not target_node or target_node.kind != "task":
            return AgentResult(status="blocked", payload={}, warnings=["Split requires a selected task node."])
        try:
            llm = self._llm_factory(context.settings)
            draft = llm.with_structured_output(DraftSplitPlan).invoke(
                [
                    (
                        "system",
                        "Break the task into 3 to 5 meaningful subtasks with concrete deliverables and prerequisite dependencies.",
                    ),
                    (
                        "human",
                        f"Task title: {target_node.title}\nDescription: {target_node.description}\nUser request: {request.message}",
                    ),
                ]
            )
            nodes = draft.nodes
            dependency_drafts = draft.dependencies
            summary = draft.summary
            change_plan = draft.changePlan or [f"Create a breakdown group for {target_node.title}."]
            dependency_summary = draft.dependencySummary
        except Exception:
            nodes = [
                DraftNode(title=f"Scope {target_node.title}", description="", completionCriteria="A scoped plan exists."),
                DraftNode(title=f"Implement {target_node.title}", description="", completionCriteria="The main deliverable exists."),
                DraftNode(title=f"Review {target_node.title}", description="", completionCriteria="Feedback is resolved."),
            ]
            dependency_drafts = [
                DraftDependency(sourceTitle=f"Scope {target_node.title}", targetTitle=f"Implement {target_node.title}"),
                DraftDependency(sourceTitle=f"Implement {target_node.title}", targetTitle=f"Review {target_node.title}"),
            ]
            summary = f"Split {target_node.title} into a new node group with subtasks."
            change_plan = [summary]
            dependency_summary = ""

        group_id = f"group-{uuid.uuid4().hex[:8]}"
        group = CreateGroupOperation(
            group=CreateGroupPayload(
                id=group_id,
                title=f"{target_node.title} breakdown",
                description=f"AI-generated decomposition for {target_node.title}.",
                completionCriteria="All proposed subtasks are complete.",
                parentId=target_node.parentId,
                position=Position(x=target_node.position.x + 80, y=target_node.position.y + 80),
                tags=target_node.tags,
                size=Size(width=320, height=170),
            )
        )
        tasks = CreateTasksOperation(
            tasks=[
                CreateTaskPayload(
                    id=f"task-{uuid.uuid4().hex[:8]}",
                    title=node.title,
                    description=node.description,
                    completionCriteria=node.completionCriteria,
                    parentId=group_id,
                    position=Position(x=80 + index * 110, y=120),
                    tags=target_node.tags,
                )
                for index, node in enumerate(nodes)
            ]
        )
        child_edges, explanations = resolve_draft_dependencies(dependency_drafts, tasks.tasks)
        edges = CreateEdgesOperation(
            edges=[CreateEdgePayload(id=f"edge-{uuid.uuid4().hex[:8]}", source=group_id, target=target_node.id), *child_edges]
        )
        combined_plan = list(change_plan)
        if dependency_summary:
            combined_plan.append(dependency_summary)
        combined_plan.extend(explanations)
        return AgentResult(
            status="needs_formatting",
            payload={
                "action_type": "split_into_subtasks",
                "summary": summary,
                "message": "Prepared a new node group plus subtasks for review.",
                "operations": [group, tasks, edges],
                "change_plan": combined_plan,
                "affected_targets": [target_node.title, group.group.title, *[task.title for task in tasks.tasks]],
            },
        )
