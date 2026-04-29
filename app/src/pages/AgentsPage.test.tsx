import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { AgentsPage } from "./AgentsPage.js";
import { renderWithProviders } from "../test-utils.js";

vi.mock("../api/hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/hooks.js")>();
  return {
    ...actual,
    useAgents: vi.fn(),
    useCreateAgent: vi.fn(),
    useUpdateAgent: vi.fn(),
    usePromoteAgent: vi.fn(),
    useDeleteAgent: vi.fn(),
  };
});

import * as hooks from "../api/hooks.js";

function mockHooks(overrides: Partial<typeof hooks> = {}) {
  const mutateFn = vi.fn();
  vi.mocked(hooks.useAgents).mockReturnValue({
    data: { items: [] },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useAgents>);
  vi.mocked(hooks.useCreateAgent).mockReturnValue({
    mutate: mutateFn,
    isPending: false,
  } as unknown as ReturnType<typeof hooks.useCreateAgent>);
  vi.mocked(hooks.useUpdateAgent).mockReturnValue({
    mutate: mutateFn,
    isPending: false,
  } as unknown as ReturnType<typeof hooks.useUpdateAgent>);
  vi.mocked(hooks.usePromoteAgent).mockReturnValue({
    mutate: mutateFn,
    isPending: false,
  } as unknown as ReturnType<typeof hooks.usePromoteAgent>);
  vi.mocked(hooks.useDeleteAgent).mockReturnValue({
    mutate: mutateFn,
    isPending: false,
  } as unknown as ReturnType<typeof hooks.useDeleteAgent>);
  Object.entries(overrides).forEach(([k, v]) => {
    (hooks as Record<string, unknown>)[k] = v;
  });
  return mutateFn;
}

beforeEach(() => {
  mockHooks();
});

describe("AgentsPage", () => {
  it("renders heading and empty state", () => {
    renderWithProviders(<AgentsPage />);
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("No agents yet")).toBeInTheDocument();
  });

  it("renders agents from API", () => {
    vi.mocked(hooks.useAgents).mockReturnValue({
      data: {
        items: [
          {
            id: "a1",
            name: "doc-parser",
            model: "openai:gpt-4o",
            current_version: "1.0",
            created_at: "2024-01-01T00:00:00Z",
          },
        ],
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useAgents>);

    renderWithProviders(<AgentsPage />);
    expect(screen.getByText("doc-parser")).toBeInTheDocument();
    expect(screen.getByText("openai:gpt-4o")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    vi.mocked(hooks.useAgents).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as unknown as ReturnType<typeof hooks.useAgents>);

    renderWithProviders(<AgentsPage />);
    expect(screen.getByText("Loading agents…")).toBeInTheDocument();
  });

  it("shows error state", () => {
    vi.mocked(hooks.useAgents).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Connection refused"),
    } as unknown as ReturnType<typeof hooks.useAgents>);

    renderWithProviders(<AgentsPage />);
    expect(screen.getByText(/Error:/)).toBeInTheDocument();
  });

  it("opens create form when clicking New agent", () => {
    renderWithProviders(<AgentsPage />);
    fireEvent.click(screen.getByText("+ New agent"));
    expect(screen.getByText("Create agent")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("document-parser")).toBeInTheDocument();
  });

  it("closes create form on cancel", () => {
    renderWithProviders(<AgentsPage />);
    fireEvent.click(screen.getByText("+ New agent"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Create agent")).not.toBeInTheDocument();
  });

  it("submits create form with name, model, and system_prompt", () => {
    const mutateFn = mockHooks();
    renderWithProviders(<AgentsPage />);
    fireEvent.click(screen.getByText("+ New agent"));

    fireEvent.change(screen.getByPlaceholderText("document-parser"), {
      target: { value: "my-agent" },
    });
    fireEvent.change(screen.getByPlaceholderText("You are a..."), {
      target: { value: "You are a helpful assistant." },
    });
    fireEvent.click(screen.getByText("Save"));

    expect(mutateFn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "my-agent", system_prompt: "You are a helpful assistant." }),
    );
  });

  it("shows agent detail on row click", () => {
    vi.mocked(hooks.useAgents).mockReturnValue({
      data: {
        items: [
          {
            id: "a1",
            name: "doc-parser",
            model: "openai:gpt-4o",
            current_version: "1.2",
            created_at: "2024-01-01T00:00:00Z",
            versions: [
              { version: "1.0", config_key: "k", created_at: "2024-01-01T00:00:00Z", promoted: false },
              { version: "1.2", config_key: "k2", created_at: "2024-02-01T00:00:00Z", promoted: true },
            ],
          },
        ],
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useAgents>);

    renderWithProviders(<AgentsPage />);
    fireEvent.click(screen.getByText("doc-parser"));
    expect(screen.getByText("Version history")).toBeInTheDocument();
    expect(screen.getByText("promoted")).toBeInTheDocument();
  });
});
