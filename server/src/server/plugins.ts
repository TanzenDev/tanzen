/**
 * Plugin registry — import this file to register plugins WITHOUT triggering
 * the server startup sequence. The OSS server's index.ts imports from here
 * and reads _plugins during its own startup.
 *
 * Enterprise builds import registerPlugin from this file so that plugin
 * registration happens before the OSS server module initialises.
 */
import type { Hono, MiddlewareHandler } from "hono";

export interface TanzenPlugin {
  name: string;
  /** Mount additional routes on the /api sub-app (behind authMiddleware) */
  routes?: Hono;
  /** Mount additional routes on the root app WITHOUT auth — use for login, callbacks, etc. */
  publicRoutes?: Hono;
  /** Applied to the /api sub-app (all routes) before route mounting */
  apiMiddleware?: MiddlewareHandler;
  /** Run after migrate() and ensureBuckets() */
  onStartup?: () => Promise<void>;
  /** Additional DB migrations to run idempotently before core migrations */
  migrations?: () => Promise<void>;
}

const _plugins: TanzenPlugin[] = [];

export function registerPlugin(p: TanzenPlugin): void {
  _plugins.push(p);
}

export function getPlugins(): readonly TanzenPlugin[] {
  return _plugins;
}
