import { memo } from 'react';
import { ChevronDown } from 'lucide-react';
import type { TagTreeNode } from '../model/tags';

export const TagTree = memo(function TagTree({ nodes, selectedTags, onToggle }: {
  nodes: TagTreeNode[];
  selectedTags: string[];
  onToggle: (tag: string) => void;
}) {
  return <div className="tag-tree">
    {nodes.map((node) => <div key={node.path} className="tag-tree__branch">
      <button type="button" className={['tag-tree__item', selectedTags.includes(node.path) ? 'is-selected' : '', node.isTag ? '' : 'is-branch'].join(' ')} onClick={() => (node.isTag ? onToggle(node.path) : undefined)}>
        <span className="tag-tree__caret" aria-hidden="true">{node.children.length > 0 ? <ChevronDown /> : null}</span>
        <span>{node.label}</span>
      </button>
      {node.children.length > 0 ? <div className="tag-tree__children"><TagTree nodes={node.children} selectedTags={selectedTags} onToggle={onToggle} /></div> : null}
    </div>)}
  </div>;
});
