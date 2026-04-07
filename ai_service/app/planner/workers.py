from __future__ import annotations

import uuid
from typing import Any, Callable

from ..schemas.planner import (
    AIResolvedIntent,
    AIPlannerOutput,
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
from .context_builder import (
    build_context_bundle,
    coerce_planner_output,
    coerce_request,
    document_context_text,
    fallback_intent,
    find_target_node,
    next_position,
    planner_prompt,
    resolve_draft_dependencies,
    resolve_parent_id,
    worker_context_text,
)
from .types import DraftDependency, DraftNode, DraftNodeList, DraftSplitPlan, DraftText, OrchestrationState, PlannerDecision


class PlannerWorkers:
    def __init__(self, llm_factory: Callable[[dict[str, Any]], Any]) -> None:
        self._llm_factory = llm_factory

    def planner_node(self, state: OrchestrationState) -> OrchestrationState:
        request = coerce_request(state["request"])
        context_bundle = build_context_bundle(request)
        intent_hint = fallback_intent(request.message)

        try:
            llm = self._llm_factory(state["settings"])
            decision = llm.with_structured_output(PlannerDecision).invoke(
                [
                    (
                        "system",
                        "Interpret the user's goal for a project-planning assistant. "
                        "Choose exactly one intent: describe_node, define_completion_criteria, create_nodes, split_into_subtasks. "
                        "Summarize intent and context, and list only concrete open questions when the request is ambiguous. "
                        "For split_into_subtasks, explicitly think about prerequisite stages, execution order, and which work can stay parallel.",
                    ),
                    ("human", planner_prompt(request, context_bundle)),
                ]
            )
            planner_output = AIPlannerOutput(
                resolvedIntent=AIResolvedIntent(
                    intent=decision.intent,
                    confidence=decision.confidence,
                    rationale=f"Planner inferred {decision.intent} from the request and graph context.",
                ),
                intentSummary=decision.intentSummary,
                contextSummary=decision.contextSummary,
                openQuestions=decision.questions,
                contextBundle=context_bundle,
            )
        except Exception:
            planner_output = AIPlannerOutput(
                resolvedIntent=AIResolvedIntent(
                    intent=intent_hint,
                    confidence="medium",
                    rationale="Fallback planner intent based on the user's wording.",
                ),
                intentSummary=f"Interpreting this as {intent_hint.replace('_', ' ')} for {request.context.targetTitle}.",
                contextSummary=context_bundle.scopeSummary,
                openQuestions=[],
                contextBundle=context_bundle,
            )

        return {"planner_output": planner_output}

    def supervisor_node(self, state: OrchestrationState) -> OrchestrationState:
        planner_output = coerce_planner_output(state["planner_output"])
        return {"intent": planner_output.resolvedIntent.intent}

    def describe_node_node(self, state: OrchestrationState) -> OrchestrationState:
        request = coerce_request(state["request"])
        planner_output = coerce_planner_output(state["planner_output"])
        target_node = find_target_node(request)
        title = target_node.title if target_node else request.project.root.title

        try:
            llm = self._llm_factory(state["settings"])
            draft = llm.with_structured_output(DraftText).invoke(
                [
                    (
                        "system",
                        "Write one concise but specific project-planning description for the provided target. "
                        "The description must name a concrete deliverable, artifact, or outcome, not just a vague intention.",
                    ),
                    (
                        "human",
                        f"Target title: {title}\nUser request: {request.message}\n"
                        f"Existing description: {(target_node.description if target_node else request.project.root.description) or '(empty)'}\n"
                        f"{worker_context_text(planner_output)}\n{document_context_text(request.documents)}",
                    ),
                ]
            )
            content = draft.content
            change_plan = draft.changePlan or [f"Rewrite the description for {title} to reflect the clarified goal."]
        except Exception:
            content = f"Produce a concrete deliverable for {title.lower()}, with clear scope, owner-ready boundaries, and a visible outcome."
            change_plan = [f"Strengthen the description for {title}."]

        operation = UpdateNodeFieldsOperation(
            targetType="root" if request.context.targetType == "root" else "node",
            targetId=request.context.targetId or "root",
            fields={"description": content},
        )
        return {
            "worker_output": {
                "summary": f"Draft a stronger description for {title}.",
                "message": "Prepared a description update for review.",
                "operations": [operation],
                "change_plan": change_plan,
                "affected_targets": [title],
            }
        }

    def completion_criteria_node(self, state: OrchestrationState) -> OrchestrationState:
        request = coerce_request(state["request"])
        planner_output = coerce_planner_output(state["planner_output"])
        target_node = find_target_node(request)
        title = target_node.title if target_node else request.project.root.title

        try:
            llm = self._llm_factory(state["settings"])
            draft = llm.with_structured_output(DraftText).invoke(
                [
                    (
                        "system",
                        "Write concise but specific completion criteria for the provided target. "
                        "The criteria must describe a concrete deliverable or observable finished state.",
                    ),
                    (
                        "human",
                        f"Target title: {title}\nUser request: {request.message}\n"
                        f"Existing criteria: {(target_node.completionCriteria if target_node else request.project.root.completionCriteria) or '(empty)'}\n"
                        f"{worker_context_text(planner_output)}\n{document_context_text(request.documents)}",
                    ),
                ]
            )
            content = draft.content
            change_plan = draft.changePlan or [f"Replace vague completion criteria on {title} with concrete checks."]
        except Exception:
            content = f"Completion is clear when {title.lower()} has a documented outcome, an owner-ready scope, and no unresolved blockers."
            change_plan = [f"Make completion criteria for {title} more specific."]

        operation = UpdateNodeFieldsOperation(
            targetType="root" if request.context.targetType == "root" else "node",
            targetId=request.context.targetId or "root",
            fields={"completionCriteria": content},
        )
        return {
            "worker_output": {
                "summary": f"Draft completion criteria for {title}.",
                "message": "Prepared completion criteria for review.",
                "operations": [operation],
                "change_plan": change_plan,
                "affected_targets": [title],
            }
        }

    def create_nodes_node(self, state: OrchestrationState) -> OrchestrationState:
        request = coerce_request(state["request"])
        planner_output = coerce_planner_output(state["planner_output"])
        parent_id = resolve_parent_id(request)
        target_title = request.context.targetTitle

        try:
            llm = self._llm_factory(state["settings"])
            draft = llm.with_structured_output(DraftNodeList).invoke(
                [
                    (
                        "system",
                        "Create 2 to 4 concise project-planning tasks based on the user's request and graph context. "
                        "Every task must have a clear deliverable. Return standalone task titles plus short descriptions "
                        "that name the artifact/outcome and completion criteria that describe what exists when the task is done.",
                    ),
                    (
                        "human",
                        f"Context title: {target_title}\nContext type: {request.context.targetType}\n"
                        f"User request: {request.message}\n{worker_context_text(planner_output)}\n{document_context_text(request.documents)}",
                    ),
                ]
            )
            nodes = draft.nodes or [
                DraftNode(title="Define scope", description="", completionCriteria=""),
                DraftNode(title="Implement work", description="Produce the main deliverable for this work item.", completionCriteria="A concrete deliverable exists and is ready for review."),
            ]
            summary = draft.summary
            change_plan = draft.changePlan or [
                f"Add new tasks in the {target_title} context.",
                "Keep them aligned with nearby scope work and blockers.",
            ]
        except Exception:
            nodes = [
                DraftNode(
                    title=f"Plan {target_title}",
                    description=f"Produce a scoped execution plan for {target_title}.",
                    completionCriteria="A written plan exists with scope, sequence, and owners.",
                ),
                DraftNode(
                    title=f"Execute {target_title}",
                    description=f"Produce the primary deliverable for {target_title}.",
                    completionCriteria="The requested deliverable exists in a reviewable form.",
                ),
                DraftNode(
                    title=f"Review {target_title}",
                    description=f"Produce review feedback and final approval notes for {target_title}.",
                    completionCriteria="Review comments are resolved and approval notes are captured.",
                ),
            ]
            summary = f"Create new tasks in the {target_title} context."
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

        return {
            "worker_output": {
                "summary": summary,
                "message": f"Prepared {len(tasks)} new task proposals.",
                "operations": [CreateTasksOperation(tasks=tasks)],
                "change_plan": change_plan,
                "affected_targets": [task.title for task in tasks],
            }
        }

    def split_into_subtasks_node(self, state: OrchestrationState) -> OrchestrationState:
        request = coerce_request(state["request"])
        planner_output = coerce_planner_output(state["planner_output"])
        target_node = find_target_node(request)
        if not target_node or target_node.kind != "task":
            raise ValueError("Split requires a selected task node.")

        try:
            llm = self._llm_factory(state["settings"])
            draft = llm.with_structured_output(DraftSplitPlan).invoke(
                [
                    (
                        "system",
                        "Break the task into 3 to 5 meaningful subtasks for a project planner. "
                        "Every subtask must have a concrete deliverable and a completion criterion with a visible outcome. "
                        "Also return the prerequisite relationships between those subtasks as a minimal DAG: only add a dependency "
                        "when one subtask truly must finish before another can start. Bias toward setup or research tasks feeding "
                        "analysis, estimation, strategy, and final synthesis tasks. Preserve parallelism when justified.",
                    ),
                    (
                        "human",
                        f"Task title: {target_node.title}\nDescription: {target_node.description}\n"
                        f"User request: {request.message}\n{worker_context_text(planner_output)}\n{document_context_text(request.documents)}",
                    ),
                ]
            )
            nodes = draft.nodes or [DraftNode(title="Plan subtasks"), DraftNode(title="Build subtasks"), DraftNode(title="Review subtasks")]
            summary = draft.summary
            dependency_drafts = draft.dependencies
            dependency_summary = draft.dependencySummary.strip()
            change_plan = draft.changePlan or [
                f"Create a breakdown group for {target_node.title}.",
                "Place meaningful subtasks inside the new group with clear deliverables.",
                "Add only the prerequisite edges needed to express execution order.",
                "Link the new group back to the original task as a dependency.",
            ]
        except Exception:
            nodes = [
                DraftNode(
                    title=f"Scope {target_node.title}",
                    description=f"Produce the scoped breakdown and delivery plan for {target_node.title}.",
                    completionCriteria="A written breakdown exists with deliverables and ownership.",
                ),
                DraftNode(
                    title=f"Implement {target_node.title}",
                    description=f"Produce the main deliverable required for {target_node.title}.",
                    completionCriteria="The main deliverable exists and is ready for review.",
                ),
                DraftNode(
                    title=f"Review {target_node.title}",
                    description=f"Produce review feedback and sign-off notes for {target_node.title}.",
                    completionCriteria="Feedback is captured, resolved, and approval is documented.",
                ),
            ]
            summary = f"Split {target_node.title} into a new node group with subtasks."
            change_plan = [
                f"Create a breakdown group for {target_node.title}.",
                "Add subtasks beneath that group with concrete deliverables.",
                "Make implementation depend on scoping, and review depend on implementation.",
                "Connect the group to the original task.",
            ]
            dependency_drafts = [
                DraftDependency(
                    sourceTitle=f"Scope {target_node.title}",
                    targetTitle=f"Implement {target_node.title}",
                    rationale="The main deliverable should follow the scoped breakdown and plan.",
                ),
                DraftDependency(
                    sourceTitle=f"Implement {target_node.title}",
                    targetTitle=f"Review {target_node.title}",
                    rationale="Review starts after the main deliverable exists.",
                ),
            ]
            dependency_summary = "Scoping comes first, implementation depends on the agreed plan, and review waits for a completed deliverable."

        group_id = f"group-{uuid.uuid4().hex[:8]}"
        group = CreateGroupOperation(
            group=CreateGroupPayload(
                id=group_id,
                title=f"{target_node.title} breakdown",
                description=f"AI-generated decomposition for {target_node.title}.",
                completionCriteria="All proposed subtasks are complete and ready to support the parent task.",
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

        child_edges, child_edge_explanations = resolve_draft_dependencies(dependency_drafts, tasks.tasks)
        dependency = CreateEdgesOperation(
            edges=[
                CreateEdgePayload(id=f"edge-{uuid.uuid4().hex[:8]}", source=group_id, target=target_node.id),
                *child_edges,
            ]
        )

        combined_change_plan = list(change_plan)
        if dependency_summary:
            combined_change_plan.append(dependency_summary)
        combined_change_plan.extend(child_edge_explanations)

        return {
            "worker_output": {
                "summary": summary,
                "message": "Prepared a new node group plus subtasks for review.",
                "operations": [group, tasks, dependency],
                "change_plan": combined_change_plan,
                "affected_targets": [target_node.title, group.group.title, *[task.title for task in tasks.tasks]],
            }
        }
