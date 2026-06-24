import { memo, type Dispatch, type SetStateAction } from 'react';
import { ChevronDown, Download, Pencil, Plus, Trash2, Upload } from 'lucide-react';
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
  onImportProject: () => void;
  onExportProject: () => void;
};

export const WorkspaceProjectNavigation = memo(function WorkspaceProjectNavigation(props: Props) {
  const activeWorkspace = props.workspaces.find((workspace) => workspace.workspaceId === props.workspaceId) ?? null;
  const activeProject = activeWorkspace?.projects.find((project) => project.projectId === props.projectId) ?? null;

  return <>
    <div className="sidebar-section workspace-switcher">
      <span className="sidebar-section__label">Workspace</span>
      <button type="button" className="workspace-switcher__trigger" onClick={() => { props.setIsWorkspaceMenuOpen((open) => !open); props.setIsProjectMenuOpen(false); }} aria-haspopup="menu" aria-expanded={props.isWorkspaceMenuOpen}>
        <span>{activeWorkspace?.name ?? 'Select workspace'}</span>
      </button>
      {props.isWorkspaceMenuOpen ? <div className="sidebar-menu workspace-menu" role="menu" aria-label="Workspaces">
        <div className="sidebar-menu__scroll">{props.workspaces.map((workspace) => <button key={workspace.workspaceId} type="button" className={workspace.workspaceId === props.workspaceId ? 'is-active' : ''} onClick={() => void props.onSelectWorkspace(workspace.workspaceId)} role="menuitem"><span>{workspace.name}</span><small>{workspace.projectCount}</small></button>)}</div>
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
          {activeWorkspace?.projects.map((project) => <button key={project.projectId} type="button" className={project.projectId === props.projectId ? 'is-active' : ''} onClick={() => void props.onOpenProject(activeWorkspace.workspaceId, project.projectId)} disabled={props.loadingStoredProjectId !== null} role="menuitem"><span>{props.loadingStoredProjectId === project.projectId ? 'Loading...' : project.title || 'Untitled Project'}</span></button>)}
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
