import type { GraphOperationRequest } from '../../../api';
import type {
  InteractiveDraft,
  InteractiveDraftFields,
  InteractiveDraftMap,
  PlannerNodeRecord,
  PlannerSnapshot,
} from '../model/types';

export const getDraftTargetKey = (targetType: InteractiveDraft['targetType'], targetId: string) => `${targetType}:${targetId}`;

export const applyGraphOperationsToSnapshot = (
  snapshot: PlannerSnapshot,
  operations: GraphOperationRequest[],
): PlannerSnapshot =>
  operations.reduce<PlannerSnapshot>((current, operation) => {
    if (operation.type === 'replace_graph') {
      return operation.project as PlannerSnapshot;
    }
    if (operation.type === 'update_root') {
      return { ...current, root: operation.root as PlannerSnapshot['root'] };
    }
    if (operation.type === 'upsert_nodes') {
      const nextNodesById = new Map(current.nodes.map((node) => [node.id, node] as const));
      for (const rawNode of operation.nodes) {
        const node = rawNode as PlannerNodeRecord;
        nextNodesById.set(node.id, node);
      }
      return { ...current, nodes: [...nextNodesById.values()] };
    }
    if (operation.type === 'delete_nodes') {
      const deletedNodeIds = new Set(operation.nodeIds);
      return {
        ...current,
        nodes: current.nodes.filter((node) => !deletedNodeIds.has(node.id)),
        edges: current.edges.filter((edge) => !deletedNodeIds.has(edge.source) && !deletedNodeIds.has(edge.target)),
      };
    }
    if (operation.type === 'upsert_edges') {
      const nextEdgesById = new Map(current.edges.map((edge) => [edge.id, edge] as const));
      for (const rawEdge of operation.edges) {
        nextEdgesById.set((rawEdge as { id: string }).id, rawEdge as PlannerSnapshot['edges'][number]);
      }
      return { ...current, edges: [...nextEdgesById.values()] };
    }
    const deletedEdgeIds = new Set(operation.edgeIds);
    return { ...current, edges: current.edges.filter((edge) => !deletedEdgeIds.has(edge.id)) };
  }, snapshot);

export const buildGraphOperations = (
  previousSnapshot: PlannerSnapshot,
  nextSnapshot: PlannerSnapshot,
): GraphOperationRequest[] => {
  const operations: GraphOperationRequest[] = [];

  if (JSON.stringify(previousSnapshot.root) !== JSON.stringify(nextSnapshot.root)) {
    operations.push({ type: 'update_root', root: nextSnapshot.root });
  }

  const previousNodes = new Map(previousSnapshot.nodes.map((node) => [node.id, node] as const));
  const nextNodes = new Map(nextSnapshot.nodes.map((node) => [node.id, node] as const));
  const upsertNodes = nextSnapshot.nodes.filter((node) => JSON.stringify(previousNodes.get(node.id)) !== JSON.stringify(node));
  const deletedNodeIds = previousSnapshot.nodes.filter((node) => !nextNodes.has(node.id)).map((node) => node.id);

  if (upsertNodes.length > 0) {
    operations.push({ type: 'upsert_nodes', nodes: upsertNodes });
  }
  if (deletedNodeIds.length > 0) {
    operations.push({ type: 'delete_nodes', nodeIds: deletedNodeIds });
  }

  const previousEdges = new Map(previousSnapshot.edges.map((edge) => [edge.id, edge] as const));
  const nextEdges = new Map(nextSnapshot.edges.map((edge) => [edge.id, edge] as const));
  const upsertEdges = nextSnapshot.edges.filter((edge) => JSON.stringify(previousEdges.get(edge.id)) !== JSON.stringify(edge));
  const deletedEdgeIds = previousSnapshot.edges.filter((edge) => !nextEdges.has(edge.id)).map((edge) => edge.id);

  if (upsertEdges.length > 0) {
    operations.push({ type: 'upsert_edges', edges: upsertEdges });
  }
  if (deletedEdgeIds.length > 0) {
    operations.push({ type: 'delete_edges', edgeIds: deletedEdgeIds });
  }

  return operations.length > 0 ? operations : [{ type: 'replace_graph', project: nextSnapshot }];
};

const overlayFields = <T extends object>(target: T, fields: InteractiveDraftFields) => ({ ...target, ...fields });

export const overlayInteractiveDrafts = (
  snapshot: PlannerSnapshot,
  drafts: InteractiveDraftMap,
): PlannerSnapshot => {
  let nextSnapshot = snapshot;
  for (const draft of Object.values(drafts)) {
    if (draft.targetType === 'root') {
      nextSnapshot = { ...nextSnapshot, root: overlayFields(nextSnapshot.root, draft.fields) };
      continue;
    }
    nextSnapshot = {
      ...nextSnapshot,
      nodes: nextSnapshot.nodes.map((node) =>
        node.id === draft.targetId ? overlayFields(node, draft.fields) : node,
      ),
    };
  }
  return nextSnapshot;
};

export const createInteractiveDraft = (
  targetType: InteractiveDraft['targetType'],
  targetId: string,
  activeField: InteractiveDraft['activeField'],
): InteractiveDraft => {
  if (targetType === 'root') {
    return {
      targetType: 'root',
      targetId: 'root',
      activeField,
      fields: {},
      dirty: false,
      needsRevalidation: false,
      removedByRollback: false,
    };
  }

  return {
    targetType: 'node',
    targetId,
    activeField,
    fields: {},
    dirty: false,
    needsRevalidation: false,
    removedByRollback: false,
  };
};

export const hasSnapshotChanges = (approvedSnapshot: PlannerSnapshot, predictedSnapshot: PlannerSnapshot) =>
  JSON.stringify(approvedSnapshot) !== JSON.stringify(predictedSnapshot);
