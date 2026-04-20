/**
 * Redis client factory for pub/sub subscriptions.
 *
 * Each SSE connection creates a dedicated subscriber instance (ioredis
 * recommends separate client per subscription channel).  The publisher
 * client is a singleton used for test/utility publishing.
 */
import Redis from "ioredis";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379/0";

/** Create a fresh Redis client for subscribing (one per SSE connection). */
export function createSubscriber(): Redis {
  return new Redis(REDIS_URL, { lazyConnect: true, enableReadyCheck: false });
}

/** Singleton publisher (shared across requests). */
let _publisher: Redis | null = null;
export function getPublisher(): Redis {
  if (!_publisher) {
    _publisher = new Redis(REDIS_URL, { lazyConnect: true, enableReadyCheck: false });
  }
  return _publisher;
}

/** Channel name helpers — must match the Python worker's naming. */
export const runChannel  = (runId: string)    => `run:${runId}`;
export const gatesChannel = (userId: string)  => `gates:${userId}`;
