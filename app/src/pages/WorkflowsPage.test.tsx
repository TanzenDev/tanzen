import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { WorkflowsPage } from "./WorkflowsPage.js";
import { renderWithProviders } from "../test-utils.js";

// Monaco editor is heavy — stub it out
vi.mock("@monaco-editor/react", () => ({
  default: ({ value, onChange }: { value?: string; onChange?: (v: string) => void }) => (
    <textarea
      data-testid="monaco-editor"
      value={value ?? ""}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

vi.mock("../api/hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/hooks.js")>();
  return {
    ...actual,
    useWorkflows: vi.fn(),
    useWorkflow: vi.fn(),
    useWorkflowDsl: vi.fn(),
    useCreateWorkflow: vi.fn(),
    useCompile: vi.fn(),
    useStartRun: vi.fn(),
    usePromoteWorkflow: vi.fn(),
    useDeleteWorkflow: vi.fn(),
    useAgents: vi.fn(),
  };
});

import * as hooks from "../api/hooks.js";

const SAMPLE_WORKFLOW = {
  id: "wf-001",
  name: "data-pipeline",
  current_version: "1.0.0",
  created_by: "alice",
  created_at: "2024-01-01T00:00:00Z",
  versions: [
    { version: "1.0.0", dsl_key: "k", ir_key: "k", created_at: "2024-01-01T00:00:00Z", promoted: false },
  ],
};

function setupMocks() {
  const mutateFn = vi.fn();
  vi.mocked(hooks.useWorkflows).mockReturnValue({
    data: { items: [] },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useWorkflows>);
  vi.mocked(hooks.useWorkflow).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof hooks.useWorkflow>);
  vi.mocked(hooks.useCreateWorkflow).mockReturnValue({
    mutate: mutateFn,
    isPending: false,
  } as unknown as ReturnType<typeof hooks.useCreateWorkflow>);
  vi.mocked(hooks.useCompile).mockReturnValue({
    mutate: mutateFn,
    isPending: false,
  } as unknown as ReturnType<typeof hooks.useCompile>);
  vi.mocked(hooks.useStartRun).mockReturnValue({
    mutate: mutateFn,
    isPending: false,
  } as unknown as ReturnType<typeof hooks.useStartRun>);
  vi.mocked(hooks.usePromoteWorkflow).mockReturnValue({
    mutate: mutateFn,
    isPending: false,
  } as unknown as ReturnType<typeof hooks.usePromoteWorkflow>);
  vi.mocked(hooks.useDeleteWorkflow).mockReturnValue({
    mutate: mutateFn,
    isPending: false,
  } as unknown as ReturnType<typeof hooks.useDeleteWorkflow>);
  vi.mocked(hooks.useWorkflowDsl).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof hooks.useWorkflowDsl>);
  vi.mocked(hooks.useAgents).mockReturnValue({
    data: { items: [] },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useAgents>);
  return mutateFn;
}

beforeEach(() => {
  setupMocks();
});

describe("WorkflowsPage", () => {
  it("renders heading and empty state", () => {
    renderWithProviders(<WorkflowsPage />);
    expect(screen.getByText("Workflows")).toBeInTheDocument();
    expect(screen.getByText("No workflows yet")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    vi.mocked(hooks.useWorkflows).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as unknown as ReturnType<typeof hooks.useWorkflows>);
    renderWithProviders(<WorkflowsPage />);
    expect(screen.getByText("Loading workflows…")).toBeInTheDocument();
  });

  it("renders workflow list", () => {
    vi.mocked(hooks.useWorkflows).mockReturnValue({
      data: { items: [SAMPLE_WORKFLOW] },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useWorkflows>);

    renderWithProviders(<WorkflowsPage />);
    expect(screen.getByText("data-pipeline")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
  });

  it("shows create form on button click", () => {
    renderWithProviders(<WorkflowsPage />);
    fireEvent.click(screen.getByText("+ New workflow"));
    expect(screen.getByText("Create workflow")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("my-workflow")).toBeInTheDocument();
  });

  it("cancels create form", () => {
    renderWithProviders(<WorkflowsPage />);
    fireEvent.click(screen.getByText("+ New workflow"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Create workflow")).not.toBeInTheDocument();
  });

  it("submits create form with name and dsl", () => {
    const mutateFn = setupMocks();
    renderWithProviders(<WorkflowsPage />);
    fireEvent.click(screen.getByText("+ New workflow"));

    fireEvent.change(screen.getByPlaceholderText("my-workflow"), {
      target: { value: "my-pipeline" },
    });
    const editor = screen.getByTestId("monaco-editor");
    fireEvent.change(editor, {
      target: { value: 'workflow my-pipeline { version: "1.0.0" }' },
    });
    fireEvent.click(screen.getByText("Save"));

    expect(mutateFn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "my-pipeline", dsl: expect.stringContaining("workflow") }),
      expect.anything(),
    );
  });

  it("shows detail panel on row click", () => {
    vi.mocked(hooks.useWorkflows).mockReturnValue({
      data: { items: [SAMPLE_WORKFLOW] },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useWorkflows>);
    vi.mocked(hooks.useWorkflow).mockReturnValue({
      data: SAMPLE_WORKFLOW,
    } as unknown as ReturnType<typeof hooks.useWorkflow>);

    renderWithProviders(<WorkflowsPage />);
    fireEvent.click(screen.getByText("data-pipeline"));
    expect(screen.getByText("Run")).toBeInTheDocument();
    expect(screen.getByText("Promote")).toBeInTheDocument();
    expect(screen.getAllByText("DSL").length).toBeGreaterThan(0);
  });

  it("shows compile result on Compile click", () => {
    vi.mocked(hooks.useWorkflows).mockReturnValue({
      data: { items: [SAMPLE_WORKFLOW] },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useWorkflows>);

    const compileMutate = vi.fn((_dsl, opts) => {
      opts?.onSuccess?.({ ok: true });
    });
    vi.mocked(hooks.useCompile).mockReturnValue({
      mutate: compileMutate,
      isPending: false,
    } as unknown as ReturnType<typeof hooks.useCompile>);

    renderWithProviders(<WorkflowsPage />);
    fireEvent.click(screen.getByText("data-pipeline"));

    // Type into the editor to enable Compile button
    const editor = screen.getByTestId("monaco-editor");
    fireEvent.change(editor, { target: { value: "steps: []" } });

    fireEvent.click(screen.getByText("Compile"));
    expect(compileMutate).toHaveBeenCalledWith("steps: []", expect.any(Object));
  });

  it("version history shows promoted badge", () => {
    const wfWithPromo = {
      ...SAMPLE_WORKFLOW,
      versions: [
        { ...SAMPLE_WORKFLOW.versions[0], promoted: true },
      ],
    };
    vi.mocked(hooks.useWorkflows).mockReturnValue({
      data: { items: [wfWithPromo] },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useWorkflows>);
    vi.mocked(hooks.useWorkflow).mockReturnValue({
      data: wfWithPromo,
    } as unknown as ReturnType<typeof hooks.useWorkflow>);

    renderWithProviders(<WorkflowsPage />);
    fireEvent.click(screen.getByText("data-pipeline"));
    expect(screen.getByText("promoted")).toBeInTheDocument();
  });
});
