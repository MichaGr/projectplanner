import { memo } from 'react';
import { BaseEdge, Handle, Position, type Edge, type EdgeProps, type NodeProps } from '@xyflow/react';
import { ToolbarIcon } from '../../../components/ToolbarIcon';
import type { PlannerFlowNode, RenderNodeData } from '../model/types';

const NodeActions = memo(function NodeActions({ data }: { data: RenderNodeData }) {
  return <div className="node-actions nodrag nopan">
    {data.kind === 'task' ? <>
      <button type="button" className="node-actions__button is-complete nodrag nopan" onClick={(event) => { event.stopPropagation(); data.onToggleComplete(); }} disabled={!data.canToggleComplete} aria-label={data.status === 'done' ? 'Mark as incomplete' : 'Mark as complete'} title={data.status === 'done' ? 'Mark as incomplete' : 'Mark as complete'}><ToolbarIcon name="check" /></button>
      <button type="button" className="node-actions__button is-split nodrag nopan" onClick={(event) => { event.stopPropagation(); data.onSplit(); }} disabled={!data.canSplit} aria-label="Split" title="Split"><ToolbarIcon name="device_hub" /></button>
    </> : <button type="button" className="node-actions__button is-open nodrag nopan" onClick={(event) => { event.stopPropagation(); data.onOpen(); }} disabled={!data.canOpen} aria-label="Open" title="Open"><ToolbarIcon name="open_in_new" /></button>}
    <button type="button" className="node-actions__button is-delete nodrag nopan" onClick={(event) => { event.stopPropagation(); data.onDelete(); }} aria-label="Delete" title="Delete"><ToolbarIcon name="close" /></button>
  </div>;
});

const TaskNode = memo(function TaskNode({ data, selected }: NodeProps<PlannerFlowNode>) {
  return <div title={data.title} className={['task-node', data.status === 'done' ? 'is-complete' : '', data.isAvailable ? 'is-available' : '', data.isBlocked ? 'is-blocked' : '', data.isDropTarget ? 'is-drop-target' : '', selected ? 'is-selected' : ''].join(' ')}>
    {selected && data.showActions ? <NodeActions data={data} /> : null}
    <Handle type="target" position={Position.Left} className="handle" />
    <div className="task-node__header"><div className="task-node__eyebrow">Task</div><span className="task-node__indicator" aria-hidden="true" /></div>
    <div className="task-node__title">{data.title}</div>
    <div className="task-node__footer"><span>{data.status === 'done' ? 'Completed' : data.isBlocked ? 'Blocked' : 'Available now'}</span></div>
    <Handle type="source" position={Position.Right} className="handle" />
  </div>;
});

const GroupNode = memo(function GroupNode({ data, selected }: NodeProps<PlannerFlowNode>) {
  return <div title={data.title} className={['group-entry-node', data.isAvailable ? 'is-available' : '', data.isBlocked ? 'is-blocked' : '', selected ? 'is-selected' : '', data.status === 'done' ? 'is-complete' : '', data.isDropTarget ? 'is-drop-target' : ''].join(' ')}>
    {selected && data.showActions ? <NodeActions data={data} /> : null}
    <Handle type="target" position={Position.Left} className="handle" />
    <div className="group-entry-node__header"><div className="group-entry-node__eyebrow"><span>Node Group</span>{data.isEmptyGroup ? <span className="group-entry-node__warning" title="Warning: Node group is empty" aria-label="Warning: Node group is empty"><ToolbarIcon name="warning" /></span> : null}</div><div className="group-entry-node__status">{data.completionLabel}</div></div>
    <div className="group-entry-node__title">{data.title}</div>
    <div className="group-entry-node__progress-row"><div className="group-entry-node__progress-bar" aria-hidden="true"><div className="group-entry-node__progress-fill" style={{ width: `${Math.max(0, Math.min(100, data.progressPercent ?? 0))}%` }} /></div><div className="group-entry-node__metric">{Math.round(data.progressPercent ?? 0)}%</div></div>
    <div className="group-entry-node__hint">{data.childSummary} · Double-click to open</div>
    <Handle type="source" position={Position.Right} className="handle" />
  </div>;
});

const DragPreviewFlowEdge = memo(function DragPreviewFlowEdge({ id, markerEnd, data }: EdgeProps<Edge<{ path?: string }>>) {
  return data?.path ? <BaseEdge id={id} path={data.path} markerEnd={markerEnd} interactionWidth={0} /> : null;
});

export const flowNodeTypes = { plannerTask: TaskNode, plannerGroup: GroupNode };
export const flowEdgeTypes = { dragPreview: DragPreviewFlowEdge };
