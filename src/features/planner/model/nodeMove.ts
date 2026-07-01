import type { PlannerEdgeRecord, PlannerNodeRecord, PlannerSnapshot, ScopeId } from './types';
import { getDescendantNodeIds } from './graph-index';
import { getRelativeChildPosition } from '../canvas/flow-model';
import { getNodeScope, isSameScope, uid } from './project';

export type ExtractedNodeSubtree = {
  rootId: string;
  nodeIds: Set<string>;
  nodes: PlannerNodeRecord[];
  edges: PlannerEdgeRecord[];
};

const getAbsoluteNodePositionById = (nodes: readonly PlannerNodeRecord[], nodeId: string): { x: number; y: number } | null => {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const node = byId.get(nodeId);
  if (!node) {
    return null;
  }

  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;

  while (parentId) {
    const parent = byId.get(parentId);
    if (!parent) {
      break;
    }
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }

  return { x, y };
};

export const getScopeInsertPosition = (nodes: readonly PlannerNodeRecord[], scopeId: ScopeId) => {
  const siblingCount = nodes.filter((node) => getNodeScope(node) === scopeId).length;
  return {
    x: 80 + (siblingCount % 3) * 260,
    y: 120 + Math.floor(siblingCount / 3) * 160,
  };
};

export const moveNodeWithinSnapshot = (
  snapshot: PlannerSnapshot,
  nodeId: string,
  destinationGroupId: string | null,
): PlannerSnapshot => {
  const movedNode = snapshot.nodes.find((node) => node.id === nodeId);
  if (!movedNode) {
    return snapshot;
  }

  if (destinationGroupId === (movedNode.parentId ?? null)) {
    return snapshot;
  }

  const descendantIds = new Set(getDescendantNodeIds(snapshot.nodes, nodeId));
  if (destinationGroupId === nodeId || (destinationGroupId && descendantIds.has(destinationGroupId))) {
    return snapshot;
  }

  const absolutePosition = getAbsoluteNodePositionById(snapshot.nodes, nodeId);
  if (!absolutePosition) {
    return snapshot;
  }

  const destinationGroup =
    destinationGroupId === null ? null : snapshot.nodes.find((node) => node.id === destinationGroupId && node.kind === 'group') ?? null;
  if (destinationGroupId && !destinationGroup) {
    return snapshot;
  }

  const nextPosition =
    destinationGroup && destinationGroupId
      ? (() => {
          const groupPosition = getAbsoluteNodePositionById(snapshot.nodes, destinationGroupId);
          return groupPosition ? getRelativeChildPosition(absolutePosition, groupPosition) : movedNode.position;
        })()
      : absolutePosition;

  const nextNodes = snapshot.nodes.map((node) =>
    node.id === nodeId
      ? {
          ...node,
          parentId: destinationGroupId ?? undefined,
          position: nextPosition,
        }
      : node,
  );

  return {
    ...snapshot,
    nodes: nextNodes,
    edges: snapshot.edges.filter((edge) => isSameScope(nextNodes, edge.source, edge.target)),
  };
};

export const extractNodeSubtree = (snapshot: PlannerSnapshot, nodeId: string): ExtractedNodeSubtree | null => {
  const root = snapshot.nodes.find((node) => node.id === nodeId);
  if (!root) {
    return null;
  }

  const nodeIds = new Set([nodeId, ...getDescendantNodeIds(snapshot.nodes, nodeId)]);
  return {
    rootId: nodeId,
    nodeIds,
    nodes: snapshot.nodes.filter((node) => nodeIds.has(node.id)),
    edges: snapshot.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
  };
};

export const removeNodeSubtreeFromSnapshot = (snapshot: PlannerSnapshot, nodeId: string): PlannerSnapshot => {
  const subtree = extractNodeSubtree(snapshot, nodeId);
  if (!subtree) {
    return snapshot;
  }

  return {
    ...snapshot,
    nodes: snapshot.nodes.filter((node) => !subtree.nodeIds.has(node.id)),
    edges: snapshot.edges.filter((edge) => !subtree.nodeIds.has(edge.source) && !subtree.nodeIds.has(edge.target)),
  };
};

const ensureUniqueNodeId = (nodes: readonly PlannerNodeRecord[], proposedId: string, prefix: string) => {
  if (!nodes.some((node) => node.id === proposedId)) {
    return proposedId;
  }

  let nextId = proposedId;
  while (nodes.some((node) => node.id === nextId)) {
    nextId = uid(prefix);
  }
  return nextId;
};

const ensureUniqueEdgeId = (edges: readonly PlannerEdgeRecord[], proposedId: string) => {
  if (!edges.some((edge) => edge.id === proposedId)) {
    return proposedId;
  }

  let nextId = proposedId;
  while (edges.some((edge) => edge.id === nextId)) {
    nextId = uid('edge');
  }
  return nextId;
};

export const insertNodeSubtreeIntoSnapshot = (
  snapshot: PlannerSnapshot,
  subtree: ExtractedNodeSubtree,
  destinationGroupId: string | null,
): { snapshot: PlannerSnapshot; insertedRootId: string; idMap: Map<string, string> } => {
  const destinationGroup =
    destinationGroupId === null ? null : snapshot.nodes.find((node) => node.id === destinationGroupId && node.kind === 'group') ?? null;
  if (destinationGroupId && !destinationGroup) {
    return { snapshot, insertedRootId: subtree.rootId, idMap: new Map([[subtree.rootId, subtree.rootId]]) };
  }

  const nextNodePool = [...snapshot.nodes];
  const idMap = new Map<string, string>();

  for (const node of subtree.nodes) {
    const nextId = ensureUniqueNodeId(nextNodePool, node.id, node.kind === 'group' ? 'group' : 'task');
    idMap.set(node.id, nextId);
    nextNodePool.push({ ...node, id: nextId });
  }

  const insertedRootId = idMap.get(subtree.rootId) ?? subtree.rootId;
  const insertedNodes = subtree.nodes.map((node) => ({
    ...node,
    id: idMap.get(node.id) ?? node.id,
    parentId:
      node.id === subtree.rootId
        ? destinationGroupId ?? undefined
        : node.parentId
          ? idMap.get(node.parentId) ?? node.parentId
          : undefined,
    position: node.id === subtree.rootId ? getScopeInsertPosition(snapshot.nodes, destinationGroupId) : node.position,
  }));

  const nextEdgePool = [...snapshot.edges];
  const insertedEdges = subtree.edges.map((edge) => {
    const nextEdge: PlannerEdgeRecord = {
      id: ensureUniqueEdgeId(nextEdgePool, edge.id),
      source: idMap.get(edge.source) ?? edge.source,
      target: idMap.get(edge.target) ?? edge.target,
    };
    nextEdgePool.push(nextEdge);
    return nextEdge;
  });

  return {
    insertedRootId,
    idMap,
    snapshot: {
      ...snapshot,
      nodes: [...snapshot.nodes, ...insertedNodes],
      edges: [...snapshot.edges, ...insertedEdges],
    },
  };
};
