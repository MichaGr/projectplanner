import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { PlannerSnapshot } from './features/planner/model/types';

const { mockCheckWorkflowService, mockFetchAuthSession, mockListWorkspaces, mockFetchProjectGraph } = vi.hoisted(() => ({
  mockCheckWorkflowService: vi.fn(),
  mockFetchAuthSession: vi.fn(),
  mockListWorkspaces: vi.fn(),
  mockFetchProjectGraph: vi.fn(),
}));

vi.mock('./api', () => ({
  fetchAuthSession: mockFetchAuthSession,
  checkWorkflowService: mockCheckWorkflowService,
  listWorkspaces: mockListWorkspaces,
  fetchProjectGraph: mockFetchProjectGraph,
  fetchAvailableTasks: vi.fn(),
  createWorkspace: vi.fn(),
  createProjectGraph: vi.fn(),
  deleteProject: vi.fn(),
  deleteWorkspace: vi.fn(),
  completeAvailableTask: vi.fn(),
  logoutSession: vi.fn(),
  reorderProjects: vi.fn(),
  reorderWorkspaces: vi.fn(),
  updateProject: vi.fn(),
  updateWorkspace: vi.fn(),
  applyProjectGraphOperations: vi.fn(),
}));

vi.mock('./features/planner/canvas/ParticleGridBackground', () => ({
  ParticleGridBackground: () => null,
}));

vi.mock('./features/planner/canvas/FlowElements', () => ({
  flowNodeTypes: {},
  flowEdgeTypes: {},
}));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ReactFlow: (props: {
      nodes: Array<{ id: string; data: { title: string } }>;
      onNodeClick?: (event: unknown, node: unknown) => void;
      onNodeContextMenu?: (event: MouseEvent, node: unknown) => void;
      onPaneClick?: () => void;
    }) => (
      <div data-testid="react-flow" onClick={() => props.onPaneClick?.()}>
        {props.nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onNodeClick?.(event, node);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              props.onNodeContextMenu?.(event.nativeEvent, node);
            }}
          >
            {node.data.title}
          </button>
        ))}
      </div>
    ),
    applyNodeChanges: <T,>(_: unknown, nodes: T[]) => nodes,
    Connection: function Connection() {
      return null;
    },
    NodeChange: function NodeChange() {
      return null;
    },
    PanOnScrollMode: { Free: 'free' },
    SelectionMode: { Full: 'full' },
    useReactFlow: () => ({
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      setCenter: vi.fn(),
      getZoom: () => 1,
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    }),
  };
});

const snapshot: PlannerSnapshot = {
  root: { title: 'Project', description: '', completionCriteria: '', tags: [] },
  nodes: [
    {
      id: 'task-1',
      kind: 'task',
      title: 'Task node',
      status: 'todo',
      position: { x: 80, y: 120 },
      description: '',
      completionCriteria: '',
      tags: [],
    },
    {
      id: 'group-1',
      kind: 'group',
      title: 'Group node',
      status: 'todo',
      position: { x: 320, y: 120 },
      description: '',
      completionCriteria: '',
      tags: [],
      size: { width: 280, height: 132 },
    },
  ],
  edges: [],
};

describe('node context menu', () => {
  const taskLabel = 'Define project vision';
  const groupLabel = 'Build prototype';

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    window.localStorage.clear();
    mockFetchAuthSession.mockResolvedValue({ authenticated: true, username: 'planner-admin' });
    mockCheckWorkflowService.mockResolvedValue({ status: 'ok' });
    mockListWorkspaces.mockResolvedValue([
      {
        workspaceId: 'workspace-1',
        name: 'Workspace',
        description: '',
        tags: [],
        projectCount: 1,
        createdAt: '',
        updatedAt: '',
        projects: [
          {
            workspaceId: 'workspace-1',
            projectId: 'project-1',
            title: 'Project',
            description: '',
            graphVersion: 1,
            nodeCount: snapshot.nodes.length,
            edgeCount: snapshot.edges.length,
            updatedAt: '',
          },
        ],
      },
    ]);
    mockFetchProjectGraph.mockResolvedValue({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      graphVersion: 1,
      project: snapshot,
    });
  });

  it('shows move, create group, and delete for task nodes', async () => {
    render(<App />);
    const flow = screen.getAllByTestId('react-flow')[0]!;
    const task = within(flow).getByRole('button', { name: taskLabel });

    fireEvent.contextMenu(task);

    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Move' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Create group' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('shows only move and delete for group nodes', async () => {
    render(<App />);
    const flow = screen.getAllByTestId('react-flow')[0]!;
    const group = within(flow).getByRole('button', { name: groupLabel });

    fireEvent.contextMenu(group);

    expect(await screen.findByRole('menuitem', { name: 'Move' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Create group' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('deletes nodes and converts tasks into groups from the context menu', async () => {
    render(<App />);
    const flow = screen.getAllByTestId('react-flow')[0]!;
    const task = within(flow).getByRole('button', { name: taskLabel });

    fireEvent.contextMenu(task);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Create group' }));

    fireEvent.contextMenu(within(flow).getByRole('button', { name: taskLabel }));
    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: 'Create group' })).not.toBeInTheDocument(),
    );

    fireEvent.contextMenu(within(flow).getByRole('button', { name: groupLabel }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    await waitFor(() => expect(within(flow).queryByRole('button', { name: groupLabel })).not.toBeInTheDocument());
  });
});
