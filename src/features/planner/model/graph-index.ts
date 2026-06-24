import type { PlannerEdgeRecord, PlannerNodeRecord, ScopeId } from './types';

const ROOT_SCOPE = '__root__';
const scopeKey = (scopeId: ScopeId | undefined) => scopeId ?? ROOT_SCOPE;

export type GroupProgress = { done: number; total: number };

export type PlannerGraphIndex = {
  nodesById: ReadonlyMap<string, PlannerNodeRecord>;
  getChildren(nodeId: string): readonly PlannerNodeRecord[];
  getDescendantTaskIds(nodeId: string): readonly string[];
  getScopeNodes(scopeId: ScopeId): readonly PlannerNodeRecord[];
  getScopeEdges(scopeId: ScopeId): readonly PlannerEdgeRecord[];
  isNodeComplete(nodeId: string): boolean;
  isNodeAvailable(nodeId: string): boolean;
  getGroupProgress(nodeId: string): GroupProgress;
};

export const createPlannerGraphIndex = (
  nodes: readonly PlannerNodeRecord[],
  edges: readonly PlannerEdgeRecord[],
): PlannerGraphIndex => {
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const childrenByParent = new Map<string, PlannerNodeRecord[]>();
  const nodesByScope = new Map<string, PlannerNodeRecord[]>();
  const incomingByTarget = new Map<string, PlannerEdgeRecord[]>();

  for (const node of nodes) {
    const parentKey = scopeKey(node.parentId);
    const children = childrenByParent.get(parentKey) ?? [];
    children.push(node);
    childrenByParent.set(parentKey, children);
    nodesByScope.set(parentKey, children);
  }

  for (const edge of edges) {
    const incoming = incomingByTarget.get(edge.target) ?? [];
    incoming.push(edge);
    incomingByTarget.set(edge.target, incoming);
  }

  const descendantTaskIds = new Map<string, readonly string[]>();
  const completion = new Map<string, boolean>();
  const availability = new Map<string, boolean>();

  const getChildren = (nodeId: string) => childrenByParent.get(nodeId) ?? [];

  const getDescendantTaskIds = (nodeId: string): readonly string[] => {
    const cached = descendantTaskIds.get(nodeId);
    if (cached) return cached;

    const result = getChildren(nodeId).flatMap((child) =>
      child.kind === 'task' ? [child.id] : [...getDescendantTaskIds(child.id)],
    );
    descendantTaskIds.set(nodeId, result);
    return result;
  };

  const isNodeComplete = (nodeId: string): boolean => {
    const cached = completion.get(nodeId);
    if (cached !== undefined) return cached;

    const node = nodesById.get(nodeId);
    if (!node) return false;
    const result =
      node.kind === 'task'
        ? node.status === 'done'
        : getDescendantTaskIds(nodeId).length > 0 && getDescendantTaskIds(nodeId).every(isNodeComplete);
    completion.set(nodeId, result);
    return result;
  };

  const getAncestorGroupIds = (nodeId: string): string[] => {
    const result: string[] = [];
    let parentId = nodesById.get(nodeId)?.parentId;
    while (parentId) {
      result.push(parentId);
      parentId = nodesById.get(parentId)?.parentId;
    }
    return result;
  };

  const isNodeAvailable = (nodeId: string): boolean => {
    const cached = availability.get(nodeId);
    if (cached !== undefined) return cached;

    const node = nodesById.get(nodeId);
    if (!node || isNodeComplete(nodeId)) return false;

    const directBlockers = incomingByTarget.get(nodeId) ?? [];
    const inheritedBlockers =
      node.kind === 'task'
        ? getAncestorGroupIds(nodeId).flatMap((groupId) => incomingByTarget.get(groupId) ?? [])
        : [];
    const result = [...directBlockers, ...inheritedBlockers].every((edge) => isNodeComplete(edge.source));
    availability.set(nodeId, result);
    return result;
  };

  const getGroupProgress = (nodeId: string): GroupProgress => {
    const taskIds = getDescendantTaskIds(nodeId);
    return { done: taskIds.filter(isNodeComplete).length, total: taskIds.length };
  };

  const getScopeNodes = (scopeId: ScopeId) => nodesByScope.get(scopeKey(scopeId)) ?? [];
  const getScopeEdges = (scopeId: ScopeId) => {
    const scopedIds = new Set(getScopeNodes(scopeId).map((node) => node.id));
    return edges.filter((edge) => scopedIds.has(edge.source) && scopedIds.has(edge.target));
  };

  return {
    nodesById,
    getChildren,
    getDescendantTaskIds,
    getScopeNodes,
    getScopeEdges,
    isNodeComplete,
    isNodeAvailable,
    getGroupProgress,
  };
};

export const getGroupPath = (nodes: readonly PlannerNodeRecord[], groupId: string): PlannerNodeRecord[] => {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const path: PlannerNodeRecord[] = [];
  let current = byId.get(groupId);
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
};

export const getDescendantNodeIds = (nodes: readonly PlannerNodeRecord[], nodeId: string): string[] => {
  const childrenByParent = new Map<string, PlannerNodeRecord[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }

  const result: string[] = [];
  const stack = [...(childrenByParent.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const node = stack.shift()!;
    result.push(node.id);
    stack.unshift(...(childrenByParent.get(node.id) ?? []));
  }
  return result;
};

export const wouldCreateCycle = (
  edges: readonly PlannerEdgeRecord[],
  source: string,
  target: string,
): boolean => {
  if (source === target) return true;

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }

  const stack = [target];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === source) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return false;
};
