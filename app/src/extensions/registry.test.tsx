/**
 * Tests for the app extension registry (Phase 1 slot system).
 *
 * Covers:
 *  - registerExtension() accumulates nav items, routes, and slots
 *  - useSlot() returns the registered component or null
 *  - useExtensionNavItems() returns registered nav items
 *  - useExtensionRoutes() returns registered routes
 *  - ExtensionProvider makes registry available to children
 *  - Multiple registerExtension() calls merge cleanly
 *  - Last slot registration wins (Object.assign semantics)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import {
  registerExtension,
  useSlot,
  useExtensionNavItems,
  useExtensionRoutes,
  ExtensionProvider,
  _resetForTesting,
} from "./registry.js";

beforeEach(() => {
  _resetForTesting();
});

function wrap(ui: React.ReactNode) {
  return render(
    <MemoryRouter>
      <ExtensionProvider>{ui}</ExtensionProvider>
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// registerExtension / useExtensionNavItems
// ---------------------------------------------------------------------------

describe("registerExtension() — navItems", () => {
  it("accumulates items across multiple calls", () => {
    registerExtension({ navItems: [{ to: "/foo", label: "Foo" }] });
    registerExtension({ navItems: [{ to: "/bar", label: "Bar" }] });

    function Consumer() {
      const items = useExtensionNavItems();
      return <ul>{items.map((i) => <li key={i.to}>{i.label}</li>)}</ul>;
    }

    wrap(<Consumer />);
    expect(screen.getByText("Foo")).toBeTruthy();
    expect(screen.getByText("Bar")).toBeTruthy();
  });

  it("returns empty array with no registrations", () => {
    function Consumer() {
      const items = useExtensionNavItems();
      return <span data-testid="count">{items.length}</span>;
    }
    wrap(<Consumer />);
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("preserves the section property", () => {
    registerExtension({
      navItems: [{ to: "/audit", label: "Audit Log", section: "Config" }],
    });

    function Consumer() {
      const items = useExtensionNavItems();
      return (
        <ul>
          {items.map((i) => (
            <li key={i.to} data-section={i.section}>{i.label}</li>
          ))}
        </ul>
      );
    }

    wrap(<Consumer />);
    const li = screen.getByText("Audit Log");
    expect((li as HTMLElement).dataset.section).toBe("Config");
  });
});

// ---------------------------------------------------------------------------
// useExtensionRoutes
// ---------------------------------------------------------------------------

describe("useExtensionRoutes()", () => {
  it("accumulates routes across multiple calls", () => {
    registerExtension({ routes: [{ path: "/r1", element: <div>R1</div> }] });
    registerExtension({ routes: [{ path: "/r2", element: <div>R2</div> }] });

    function Consumer() {
      const routes = useExtensionRoutes();
      return <span data-testid="count">{routes.length}</span>;
    }

    wrap(<Consumer />);
    expect(screen.getByTestId("count").textContent).toBe("2");
  });

  it("returns empty array with no registrations", () => {
    function Consumer() {
      const routes = useExtensionRoutes();
      return <span data-testid="count">{routes.length}</span>;
    }
    wrap(<Consumer />);
    expect(screen.getByTestId("count").textContent).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// useSlot
// ---------------------------------------------------------------------------

describe("useSlot()", () => {
  it("returns null for an unregistered slot", () => {
    function Consumer() {
      const Comp = useSlot("does-not-exist");
      return <span data-testid="result">{Comp ? "found" : "null"}</span>;
    }
    wrap(<Consumer />);
    expect(screen.getByTestId("result").textContent).toBe("null");
  });

  it("renders the registered slot component with props", () => {
    const TimeMachineBtn = ({ run }: { run: { id: string } }) => (
      <button>Replay {run.id}</button>
    );

    registerExtension({
      slots: {
        "run-detail-footer": TimeMachineBtn as unknown as React.ComponentType<Record<string, unknown>>,
      },
    });

    function Consumer() {
      const Btn = useSlot("run-detail-footer");
      return Btn ? <Btn run={{ id: "run-abc" }} /> : null;
    }

    wrap(<Consumer />);
    expect(screen.getByText("Replay run-abc")).toBeTruthy();
  });

  it("last registration wins for the same slot name", () => {
    const V1 = () => <div>Version 1</div>;
    const V2 = () => <div>Version 2</div>;

    registerExtension({ slots: { "my-slot": V1 as React.ComponentType<Record<string, unknown>> } });
    registerExtension({ slots: { "my-slot": V2 as React.ComponentType<Record<string, unknown>> } });

    function Consumer() {
      const Comp = useSlot("my-slot");
      return Comp ? <Comp /> : null;
    }

    wrap(<Consumer />);
    expect(screen.getByText("Version 2")).toBeTruthy();
  });

  it("merges multiple different slots from one call", () => {
    const SlotA = () => <div>Slot A</div>;
    const SlotB = () => <div>Slot B</div>;

    registerExtension({
      slots: {
        "slot-a": SlotA as React.ComponentType<Record<string, unknown>>,
        "slot-b": SlotB as React.ComponentType<Record<string, unknown>>,
      },
    });

    function Consumer() {
      const A = useSlot("slot-a");
      const B = useSlot("slot-b");
      return <>{A && <A />}{B && <B />}</>;
    }

    wrap(<Consumer />);
    expect(screen.getByText("Slot A")).toBeTruthy();
    expect(screen.getByText("Slot B")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// _resetForTesting
// ---------------------------------------------------------------------------

describe("_resetForTesting()", () => {
  it("clears all registered extensions", () => {
    registerExtension({
      navItems: [{ to: "/x", label: "X" }],
      routes: [{ path: "/x", element: <div /> }],
      slots: { "x-slot": (() => null) as React.ComponentType<Record<string, unknown>> },
    });

    _resetForTesting();

    function Consumer() {
      const navItems = useExtensionNavItems();
      const routes = useExtensionRoutes();
      const slot = useSlot("x-slot");
      return (
        <span data-testid="out">
          {navItems.length},{routes.length},{slot ? "slot" : "null"}
        </span>
      );
    }

    wrap(<Consumer />);
    expect(screen.getByTestId("out").textContent).toBe("0,0,null");
  });
});
