/**
 * Authentication middleware for Hono.
 *
 * Provides a pluggable AuthProvider interface so commercial builds can inject
 * alternative implementations (OIDC, SAML, etc.) without forking this file.
 *
 * Default: Clerk JWT when CLERK_SECRET_KEY is set; synthetic dev identity otherwise.
 */
import type { Context, Next } from "hono";
import { createClerkClient } from "@clerk/backend";

export type AuthUser = {
  userId: string;
  role: string;
};

// ---------------------------------------------------------------------------
// AuthProvider interface — the extension point
// ---------------------------------------------------------------------------

export interface AuthProvider {
  /** Verify a request and return the authenticated user, or null to reject. */
  authenticate(req: Request, c: Context): Promise<AuthUser | null>;
}

// ---------------------------------------------------------------------------
// Built-in providers
// ---------------------------------------------------------------------------

const CLERK_SECRET_KEY = process.env["CLERK_SECRET_KEY"];
const DEV_USER_ID = process.env["TANZEN_DEV_USER"] ?? "dev-user";

if (!CLERK_SECRET_KEY && process.env["NODE_ENV"] === "production") {
  throw new Error(
    "CLERK_SECRET_KEY (or an enterprise auth provider) must be set in production. " +
    "DevAuthProvider grants admin to all requests and must never run in production.",
  );
}

let clerk: ReturnType<typeof createClerkClient> | null = null;

function getClerk() {
  if (!clerk && CLERK_SECRET_KEY) {
    clerk = createClerkClient({ secretKey: CLERK_SECRET_KEY });
  }
  return clerk;
}

class ClerkAuthProvider implements AuthProvider {
  async authenticate(_req: Request, c: Context): Promise<AuthUser | null> {
    const clerkInstance = getClerk()!;
    const requestState = await clerkInstance.authenticateRequest(
      new Request(c.req.url, { headers: c.req.raw.headers }),
    );
    if (!requestState.isSignedIn) return null;
    const payload = requestState.toAuth();
    const role = (payload?.sessionClaims?.["role"] as string | undefined) ?? "viewer";
    return { userId: payload?.userId ?? "", role };
  }
}

class DevAuthProvider implements AuthProvider {
  async authenticate(_req: Request, _c: Context): Promise<AuthUser | null> {
    const role = process.env["TANZEN_DEV_ROLE"] ?? "admin";
    return { userId: DEV_USER_ID, role };
  }
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

let _provider: AuthProvider = CLERK_SECRET_KEY
  ? new ClerkAuthProvider()
  : new DevAuthProvider();

if (!CLERK_SECRET_KEY && process.env["NODE_ENV"] !== "production") {
  console.warn(
    "[auth] DevAuthProvider active — all requests granted role:" +
    ` "${process.env["TANZEN_DEV_ROLE"] ?? "admin"}". ` +
    "Set CLERK_SECRET_KEY or call setAuthProvider() to enable real auth.",
  );
}

/**
 * Override the default auth provider. Call this before the server starts.
 * Commercial builds use this to inject OIDC, SAML, or multi-tenant providers.
 */
export function setAuthProvider(p: AuthProvider): void {
  _provider = p;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  try {
    const user = await _provider.authenticate(c.req.raw, c);
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("user", user satisfies AuthUser);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
}

export function requireRole(...roles: string[]) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || !roles.includes(user.role)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    return next();
  };
}
