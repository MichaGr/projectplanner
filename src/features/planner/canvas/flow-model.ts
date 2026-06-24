import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Edge } from '@xyflow/react';
import type { DragPreviewEdge, PlannerEdgeRecord, PlannerFlowNode, PlannerNodeRecord } from '../model/types';
import type { PlannerGraphIndex } from '../model/graph-index';

export const groupSize = { width: 280, height: 132 };
export const taskSize = { width: 210, height: 88 };

export const getDefaultNodeSize = (node: PlannerNodeRecord) => (node.kind === 'group' ? groupSize : taskSize);

export const getFlowNodeDimensions = (node: PlannerFlowNode) => ({
  width: Number(node.style?.width ?? node.width ?? (node.type === 'plannerGroup' ? groupSize.width : taskSize.width)),
  height: Number(node.style?.height ?? node.height ?? (node.type === 'plannerGroup' ? groupSize.height : taskSize.height)),
});

export const getNodeCenter = (node: PlannerFlowNode) => {
  const { width, height } = getFlowNodeDimensions(node);
  return {
    x: node.position.x + width / 2,
    y: node.position.y + height / 2,
    width,
    height,
  };
};

export const getRectBoundaryPoint = (
  rect: { x: number; y: number; width: number; height: number },
  toward: { x: number; y: number },
) => {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const deltaX = toward.x - centerX;
  const deltaY = toward.y - centerY;

  if (deltaX === 0 && deltaY === 0) {
    return { x: centerX, y: centerY };
  }

  const scaleX = deltaX === 0 ? Number.POSITIVE_INFINITY : rect.width / 2 / Math.abs(deltaX);
  const scaleY = deltaY === 0 ? Number.POSITIVE_INFINITY : rect.height / 2 / Math.abs(deltaY);
  const scale = Math.min(scaleX, scaleY);

  return {
    x: centerX + deltaX * scale,
    y: centerY + deltaY * scale,
  };
};

export const buildDragPreviewPath = (sourceNode: PlannerFlowNode, targetNode: PlannerFlowNode) => {
  const source = getNodeCenter(sourceNode);
  const target = getNodeCenter(targetNode);
  const sourcePoint = getRectBoundaryPoint(
    { x: sourceNode.position.x, y: sourceNode.position.y, width: source.width, height: source.height },
    { x: target.x, y: target.y },
  );
  const targetPoint = getRectBoundaryPoint(
    { x: targetNode.position.x, y: targetNode.position.y, width: target.width, height: target.height },
    { x: source.x, y: source.y },
  );

  return `M ${sourcePoint.x} ${sourcePoint.y} L ${targetPoint.x} ${targetPoint.y}`;
};

export const getRelativeChildPosition = (
  childPosition: { x: number; y: number },
  parentPosition: { x: number; y: number },
): { x: number; y: number } => ({
  x: Math.max(60, childPosition.x - parentPosition.x),
  y: Math.max(80, childPosition.y - parentPosition.y),
});

export const getEdgeIdFromDomElement = (element: Element | null): string | null => {
  if (!element) {
    return null;
  }

  const edgeElement = element.closest('.react-flow__edge') as HTMLElement | null;
  if (!edgeElement) {
    return null;
  }

  const dataId = edgeElement.getAttribute('data-id');
  if (dataId) {
    return dataId;
  }

  const domId = edgeElement.getAttribute('id');
  if (domId?.startsWith('reactflow__edge-')) {
    return domId.slice('reactflow__edge-'.length);
  }

  return null;
};

export const getNodeElementFromDragEvent = (event: MouseEvent | ReactMouseEvent, nodeId: string): HTMLElement | null => {
  const target = event.target;
  if (target instanceof Element) {
    const closestNode = target.closest('.react-flow__node') as HTMLElement | null;
    if (closestNode?.getAttribute('data-id') === nodeId) {
      return closestNode;
    }
  }

  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`) as HTMLElement | null;
  }

  return document.querySelector(`.react-flow__node[data-id="${nodeId}"]`) as HTMLElement | null;
};

export const getRectSampleAxis = (start: number, end: number, maxStep: number) => {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return [start];
  }

  const size = end - start;
  const segmentCount = Math.max(1, Math.ceil(size / maxStep));
  const points: number[] = [];

  for (let index = 0; index <= segmentCount; index += 1) {
    points.push(start + (size * index) / segmentCount);
  }

  return points;
};

export const findEdgeIdIntersectingRect = (rect: DOMRect): string | null => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = Math.max(0, rect.left);
  const right = Math.min(viewportWidth, rect.right);
  const top = Math.max(0, rect.top);
  const bottom = Math.min(viewportHeight, rect.bottom);

  if (right <= left || bottom <= top) {
    return null;
  }

  const sampleXs = getRectSampleAxis(left, right, 18);
  const sampleYs = getRectSampleAxis(top, bottom, 18);

  for (const clientY of sampleYs) {
    for (const clientX of sampleXs) {
      const elements = document.elementsFromPoint(clientX, clientY);
      for (const element of elements) {
        if (element.closest('.react-flow__node')) {
          continue;
        }

        const edgeId = getEdgeIdFromDomElement(element);
        if (edgeId) {
          return edgeId;
        }
      }
    }
  }

  return null;
};

export const buildFlowNodes = (
  graph: PlannerGraphIndex,
  scopeNodes: PlannerNodeRecord[],
  selectedNodeId: string | null,
  selectedNodeIds: string[],
  toolbarNodeId: string | null,
  dropTargetNodeId: string | null,
  onToggleComplete: (nodeId: string) => void,
  onSplit: (nodeId: string) => void,
  onOpen: (nodeId: string) => void,
  onDelete: (nodeId: string) => void,
  previousNodes: readonly PlannerFlowNode[] = [],
): PlannerFlowNode[] => {
  const previousById = new Map(previousNodes.map((node) => [node.id, node] as const));
  return scopeNodes.map((node) => {
    const isComplete = graph.isNodeComplete(node.id);
    const isAvailable = graph.isNodeAvailable(node.id);
    const progress = node.kind === 'group' ? graph.getGroupProgress(node.id) : null;
    const childCount = node.kind === 'group' ? graph.getChildren(node.id).length : null;

    const next = {
      id: node.id,
      position: node.position,
      draggable: true,
      selected: selectedNodeIds.includes(node.id) || node.id === selectedNodeId,
      type: node.kind === 'group' ? 'plannerGroup' : 'plannerTask',
      data: {
        title: node.title,
        kind: node.kind,
        status: node.kind === 'group' ? (isComplete ? 'done' : 'todo') : node.status,
        isAvailable,
        isBlocked: !isAvailable && !isComplete,
        isDropTarget: node.id === dropTargetNodeId,
        isEmptyGroup: node.kind === 'group' ? childCount === 0 : undefined,
        completionLabel:
          node.kind === 'group'
            ? progress && progress.total > 0
              ? `${progress.done}/${progress.total} complete`
              : 'empty group'
            : undefined,
        progressPercent: node.kind === 'group' ? (progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0) : undefined,
        childSummary: node.kind === 'group' ? `${childCount} direct items` : undefined,
        onToggleComplete: () => onToggleComplete(node.id),
        onSplit: () => onSplit(node.id),
        onOpen: () => onOpen(node.id),
        onDelete: () => onDelete(node.id),
        canToggleComplete: node.kind === 'task',
        canSplit: node.kind === 'task',
        canOpen: node.kind === 'group',
        showActions: node.id === toolbarNodeId,
      },
      style: {
        width: node.kind === 'group' ? groupSize.width : node.size?.width ?? getDefaultNodeSize(node).width,
        height: node.kind === 'group' ? groupSize.height : node.size?.height ?? getDefaultNodeSize(node).height,
      },
    } as PlannerFlowNode;
    const previous = previousById.get(node.id);
    if (
      previous &&
      previous.position === next.position &&
      previous.selected === next.selected &&
      previous.type === next.type &&
      previous.style?.width === next.style?.width &&
      previous.style?.height === next.style?.height &&
      previous.data.title === next.data.title &&
      previous.data.status === next.data.status &&
      previous.data.isAvailable === next.data.isAvailable &&
      previous.data.isBlocked === next.data.isBlocked &&
      previous.data.isDropTarget === next.data.isDropTarget &&
      previous.data.isEmptyGroup === next.data.isEmptyGroup &&
      previous.data.completionLabel === next.data.completionLabel &&
      previous.data.progressPercent === next.data.progressPercent &&
      previous.data.childSummary === next.data.childSummary &&
      previous.data.showActions === next.data.showActions
    ) {
      return previous;
    }
    return next;
  });
};

export const buildFlowEdges = (
  edges: PlannerEdgeRecord[],
  selectedEdgeId: string | null,
  insertionEdgeId: string | null,
  dragPreviewEdge: DragPreviewEdge | null,
): Edge[] => {
  const flowEdges: Edge[] = edges.map((edge): Edge => {
    const isInsertionTarget = edge.id === insertionEdgeId;
    const isSelected = edge.id === selectedEdgeId;
    const isHighlighted = isInsertionTarget || isSelected;

    return {
      ...edge,
      animated: isInsertionTarget,
      selectable: true,
      selected: isSelected,
      className: isHighlighted ? 'planner-edge is-insertion-target' : 'planner-edge',
      style: {
        strokeWidth: isHighlighted ? 3.5 : 1.75,
        stroke: isHighlighted ? '#fd6f85' : undefined,
      },
    };
  });

  if (!dragPreviewEdge) {
    return flowEdges;
  }

  flowEdges.push({
    id: '__drag-preview__',
    source: dragPreviewEdge.source,
    target: dragPreviewEdge.target,
    type: 'dragPreview',
    animated: false,
    className: 'planner-edge is-drag-preview',
    data: { path: dragPreviewEdge.path },
    style: {
      strokeWidth: 2.5,
      stroke: '#e1c3ff',
    },
  });

  return flowEdges;
};

