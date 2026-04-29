import { NavLink, Outlet } from "react-router-dom";
import type { ReactNode } from "react";
import {
  Bot, GitBranch, Play, FileCode,
  ShieldCheck, BarChart2,
  SlidersHorizontal, KeyRound,
  type LucideProps,
} from "lucide-react";
import { useGates } from "../api/hooks.js";
import { useExtensionNavItems, useSlot } from "../extensions/registry.js";

type IconComponent = React.ComponentType<LucideProps>;

function NavItem({ to, label, badge, Icon }: { to: string; label: string; badge?: number; Icon?: IconComponent }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `block px-3 py-2 rounded text-sm font-medium transition-colors ${
          isActive
            ? "bg-[var(--shell-nav-active-bg)] text-[var(--shell-nav-active-text)]"
            : "text-[var(--shell-nav-inactive-text)] hover:bg-[var(--shell-nav-hover-bg)] hover:text-[var(--shell-nav-hover-text)]"
        }`
      }
    >
      <span className="flex items-center gap-2">
        {Icon && <Icon size={15} strokeWidth={1.75} className="shrink-0 opacity-70" />}
        {label}
        {badge !== undefined && badge > 0 && (
          <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-xs font-bold text-white">
            {badge}
          </span>
        )}
      </span>
    </NavLink>
  );
}

export function Layout() {
  const { data: gatesData } = useGates();
  const pendingGates = gatesData?.items?.length ?? 0;
  const extNavItems = useExtensionNavItems();
  const SidebarFooter = useSlot("sidebar.footer") as (() => ReactNode) | null;

  // Group extension nav items by section
  const extBySection = extNavItems.reduce<Record<string, typeof extNavItems>>((acc, item) => {
    const section = item.section ?? "Config";
    (acc[section] ??= []).push(item);
    return acc;
  }, {});

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--shell-bg)]">
      {/* Sidebar */}
      <nav className="w-52 flex-shrink-0 flex flex-col gap-1 border-r border-[var(--shell-border)] bg-[var(--shell-sidebar-bg)] p-4">
        <p className="mb-4 text-xs font-bold uppercase tracking-widest text-[var(--shell-text-subtle)]">Tanzen</p>

        <p className="mt-2 mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--shell-text-subtle)]">Build</p>
        <NavItem to="/agents" label="Agents" Icon={Bot} />
        <NavItem to="/workflows" label="Workflows" Icon={GitBranch} />
        <NavItem to="/runs" label="Runs" Icon={Play} />
        <NavItem to="/scripts" label="Scripts" Icon={FileCode} />
        {extBySection["Build"]?.map((item) => <NavItem key={item.to} to={item.to} label={item.label} Icon={item.icon as IconComponent} />)}

        <p className="mt-4 mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--shell-text-subtle)]">Review</p>
        <NavItem to="/gates" label="Gates" badge={pendingGates} Icon={ShieldCheck} />
        <NavItem to="/metrics" label="Metrics" Icon={BarChart2} />
        {extBySection["Review"]?.map((item) => <NavItem key={item.to} to={item.to} label={item.label} Icon={item.icon as IconComponent} />)}

        <p className="mt-4 mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--shell-text-subtle)]">Settings</p>
        <NavItem to="/settings" label="Settings" Icon={SlidersHorizontal} />
        <NavItem to="/secrets" label="Secrets" Icon={KeyRound} />
        {extBySection["Settings"]?.map((item) => <NavItem key={item.to} to={item.to} label={item.label} Icon={item.icon as IconComponent} />)}

        {/* Sections added entirely by extensions (not Build/Review/Config) */}
        {Object.entries(extBySection)
          .filter(([section]) => !["Build", "Review", "Settings"].includes(section))
          .map(([section, items]) => (
            <div key={section}>
              <p className="mt-4 mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--shell-text-subtle)]">{section}</p>
              {items.map((item) => <NavItem key={item.to} to={item.to} label={item.label} Icon={item.icon as IconComponent} />)}
            </div>
          ))}
        {SidebarFooter && (
          <div className="mt-auto pt-4 border-t border-[var(--shell-border)]">
            <SidebarFooter />
          </div>
        )}
      </nav>

      {/* Main */}
      <main className="flex-1 overflow-y-auto p-8 dark:text-slate-100 text-slate-900">
        <Outlet />
      </main>
    </div>
  );
}
