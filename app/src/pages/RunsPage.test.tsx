import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { RunsPage } from "./RunsPage.js";
import { renderWithProviders } from "../test-utils.js";

vi.mock("../api/hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/hooks.js")>();
  return {
    ...actual,
    useRuns: vi.fn(),
    useRun: vi.fn(),
    useDeleteRun: vi.fn(),
  };
});

// Stub EventSource so useLiveEvents doesn't crash in jsdom
vi.stubGlobal("EventSource", class {
  addEventListener() {}
  close() {}
});

import * as hooks from "../api/hooks.js";

const SAMPLE_RUN = {
  id: "run-workflow-abc-001",
  workflow_id: "wf-123456",
  workflow_version: "1.0.0",
  status: "succeeded" as const,
  triggered_by: "alice",
  started_at: "2024-01-01T10:00:00Z",
  completed_at: "2024-01-01T10:05:00Z",
};

function setupMocks(runs: { id: string; workflow_id: string; workflow_version: string; status: string; triggered_by: string; started_at: string; completed_at: string }[] = [SAMPLE_RUN]) {
  vi.mocked(hooks.useRuns).mockReturnValue({
    data: { items: runs },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useRuns>);
  vi.mocked(hooks.useRun).mockReturnValue({
    data: undefined,
    isLoading: false,
  } as unknown as ReturnType<typeof hooks.useRun>);
  vi.mocked(hooks.useDeleteRun).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof hooks.useDeleteRun>);
}

beforeEach(() => {
  setupMocks();
});

describe("RunsPage", () => {
  it("renders heading", () => {
    renderWithProviders(<RunsPage />);
    expect(screen.getByText("Runs")).toBeInTheDocument();
  });

  it("shows empty state when no runs", () => {
    setupMocks([]);
    renderWithProviders(<RunsPage />);
    expect(screen.getByText("No runs yet")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    vi.mocked(hooks.useRuns).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as unknown as ReturnType<typeof hooks.useRuns>);

    renderWithProviders(<RunsPage />);
    expect(screen.getByText("Loading runs…")).toBeInTheDocument();
  });

  it("renders runs in table", () => {
    renderWithProviders(<RunsPage />);
    expect(screen.getByText("succeeded")).toBeInTheDocument();
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
  });

  it("renders status badges for different statuses", () => {
    setupMocks([
      { ...SAMPLE_RUN, id: "run-1", status: "running" as const },
      { ...SAMPLE_RUN, id: "run-2", status: "failed" as const },
      { ...SAMPLE_RUN, id: "run-3", status: "awaiting_gate" as const },
    ]);
    renderWithProviders(<RunsPage />);
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("awaiting_gate")).toBeInTheDocument();
  });

  it("shows run detail on row click with steps tab", () => {
    vi.mocked(hooks.useRun).mockReturnValue({
      data: {
        ...SAMPLE_RUN,
        steps: [
          {
            id: "s1",
            step_id: "extract",
            step_type: "agent",
            status: "succeeded",
            started_at: "2024-01-01T10:00:00Z",
            completed_at: "2024-01-01T10:01:00Z",
            token_count: 500,
            cost_usd: 0.001,
          },
        ],
        events: [],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useRun>);

    renderWithProviders(<RunsPage />);
    // Open the detail panel
    fireEvent.click(screen.getAllByText("succeeded")[0]);
    // The detail panel header shows status + tab buttons
    expect(screen.getByText("Overview")).toBeInTheDocument();
    // Switch to Steps tab
    fireEvent.click(screen.getByText(/^Steps/));
    expect(screen.getByText("extract")).toBeInTheDocument();
    expect(screen.getByText("500 tok")).toBeInTheDocument();
  });

  it("closes detail panel on Close button", () => {
    renderWithProviders(<RunsPage />);
    fireEvent.click(screen.getAllByText("succeeded")[0]);
    expect(screen.getByText("Overview")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Close"));
    expect(screen.queryByText("Overview")).not.toBeInTheDocument();
  });

  it("has a status filter dropdown", () => {
    renderWithProviders(<RunsPage />);
    const select = screen.getByRole("combobox");
    expect(select).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "running" } });
    expect(vi.mocked(hooks.useRuns)).toHaveBeenCalledWith({ status: "running" });
  });
});
