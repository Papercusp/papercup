'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as Tabs from '@radix-ui/react-tabs';

/**
 * /adv shell — Advanced Agent Orchestration surface.
 *
 * This is becoming the replacement shell for the legacy OPS /harness
 * workspace. Harness-scoped pages keep their selected project in ?slug=
 * so the surface is deep-linkable and agent-drivable.
 */
const TABS = [
  { href: '/adv/harnesses', label: 'Harnesses' },
  { href: '/adv/brainstorm', label: 'Brainstorm' },
  { href: '/adv/prs', label: 'PRs' },
  { href: '/adv/insights', label: 'Insights' },
  { href: '/adv/config', label: 'Config' },
  { href: '/adv/settings', label: 'Settings' },
  { href: '/adv/docs', label: 'Docs' },
  { href: '/adv/plans', label: 'Plans' },
  { href: '/adv/sessions', label: 'Sessions' },
] as const;

export default function AdvShell({
  title = 'Advanced',
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname() || '/adv/brainstorm';
  const activeTab =
    TABS.find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`)) ?? TABS[0];

  return (
    <div className="pc-advshell">
      <header className="pc-advshell__header">
        <div className="pc-advshell__copy">
          <span className="pc-advshell__kicker">Advanced orchestration</span>
          <h1>{title}</h1>
        </div>
        <Tabs.Root value={activeTab.href} className="pc-advshell__tabs">
          <Tabs.List className="pc-advshell__tablist" aria-label="Adv sections">
            {TABS.map((t) => (
              <Tabs.Trigger key={t.href} value={t.href} asChild className="pc-advshell__tab">
                <Link href={t.href}>{t.label}</Link>
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </Tabs.Root>
        <span className="pc-advshell__spacer" />
      </header>
      <div className="pc-advshell__body">{children}</div>
      <style>{`
        .pc-advshell {
          display: flex;
          flex-direction: column;
          min-height: calc(100vh - 56px);
          background:
            radial-gradient(circle at top left, rgba(167, 139, 250, 0.07), transparent 28%),
            linear-gradient(180deg, rgba(8, 10, 22, 0.99), rgba(5, 8, 18, 1));
        }
        .pc-advshell__header {
          display: flex;
          align-items: flex-end;
          gap: 16px;
          padding: 14px 18px 12px;
          border-bottom: 1px solid rgba(167, 139, 250, 0.16);
          background:
            linear-gradient(180deg, rgba(11, 13, 28, 0.98), rgba(8, 11, 24, 0.98));
          box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.02);
        }
        .pc-advshell__copy { display: grid; gap: 4px; min-width: 0; }
        .pc-advshell__kicker {
          color: rgba(199, 188, 252, 0.66);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0.11em;
          line-height: 1;
          text-transform: uppercase;
        }
        .pc-advshell__header h1 {
          margin: 0;
          font-size: 28px;
          font-weight: 760;
          line-height: 1;
          letter-spacing: -0.02em;
          color: #f7f5ff;
        }
        .pc-advshell__tabs { align-self: stretch; display: flex; align-items: flex-end; }
        .pc-advshell__tablist {
          display: inline-flex;
          align-items: flex-end;
          gap: 6px;
          padding: 0 0 1px;
        }
        .pc-advshell__tab {
          display: inline-flex;
          align-items: center;
          min-height: 34px;
          padding: 0 12px;
          border: 1px solid rgba(167, 139, 250, 0.16);
          border-bottom-color: rgba(167, 139, 250, 0.08);
          border-radius: 10px 10px 0 0;
          background: rgba(255, 255, 255, 0.02);
          color: rgba(220, 214, 248, 0.74);
          font-size: 12px;
          font-weight: 650;
          letter-spacing: 0.02em;
          text-decoration: none !important;
          transition: background-color 120ms, border-color 120ms, color 120ms;
        }
        .pc-advshell__tab:hover {
          color: #f7f5ff;
          background: rgba(20, 18, 38, 0.96);
          border-color: rgba(167, 139, 250, 0.32);
        }
        .pc-advshell__tab[data-state='active'] {
          color: #f7f5ff;
          background: rgba(31, 23, 56, 0.96);
          border-color: rgba(167, 139, 250, 0.5);
          border-bottom-color: transparent;
        }
        .pc-advshell__spacer { flex: 1; }
        .pc-advshell__body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
      `}</style>
    </div>
  );
}
