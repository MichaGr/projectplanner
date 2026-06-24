import type { PlannerSnapshot } from './types';

export type TagTreeNode = {
  id: string;
  label: string;
  path: string;
  isTag: boolean;
  children: TagTreeNode[];
};

export const matchesTagQuery = (tag: string, query: string) => {
  const normalizedQuery = query.trim().replace(/^#/, '').toLowerCase();
  if (!normalizedQuery) return true;
  return tag.toLowerCase().includes(normalizedQuery);
};

export const getAllKnownTags = (snapshot: PlannerSnapshot) =>
  Array.from(new Set([...snapshot.root.tags, ...snapshot.nodes.flatMap((node) => node.tags)])).sort((a, b) =>
    a.localeCompare(b),
  );

export const buildTagTree = (tags: string[]): TagTreeNode[] => {
  type MutableTagTreeNode = TagTreeNode & { childMap?: Map<string, MutableTagTreeNode> };
  const root = new Map<string, MutableTagTreeNode>();
  const tagSet = new Set(tags);

  for (const tag of tags) {
    let level = root;
    let currentPath = '';
    for (const part of tag.split('.')) {
      currentPath = currentPath ? `${currentPath}.${part}` : part;
      if (!level.has(part)) {
        level.set(part, { id: currentPath, label: part, path: currentPath, isTag: tagSet.has(currentPath), children: [] });
      }
      const node = level.get(part)!;
      node.isTag ||= tagSet.has(currentPath);
      node.childMap ??= new Map();
      level = node.childMap;
    }
  }

  const materialize = (map: Map<string, MutableTagTreeNode>): TagTreeNode[] =>
    Array.from(map.values())
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((node) => ({
        id: node.id,
        label: node.label,
        path: node.path,
        isTag: node.isTag,
        children: node.childMap ? materialize(node.childMap) : [],
      }));

  return materialize(root);
};
