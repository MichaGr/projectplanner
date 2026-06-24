import { Check, ExternalLink, GitFork, Search, TriangleAlert, X, type LucideIcon } from 'lucide-react';

const icons = {
  check: Check,
  close: X,
  device_hub: GitFork,
  open_in_new: ExternalLink,
  search: Search,
  warning: TriangleAlert,
} as const;

export type ToolbarIconName = keyof typeof icons;

export function ToolbarIcon({ name }: { name: ToolbarIconName }) {
  const Icon: LucideIcon = icons[name];
  return <Icon className="app-icon" aria-hidden="true" />;
}
