import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { SecretsPage } from "./SecretsPage.js";
import { renderWithProviders } from "../test-utils.js";

vi.mock("../api/hooks.js", () => ({
  useSecrets: vi.fn(),
  useCreateSecret: vi.fn(),
  useDeleteSecret: vi.fn(),
}));

import * as hooks from "../api/hooks.js";

function setupMocks(secrets: Array<{ name: string; createdAt?: string }> = []) {
  const createFn = vi.fn();
  const deleteFn = vi.fn();
  vi.mocked(hooks.useSecrets).mockReturnValue({
    data: { items: secrets },
    isLoading: false,
    error: null,
  } as ReturnType<typeof hooks.useSecrets>);
  vi.mocked(hooks.useCreateSecret).mockReturnValue({
    mutate: createFn,
    isPending: false,
  } as unknown as ReturnType<typeof hooks.useCreateSecret>);
  vi.mocked(hooks.useDeleteSecret).mockReturnValue({
    mutate: deleteFn,
    isPending: false,
  } as unknown as ReturnType<typeof hooks.useDeleteSecret>);
  return { createFn, deleteFn };
}

beforeEach(() => {
  setupMocks();
});

describe("SecretsPage", () => {
  it("renders heading", () => {
    renderWithProviders(<SecretsPage />);
    expect(screen.getByText("Secrets")).toBeInTheDocument();
  });

  it("shows empty state", () => {
    renderWithProviders(<SecretsPage />);
    expect(screen.getByText("No secrets yet")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    vi.mocked(hooks.useSecrets).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as ReturnType<typeof hooks.useSecrets>);
    renderWithProviders(<SecretsPage />);
    expect(screen.getByText("Loading secrets…")).toBeInTheDocument();
  });

  it("renders secrets list", () => {
    setupMocks([
      { name: "OPENAI_API_KEY", createdAt: "2024-01-01T00:00:00Z" },
      { name: "ANTHROPIC_API_KEY" },
    ]);
    renderWithProviders(<SecretsPage />);
    expect(screen.getByText("OPENAI_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("ANTHROPIC_API_KEY")).toBeInTheDocument();
  });

  it("shows create form on button click", () => {
    renderWithProviders(<SecretsPage />);
    fireEvent.click(screen.getByText("+ New secret"));
    expect(screen.getByText("Add secret")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("MY_API_KEY")).toBeInTheDocument();
  });

  it("submits create form with name and value", () => {
    const { createFn } = setupMocks();
    renderWithProviders(<SecretsPage />);
    fireEvent.click(screen.getByText("+ New secret"));

    fireEvent.change(screen.getByPlaceholderText("MY_API_KEY"), {
      target: { value: "OPENAI_API_KEY" },
    });
    fireEvent.change(screen.getByPlaceholderText("sk-…"), {
      target: { value: "sk-test-value" },
    });
    fireEvent.click(screen.getByText("Save"));

    expect(createFn).toHaveBeenCalledWith(
      { name: "OPENAI_API_KEY", value: "sk-test-value" },
      expect.any(Object),
    );
  });

  it("shows delete confirm modal", () => {
    setupMocks([{ name: "OPENAI_API_KEY" }]);
    renderWithProviders(<SecretsPage />);
    fireEvent.click(screen.getByText("Delete"));
    expect(screen.getByText("Delete secret")).toBeInTheDocument();
    expect(screen.getByText("OPENAI_API_KEY", { selector: "span.font-mono.text-white" })).toBeInTheDocument();
  });

  it("calls delete mutate on confirm", () => {
    const { deleteFn } = setupMocks([{ name: "OPENAI_API_KEY" }]);
    renderWithProviders(<SecretsPage />);
    fireEvent.click(screen.getByText("Delete"));
    // Modal is rendered first in the DOM, so its "Delete" button is index 0
    const deleteButtons = screen.getAllByText("Delete");
    fireEvent.click(deleteButtons[0]!);
    expect(deleteFn).toHaveBeenCalledWith("OPENAI_API_KEY");
  });

  it("cancels delete when clicking Cancel", () => {
    setupMocks([{ name: "OPENAI_API_KEY" }]);
    renderWithProviders(<SecretsPage />);
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Delete secret")).not.toBeInTheDocument();
  });
});
