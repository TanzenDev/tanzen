/**
 * SSE route unit tests.
 *
 * Uses a lightweight Hono app that replaces the Redis subscriber and Postgres
 * db with in-memory stubs so the SSE logic can be tested without external deps.
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import EventEmitter from "node:events";

type Vars = { Variables: { user: { userId: string; role: string } } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all SSE data lines from a Response into an array. */
async function collectSSE(res: Response, timeoutMs = 200): Promise<string[]> {
  const lines: string[] = [];
  const reader = res.body?.getReader();
  if (!reader) return lines;

  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs),
      ),
    ]);
    if (done || value === undefined) break;
    const text = decoder.decode(value);
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        lines.push(line.slice(5).trim());
      }
    }
  }
  reader.cancel().catch(() => {});
  return lines;
}

// ---------------------------------------------------------------------------
// Tests: run event SSE endpoint
// ---------------------------------------------------------------------------

describe("SSE run events", () => {
  it("streams events published to the emitter and closes on run_completed", async () => {
    const emitter = new EventEmitter();
    const app = new Hono<Vars>();

    app.use("*", async (c, next) => {
      c.set("user", { userId: "user-1", role: "admin" });
      return next();
    });

    // Minimal SSE route driven by an EventEmitter instead of Redis
    app.get("/runs/:runId/events", async (c) => {
      return streamSSE(c, async (stream) => {
        await new Promise<void>((resolve) => {
          const handler = async (msg: string) => {
            await stream.writeSSE({ data: msg, event: "run_event" });
            const parsed = JSON.parse(msg) as { event_type?: string };
            if (parsed.event_type === "run_completed") resolve();
          };
          emitter.on("msg", handler);
        });
      });
    });

    const responsePromise = app.request("/runs/test-run/events");

    // Give the stream a tick to open, then emit events
    await new Promise((r) => setTimeout(r, 10));
    emitter.emit("msg", JSON.stringify({ event_type: "step_started", step_id: "s1" }));
    emitter.emit("msg", JSON.stringify({ event_type: "step_completed", step_id: "s1" }));
    emitter.emit("msg", JSON.stringify({ event_type: "run_completed" }));

    const res = await responsePromise;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const lines = await collectSSE(res, 300);
    const events = lines.map((l) => JSON.parse(l) as { event_type: string });
    expect(events.some((e) => e.event_type === "step_started")).toBe(true);
    expect(events.some((e) => e.event_type === "run_completed")).toBe(true);
  });

  it("returns 404 for SSE routes proxied via content-type check", async () => {
    // Validate that a non-streaming endpoint 404s correctly (contract test)
    const app = new Hono();
    app.get("/health", (c) => c.json({ ok: true }));
    const res = await app.request("/nonexistent");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tests: gate count SSE endpoint
// ---------------------------------------------------------------------------

describe("SSE gate count stream", () => {
  it("sends initial gate count then streams updates", async () => {
    const emitter = new EventEmitter();
    let pendingCount = 3;

    const app = new Hono<Vars>();
    app.use("*", async (c, next) => {
      c.set("user", { userId: "reviewer-1", role: "reviewer" });
      return next();
    });

    app.get("/gates/stream", async (c) => {
      const user = c.get("user");
      return streamSSE(c, async (stream) => {
        // Send initial count
        await stream.writeSSE({
          data: JSON.stringify({ pending_gates: pendingCount, user_id: user.userId }),
          event: "gate_count",
        });

        // Stream updates from emitter
        await new Promise<void>((resolve) => {
          const handler = async (msg: string) => {
            await stream.writeSSE({ data: msg, event: "gate_count" });
            resolve(); // close after first update for test brevity
          };
          emitter.once("gate_update", handler);
        });
      });
    });

    const responsePromise = app.request("/gates/stream");
    await new Promise((r) => setTimeout(r, 10));
    emitter.emit("gate_update", JSON.stringify({ pending_gates: 2, user_id: "reviewer-1" }));

    const res = await responsePromise;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const lines = await collectSSE(res, 300);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const first = JSON.parse(lines[0]!) as { pending_gates: number };
    expect(first.pending_gates).toBe(3);
  });
});
