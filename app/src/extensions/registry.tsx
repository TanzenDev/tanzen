/**
 * App extension registry — OSS slot system.
 *
 * Commercial builds call registerExtension() at app startup (in main.tsx)
 * to add nav items, routes, and named UI slot components without forking
 * Layout.tsx or App.tsx.
 *
 * OSS components use useSlot() to render optional commercial UI at named
 * extension points.
 */
import { type ComponentType, type ReactNode, createContext, useContext } from "react";

export interface NavItem {
  to: string;
  label: string;
  /** Sidebar section heading — "Build" | "Review" | "Settings" | "Admin" or a custom string */
  section?: string;
  /** Lucide-compatible icon component */
  icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
}

export interface RouteItem {
  path: string;
  element: ReactNode;
}

export interface AppExtension {
  navItems?: NavItem[];
  routes?: RouteItem[];
  /** Named UI slots keyed by slot name, filled by commercial code */
  slots?: Record<string, ComponentType<Record<string, unknown>>>;
}

// ---------------------------------------------------------------------------
// Internal registry (module-level singleton — populated before React mounts)
// ---------------------------------------------------------------------------

const _registry: Required<AppExtension> = {
  navItems: [],
  routes: [],
  slots: {},
};

export function registerExtension(ext: AppExtension): void {
  if (ext.navItems) _registry.navItems.push(...ext.navItems);
  if (ext.routes) _registry.routes.push(...ext.routes);
  if (ext.slots) Object.assign(_registry.slots, ext.slots);
}

/** Reset registry to empty state. Only for use in tests. */
export function _resetForTesting(): void {
  _registry.navItems.length = 0;
  _registry.routes.length = 0;
  Object.keys(_registry.slots).forEach((k) => delete _registry.slots[k]);
}

// ---------------------------------------------------------------------------
// React context — provides a snapshot of the registry to components
// ---------------------------------------------------------------------------

const ExtensionContext = createContext<Required<AppExtension>>(_registry);

export function ExtensionProvider({ children }: { children: ReactNode }) {
  // Registry is populated synchronously before this mounts, so a stable
  // reference is sufficient — no need for dynamic updates.
  return (
    <ExtensionContext.Provider value={_registry}>
      {children}
    </ExtensionContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useExtensionNavItems(): NavItem[] {
  return useContext(ExtensionContext).navItems;
}

export function useExtensionRoutes(): RouteItem[] {
  return useContext(ExtensionContext).routes;
}

/** Returns the commercial component registered for this slot, or null. */
export function useSlot(name: string): ComponentType<Record<string, unknown>> | null {
  const { slots } = useContext(ExtensionContext);
  return slots[name] ?? null;
}
