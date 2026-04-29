import type { ReactNode } from "react";
import { useSlot } from "../extensions/registry.js";

/**
 * Wraps a subtree with the "auth.guard" slot if one is registered.
 * In OSS the slot is empty and children render unconditionally.
 * Enterprise fills the slot with a redirect-to-login guard and token refresh.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const Guard = useSlot("auth.guard") as
    | (({ children }: { children: ReactNode }) => ReactNode)
    | null;
  if (Guard) return <Guard>{children}</Guard>;
  return <>{children}</>;
}
