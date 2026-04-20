/**
 * @tanzen/app-core public library surface.
 *
 * Commercial builds import from here (or from the named sub-path exports).
 * Internal app code imports directly from file paths — this file is only
 * for the published npm package.
 */
export { default as App } from "./App.js";
export {
  registerExtension,
  useSlot,
  useExtensionNavItems,
  useExtensionRoutes,
  ExtensionProvider,
  type AppExtension,
  type NavItem,
  type RouteItem,
} from "./extensions/registry.js";
