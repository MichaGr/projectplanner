import { memo, useState, type Dispatch, type DragEvent, type SetStateAction } from 'react';
import { ChevronDown, Download, GripVertical, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import type { WorkspaceSummary } from '../../api';

type Props = {
  workspaces: WorkspaceSummary[];
  workspaceId: string;
  projectId: string;
  isWorkspaceMenuOpen: boolean;
  setIsWorkspaceMenuOpen: Dispatch<SetStateAction<boolean>>;
  isProjectMenuOpen: boolean;
  setIsProjectMenuOpen: Dispatch<SetStateAction<boolean>>;
  isWorkspaceTreeLoading: boolean;
  workspaceTreeError: string | null;
  loadingStoredProjectId: string | null;
  isProjectGraphLoading: boolean;
  onSelectWorkspace: (workspaceId: string) => void | Promise<unknown>;
  onCreateWorkspace: () => void | Promise<unknown>;
  onRenameWorkspace: (workspace: WorkspaceSummary) => void | Promise<unknown>;
  onRemoveWorkspace: (workspace: WorkspaceSummary) => void | Promise<unknown>;
  onOpenProject: (workspaceId: string, projectId: string) => void | Promise<unknown>;
  onCreateProject: () => void | Promise<unknown>;
  onRenameProject: (workspaceId: string, projectId: string, title: string) => void | Promise<unknown>;
  onRemoveProject: (workspaceId: string, projectId: string, title: string) => void | Promise<unknown>;
  onReorderWorkspaces: (workspaceIds: string[]) => void | Promise<unknown>;
  onReorderProjects: (workspaceId: string, projectIds: string[]) => void | Promise<unknown>;
  onImportProject: () => void;
  onExportProject: () => void;
};

export const WorkspaceProjectNavigation = memo(function WorkspaceProjectNavigation(props: Props) {
  const activeWorkspace = props.workspaces.find((workspace) => workspace.workspaceId === props.workspaceId) ?? null;
  const activeProject = activeWorkspace?.projects.find((project) => project.projectId === props.projectId) ?? null;
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);

  const reorderIds = (ids: string[], draggedId: string, targetId: string) => {
    if (draggedId === targetId) {
      return ids;
    }
    const next = [...ids];
    const fromIndex = next.indexOf(draggedId);
    const toIndex = next.indexOf(targetId);
    if (fromIndex === -1 || toIndex === -1) {
      return ids;
    }
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
  };

  const handleWorkspaceDrop = (targetWorkspaceId: string) => {
    if (!draggedWorkspaceId || draggedWorkspaceId === targetWorkspaceId) {
      setDraggedWorkspaceId(null);
      return;
    }
    void props.onReorderWorkspaces(
      reorderIds(
        props.workspaces.map((workspace) => workspace.workspaceId),
        draggedWorkspaceId,
        targetWorkspaceId,
      ),
    );
    setDraggedWorkspaceId(null);
  };

  const handleProjectDrop = (targetProjectId: string) => {
    if (!activeWorkspace || !draggedProjectId || draggedProjectId === targetProjectId) {
      setDraggedProjectId(null);
      return;
    }
    void props.onReorderProjects(
      activeWorkspace.workspaceId,
      reorderIds(
        activeWorkspace.projects.map((project) => project.projectId),
        draggedProjectId,
        targetProjectId,
      ),
    );
    setDraggedProjectId(null);
  };

  return <>
    <div className="sidebar-section workspace-switcher">
      <span className="sidebar-section__label">Workspace</span>
      <button type="button" className="workspace-switcher__trigger" onClick={() => { props.setIsWorkspaceMenuOpen((open) => !open); props.setIsProjectMenuOpen(false); }} aria-haspopup="menu" aria-expanded={props.isWorkspaceMenuOpen}>
        <span>{activeWorkspace?.name ?? 'Select workspace'}</span>
      </button>
      {props.isWorkspaceMenuOpen ? <div className="sidebar-menu workspace-menu" role="menu" aria-label="Workspaces">
        <div className="sidebar-menu__scroll">{props.workspaces.map((workspace) => <div
          key={workspace.workspaceId}
          className={['sidebar-menu__item-row', workspace.workspaceId === props.workspaceId ? 'is-active' : '', draggedWorkspaceId === workspace.workspaceId ? 'is-dragging' : ''].join(' ')}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => handleWorkspaceDrop(workspace.workspaceId)}
        >
          <button type="button" className="sidebar-menu__item-main" onClick={() => void props.onSelectWorkspace(workspace.workspaceId)} role="menuitem"><span>{workspace.name}</span><small>{workspace.projectCount}</small></button>
          <button
            type="button"
            className="sidebar-menu__drag-handle"
            draggable
            aria-label={`Reorder workspace ${workspace.name}`}
            title="Drag to reorder"
            onDragStart={(event: DragEvent<HTMLButtonElement>) => {
              setDraggedWorkspaceId(workspace.workspaceId);
              if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', workspace.workspaceId);
              }
            }}
            onDragEnd={() => setDraggedWorkspaceId(null)}
          >
            <GripVertical aria-hidden="true" />
          </button>
        </div>)}</div>
        <div className="sidebar-menu__actions">
          <button type="button" onClick={() => void props.onCreateWorkspace()} role="menuitem"><Plus aria-hidden="true" /> Create workspace</button>
          {activeWorkspace ? <><button type="button" onClick={() => void props.onRenameWorkspace(activeWorkspace)} role="menuitem"><Pencil aria-hidden="true" /> Rename</button><button type="button" className="is-danger" onClick={() => void props.onRemoveWorkspace(activeWorkspace)} role="menuitem"><Trash2 aria-hidden="true" /> Delete</button></> : null}
        </div>
      </div> : null}
      {props.workspaceTreeError ? <p className="sidebar-status is-error">{props.workspaceTreeError}</p> : null}
      {props.isWorkspaceTreeLoading && props.workspaces.length === 0 ? <p className="sidebar-status">Loading workspaces...</p> : null}
    </div>

    <div className="sidebar-section projects-section">
      <span className="sidebar-section__label">Projects</span>
      <button type="button" className="workspace-switcher__trigger" onClick={() => { props.setIsProjectMenuOpen((open) => !open); props.setIsWorkspaceMenuOpen(false); }} aria-haspopup="menu" aria-expanded={props.isProjectMenuOpen}>
        <span>{activeProject?.title || 'Select project'}</span>
      </button>
      {props.isProjectMenuOpen ? <div className="sidebar-menu project-menu" role="menu" aria-label="Projects">
        <div className="sidebar-menu__scroll">
          {activeWorkspace?.projects.map((project) => <div
            key={project.projectId}
            className={['sidebar-menu__item-row', project.projectId === props.projectId ? 'is-active' : '', draggedProjectId === project.projectId ? 'is-dragging' : ''].join(' ')}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => handleProjectDrop(project.projectId)}
          >
            <button
              type="button"
              className="sidebar-menu__item-main"
              onClick={() => void props.onOpenProject(activeWorkspace.workspaceId, project.projectId)}
              disabled={props.loadingStoredProjectId !== null}
              role="menuitem"
            ><span>{props.loadingStoredProjectId === project.projectId ? 'Loading...' : project.title || 'Untitled Project'}</span></button>
            <button
              type="button"
              className="sidebar-menu__drag-handle"
              draggable
              aria-label={`Reorder project ${project.title || 'Untitled Project'}`}
              title="Drag to reorder"
              onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                setDraggedProjectId(project.projectId);
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', project.projectId);
                }
              }}
              onDragEnd={() => setDraggedProjectId(null)}
            >
              <GripVertical aria-hidden="true" />
            </button>
          </div>)}
          {activeWorkspace && activeWorkspace.projects.length === 0 ? <p className="sidebar-empty">No projects yet</p> : null}
        </div>
        <div className="sidebar-menu__actions">
          <button type="button" onClick={() => { props.setIsProjectMenuOpen(false); void props.onCreateProject(); }} disabled={!props.workspaceId || props.isProjectGraphLoading} role="menuitem"><Plus aria-hidden="true" /> Create project</button>
          {activeProject && activeWorkspace ? <><button type="button" onClick={() => void props.onRenameProject(activeWorkspace.workspaceId, activeProject.projectId, activeProject.title)} role="menuitem"><Pencil aria-hidden="true" /> Rename</button><button type="button" className="is-danger" onClick={() => void props.onRemoveProject(activeWorkspace.workspaceId, activeProject.projectId, activeProject.title)} role="menuitem"><Trash2 aria-hidden="true" /> Delete</button></> : null}
          <button type="button" onClick={() => { props.setIsProjectMenuOpen(false); props.onImportProject(); }} disabled={!props.workspaceId} role="menuitem"><Upload aria-hidden="true" /> Import project</button>
          <button type="button" onClick={() => { props.setIsProjectMenuOpen(false); props.onExportProject(); }} disabled={!props.projectId} role="menuitem"><Download aria-hidden="true" /> Export project</button>
        </div>
      </div> : null}
    </div>
  </>;
});
