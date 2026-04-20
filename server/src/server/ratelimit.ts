/**
 * Simple sliding-window rate limiter middleware for Hono.
 *
 * Uses an in-process Map keyed by client IP + route.
 * For multi-replica deployments, swap Map for a Redis-backed store.
 *
 * Usage:
 *   app.use("/api/*", rateLimit({ windowMs: 60_000, max: 120 }))
 *   app.use("/api/workflows", rateLimit({ windowMs: 60_000, max: 20, keyFn: runKey }))
 */
import type { Context, Next } from "hono";

export interface RateLimitOptions {
  /** Window duration in ms (default 60 000 = 1 min) */
  windowMs?: number;
  /** Max requests per window per key (default 120) */
  max?: number;
  /** Extract the rate-limit key from the request (default: client IP) */
  keyFn?: (c: Context) => string;
  /** Message returned when limit is exceeded */
  message?: string;
}

interface Entry { count: number; resetAt: number }

/** Global store — one per process, cleared automatically on window expiry. */
const store = new Map<string, Entry>();

function clientIp(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown"
  );
}

export function rateLimit(opts: RateLimitOptions = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const max      = opts.max      ?? 120;
  const keyFn    = opts.keyFn    ?? clientIp;
  const message  = opts.message  ?? "Too many requests — please slow down";

  return async (c: Context, next: Next): Promise<Response | void> => {
    const key = `rl:${keyFn(c)}:${c.req.path}`;
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }
    entry.count++;

    c.res.headers.set("X-RateLimit-Limit",     String(max));
    c.res.headers.set("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    c.res.headers.set("X-RateLimit-Reset",     String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      return c.json({ error: message }, 429);
    }
    return next();
  };
}

/** Per-user key — requires auth middleware to have already set `user`. */
export function userKey(c: Context): string {
  const user = c.get("user") as { userId?: string } | undefined;
  return user?.userId ?? clientIp(c);
}

/** Expose store size for testing */
export function _storeSizeForTest() { return store.size; }
export function _clearStoreForTest() { store.clear(); }
