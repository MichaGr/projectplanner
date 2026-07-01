import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { WorkspaceProjectNavigation } from './WorkspaceProjectNavigation';

const workspace = {
  workspaceId: 'workspace-1',
  name: 'Personal',
  description: '',
  tags: [],
  projectCount: 2,
  createdAt: '',
  updatedAt: '',
  projects: [
    { workspaceId: 'workspace-1', projectId: 'project-1', title: 'Default', description: '', graphVersion: 1, nodeCount: 0, edgeCount: 0, updatedAt: '' },
    { workspaceId: 'workspace-1', projectId: 'project-2', title: 'Second', description: '', graphVersion: 1, nodeCount: 0, edgeCount: 0, updatedAt: '' },
  ],
};

const props = (overrides: Partial<ComponentProps<typeof WorkspaceProjectNavigation>> = {}): ComponentProps<typeof WorkspaceProjectNavigation> => ({
  workspaces: [workspace],
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  isWorkspaceMenuOpen: false,
  setIsWorkspaceMenuOpen: vi.fn(),
  isProjectMenuOpen: false,
  setIsProjectMenuOpen: vi.fn(),
  isWorkspaceTreeLoading: false,
  workspaceTreeError: null,
  loadingStoredProjectId: null,
  isProjectGraphLoading: false,
  onSelectWorkspace: vi.fn(),
  onCreateWorkspace: vi.fn(),
  onRenameWorkspace: vi.fn(),
  onRemoveWorkspace: vi.fn(),
  onReorderWorkspaces: vi.fn(),
  onOpenProject: vi.fn(),
  onCreateProject: vi.fn(),
  onRenameProject: vi.fn(),
  onRemoveProject: vi.fn(),
  onReorderProjects: vi.fn(),
  onImportProject: vi.fn(),
  onExportProject: vi.fn(),
  ...overrides,
});

describe('WorkspaceProjectNavigation', () => {
  it('shows the active workspace and project', () => {
    render(<WorkspaceProjectNavigation {...props()} />);
    expect(screen.getByText('Personal')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('opens a project from the project menu', () => {
    const onOpenProject = vi.fn();
    render(<WorkspaceProjectNavigation {...props({ isProjectMenuOpen: true, onOpenProject })} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Second' }));
    expect(onOpenProject).toHaveBeenCalledWith('workspace-1', 'project-2');
  });

  it('reorders projects via drag handle drop', () => {
    const onReorderProjects = vi.fn();
    render(<WorkspaceProjectNavigation {...props({ isProjectMenuOpen: true, onReorderProjects })} />);
    fireEvent.dragStart(screen.getByLabelText('Reorder project Default'));
    fireEvent.drop(screen.getByText('Second').closest('.sidebar-menu__item-row')!);
    expect(onReorderProjects).toHaveBeenCalledWith('workspace-1', ['project-2', 'project-1']);
  });
});
