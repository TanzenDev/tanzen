import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  usersSidebar: [
    { type: "doc", id: "dsl-reference",       label: "DSL Reference" },
    { type: "doc", id: "example-workflows",   label: "Example Workflows" },
    { type: "doc", id: "code-execution",      label: "Code Execution" },
  ],

  adminSidebar: [
    { type: "doc", id: "deployment-guide",    label: "Deployment Guide" },
    { type: "doc", id: "helm-values",         label: "Helm Values" },
    { type: "doc", id: "operations",          label: "Operations" },
    { type: "doc", id: "security",            label: "Security" },
  ],

  sysadminSidebar: [
    { type: "doc", id: "clusters",            label: "Cluster Setup" },
    { type: "doc", id: "talos-one",           label: "Talos on KVM" },
    {
      type: "category",
      label: "Design",
      items: [
        { type: "doc", id: "design/system-design",          label: "System Design" },
        { type: "doc", id: "design/open-core-architecture", label: "Open-Core Architecture" },
      ],
    },
    { type: "doc", id: "load-test-plan",      label: "Load Testing" },
  ],
};

export default sidebars;
