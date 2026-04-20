/**
 * Tests for the AuthProvider abstraction introduced in Phase 1.
 *
 * Covers:
 *  - Default DevAuthProvider behaviour (no CLERK_SECRET_KEY / no OIDC_ISSUER)
 *  - setAuthProvider() replaces the active provider
 *  - Rejected authentication returns 401
 *  - requireRole() returns 403 when role doesn't match
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";

// We import the real module — in test env CLERK_SECRET_KEY is unset so
// DevAuthProvider activates automatically.
import {
  authMiddleware,
  setAuthProvider,
  requireRole,
  type AuthProvider,
  type AuthUser,
} from "../../src/server/auth.js";

type Vars = { Variables: { user: AuthUser } };

function buildApp() {
  const app = new Hono<Vars>();
  app.use("*", authMiddleware);
  app.get("/me", (c) => c.json(c.get("user")));
  app.get("/admin-only", requireRole("admin"), (c) => c.json({ ok: true }));
  return app;
}

describe("DevAuthProvider (default, no Clerk/OIDC configured)", () => {
  it("passes through with dev-user identity", async () => {
    const app = buildApp();
    const res = await app.request("/me");
    expect(res.status).toBe(200);
    const body = await res.json() as AuthUser;
    expect(body.userId).toBe("dev-user");
    expect(body.role).toBe("admin");
  });

  it("allows admin role", async () => {
    const app = buildApp();
    const res = await app.request("/admin-only");
    expect(res.status).toBe(200);
  });
});

describe("setAuthProvider()", () => {
  // Restore DevAuthProvider after each test so other tests aren't affected
  beforeEach(() => {
    const { DevAuthProvider } = (() => {
      // Re-import to get the class — we'll use a matching anonymous provider
      class Dev implements AuthProvider {
        async authenticate() { return { userId: "dev-user", role: "admin" }; }
      }
      return { DevAuthProvider: Dev };
    })();
    setAuthProvider(new DevAuthProvider());
  });

  it("replaces the active provider", async () => {
    const customProvider: AuthProvider = {
      async authenticate() {
        return { userId: "custom-user", role: "viewer" };
      },
    };
    setAuthProvider(customProvider);

    const app = buildApp();
    const res = await app.request("/me");
    expect(res.status).toBe(200);
    const body = await res.json() as AuthUser;
    expect(body.userId).toBe("custom-user");
    expect(body.role).toBe("viewer");
  });

  it("returns 401 when provider returns null", async () => {
    const rejectingProvider: AuthProvider = {
      async authenticate() { return null; },
    };
    setAuthProvider(rejectingProvider);

    const app = buildApp();
    const res = await app.request("/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 when provider throws", async () => {
    const throwingProvider: AuthProvider = {
      async authenticate() { throw new Error("IdP unavailable"); },
    };
    setAuthProvider(throwingProvider);

    const app = buildApp();
    const res = await app.request("/me");
    expect(res.status).toBe(401);
  });

  it("requireRole returns 403 for wrong role", async () => {
    const viewerProvider: AuthProvider = {
      async authenticate() { return { userId: "u1", role: "viewer" }; },
    };
    setAuthProvider(viewerProvider);

    const app = buildApp();
    const res = await app.request("/admin-only");
    expect(res.status).toBe(403);
  });

  it("requireRole accepts matching role", async () => {
    const adminProvider: AuthProvider = {
      async authenticate() { return { userId: "u2", role: "admin" }; },
    };
    setAuthProvider(adminProvider);

    const app = buildApp();
    const res = await app.request("/admin-only");
    expect(res.status).toBe(200);
  });
});
