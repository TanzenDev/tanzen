/**
 * Vite library build config for @tanzen/app-core.
 *
 * Produces dist-lib/ with ESM output and .d.ts declarations.
 * React, react-dom, and react-router-dom are externalized (peerDependencies).
 * Run with: vite build --config vite.lib.config.ts
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    dts({
      include: ["src"],
      outDir: "dist-lib",
      insertTypesEntry: true,
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        "App": resolve(__dirname, "src/App.tsx"),
        "extensions/registry": resolve(__dirname, "src/extensions/registry.tsx"),
      },
      formats: ["es"],
    },
    outDir: "dist-lib",
    rollupOptions: {
      external: [
        "react",
        "react-dom",
        "react-dom/client",
        "react-router-dom",
        "@tanstack/react-query",
      ],
      output: {
        preserveModules: true,
        preserveModulesRoot: "src",
        entryFileNames: "[name].js",
      },
    },
    sourcemap: true,
  },
});
