import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "Tanzen",
  tagline: "Agent Workflow Orchestration for Regulated Knowledge Work",
  favicon: "img/favicon.ico",

  url: "https://tanzendev.github.io",
  baseUrl: "/tanzen/",

  organizationName: "TanzenDev",
  projectName: "tanzen",
  trailingSlash: false,

  onBrokenLinks: "warn",
  onBrokenMarkdownLinks: "warn",

  i18n: { defaultLocale: "en", locales: ["en"] },

  plugins: [
    [
      "docusaurus-plugin-openapi-docs",
      {
        id: "api",
        docsPluginId: "classic",
        config: {
          tanzen: {
            specPath: "../docs/api-reference.yaml",
            outputDir: "docs/api",
            sidebarOptions: { groupPathsBy: "tag" },
          },
        },
      },
    ],
  ],

  presets: [
    [
      "classic",
      {
        docs: {
          path: "../docs",
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          exclude: [
            "**/.DS_Store",
            "**/assorted-fixes.md",
            "**/findings/**",
            "**/plans/**",
            "**/design/wireframe.html",
          ],
          editUrl: "https://github.com/TanzenDev/tanzen/edit/main/",
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    navbar: {
      title: "Tanzen",
      items: [
        { type: "docSidebar", sidebarId: "usersSidebar",   position: "left", label: "Users" },
        { type: "docSidebar", sidebarId: "adminSidebar",   position: "left", label: "Administrators" },
        { type: "docSidebar", sidebarId: "sysadminSidebar", position: "left", label: "System Administrators" },
        { label: "API Reference", to: "/api", position: "left" },
        { href: "https://github.com/TanzenDev/tanzen", label: "GitHub", position: "right" },
      ],
    },
    footer: {
      style: "dark",
      copyright: `Copyright © ${new Date().getFullYear()} Tanzen Dev. Built with Docusaurus.`,
    },
    prism: { theme: { plain: { color: "#cdd6f4", backgroundColor: "#1e1e2e" }, styles: [] } },
  } satisfies Preset.ThemeConfig,
};

export default config;
