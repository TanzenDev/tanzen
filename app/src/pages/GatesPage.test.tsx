import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { GatesPage } from "./GatesPage.js";
import { renderWithProviders } from "../test-utils.js";

vi.mock("../api/hooks.js", () => ({
  useGates: vi.fn(),
  useApproveGate: vi.fn(),
  useRejectGate: vi.fn(),
}));

import * as hooks from "../api/hooks.js";

const PENDING_GATE = {
  id: "g1",
  run_id: "run-workflow-123456789",
  step_id: "review",
  assignee: "alice@example.com",
  status: "pending" as const,
  opened_at: "2024-01-01T00:00:00Z",
};

function setupMocks(gates: typeof PENDING_GATE[] = []) {
  const mutateFn = vi.fn();
  vi.mocked(hooks.useGates).mockReturnValue({
    data: { items: gates },
    isLoading: false,
    error: null,
  } as ReturnType<typeof hooks.useGates>);
  vi.mocked(hooks.useApproveGate).mockReturnValue({
    mutate: mutateFn,
  } as unknown as ReturnType<typeof hooks.useApproveGate>);
  vi.mocked(hooks.useRejectGate).mockReturnValue({
    mutate: mutateFn,
  } as unknown as ReturnType<typeof hooks.useRejectGate>);
  return mutateFn;
}

beforeEach(() => {
  setupMocks();
});

describe("GatesPage", () => {
  it("renders heading", () => {
    renderWithProviders(<GatesPage />);
    expect(screen.getByText("Gates")).toBeInTheDocument();
  });

  it("shows empty message when no gates", () => {
    renderWithProviders(<GatesPage />);
    expect(screen.getByText("No gates yet.")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    vi.mocked(hooks.useGates).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as ReturnType<typeof hooks.useGates>);

    renderWithProviders(<GatesPage />);
    expect(screen.getByText("Loading gates…")).toBeInTheDocument();
  });

  it("renders pending gates with approve/reject buttons", () => {
    setupMocks([PENDING_GATE]);
    renderWithProviders(<GatesPage />);

    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("1 pending")).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.getByText("Reject")).toBeInTheDocument();
  });

  it("opens approve modal when clicking Approve", () => {
    setupMocks([PENDING_GATE]);
    renderWithProviders(<GatesPage />);

    fireEvent.click(screen.getByText("Approve"));
    expect(screen.getByText("Approve gate")).toBeInTheDocument();
    expect(screen.getByText("Confirm approve")).toBeInTheDocument();
  });

  it("opens reject modal when clicking Reject", () => {
    setupMocks([PENDING_GATE]);
    renderWithProviders(<GatesPage />);

    fireEvent.click(screen.getByText("Reject"));
    expect(screen.getByText("Reject gate")).toBeInTheDocument();
    expect(screen.getByText("Confirm reject")).toBeInTheDocument();
  });

  it("calls approve mutate on confirm", () => {
    const mutateFn = setupMocks([PENDING_GATE]);
    renderWithProviders(<GatesPage />);

    fireEvent.click(screen.getByText("Approve"));
    fireEvent.click(screen.getByText("Confirm approve"));
    expect(mutateFn).toHaveBeenCalledWith({ id: "g1", notes: "" });
  });

  it("calls reject mutate with notes", () => {
    setupMocks([PENDING_GATE]);
    vi.mocked(hooks.useApproveGate).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof hooks.useApproveGate>);
    const rejectFn = vi.fn();
    vi.mocked(hooks.useRejectGate).mockReturnValue({
      mutate: rejectFn,
    } as unknown as ReturnType<typeof hooks.useRejectGate>);

    renderWithProviders(<GatesPage />);
    fireEvent.click(screen.getByText("Reject"));
    fireEvent.change(screen.getByPlaceholderText("Add a comment…"), {
      target: { value: "Not ready" },
    });
    fireEvent.click(screen.getByText("Confirm reject"));
    expect(rejectFn).toHaveBeenCalledWith({ id: "g1", notes: "Not ready" });
  });

  it("shows reviewed gates section", () => {
    setupMocks([{ ...PENDING_GATE, id: "g2", status: "approved" as const }]);
    renderWithProviders(<GatesPage />);
    expect(screen.getByText("Reviewed")).toBeInTheDocument();
    expect(screen.getByText("approved")).toBeInTheDocument();
  });

  it("closes modal on cancel", () => {
    setupMocks([PENDING_GATE]);
    renderWithProviders(<GatesPage />);

    fireEvent.click(screen.getByText("Approve"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Approve gate")).not.toBeInTheDocument();
  });
});
