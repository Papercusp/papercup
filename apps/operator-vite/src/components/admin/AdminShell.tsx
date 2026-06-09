import { Link, useRouterState } from '@tanstack/react-router';
import * as Tabs from '@radix-ui/react-tabs';
import type { TermKey } from '@papercusp/lexicon';
import { useLexicon } from '@/lib/useLexicon';

/**
 * Admin section shell — translated from
 * `apps/operator/app/admin/_components/AdminShell.tsx` (B-2 of the
 * operator-vite migration).
 *
 * next → TSR diff:
 *   - `import Link from 'next/link'`           → `Link` from TSR
 *   - `import { usePathname } from 'next/navigation'`
 *                                              → `useRouterState({ select: s => s.location.pathname })`
 *   - `<Link href=...>`                        → `<Link to=...>`
 *
 * Parallel copy (B5 deferred): the original under `app/admin/_components/`
 * stays on next/* so the live operator continues to work during the
 * migration window. After Phase H this file becomes canonical.
 */
// `term` (optional) routes a tab label through the brand lexicon; tabs without
// one render their static label verbatim.
const TABS: ReadonlyArray<{ href: string; label: string; term?: TermKey }> = [
  { href: '/admin/run', label: 'Run' },
  { href: '/admin/features', label: 'Features' },
  { href: '/admin/git', label: 'Git' },
  { href: '/admin/testing', label: 'Testing' },
  { href: '/admin/dogfood-substrate', label: 'Substrate' },
  { href: '/admin/deploy-accounts', label: 'Deploy Accounts' },
  { href: '/admin/dbos', label: 'DBOS' },
  { href: '/admin/coordination', label: 'Coordination' },
  { href: '/admin/cupboard-moderation', label: 'Cupboard', term: 'cupboard' },
];

export default function AdminShell({
  title = 'Admin',
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  const lex = useLexicon();
  const pathname = useRouterState({ select: (s) => s.location.pathname }) || '/admin/run';
  const activeTab = TABS.find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`)) ?? TABS[0];

  return (
    <div className="pc-adminshell">
      <header className="pc-adminshell__header">
        <div className="pc-adminshell__copy">
          <span className="pc-adminshell__kicker">Admin console</span>
          <h1>{title}</h1>
        </div>
        <Tabs.Root value={activeTab.href} className="pc-adminshell__tabs">
          <Tabs.List className="pc-adminshell__tablist" aria-label="Admin sections">
            {TABS.map((tab) => (
              <Tabs.Trigger key={tab.href} value={tab.href} asChild className="pc-adminshell__tab">
                <Link to={tab.href}>{tab.term ? lex(tab.term) : tab.label}</Link>
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </Tabs.Root>
        <span className="pc-adminshell__spacer" />
        <span className="pc-adminshell__host">localhost · :3055</span>
      </header>
      <div className="pc-adminshell__body">{children}</div>
      <style>{`
        .pc-adminshell {
          display: flex;
          flex-direction: column;
          min-height: calc(100vh - 56px);
          background:
            radial-gradient(circle at top left, rgba(56, 189, 248, 0.06), transparent 28%),
            linear-gradient(180deg, rgba(5, 12, 22, 0.99), rgba(4, 10, 18, 1));
        }
        .pc-adminshell__header {
          display: flex;
          align-items: flex-end;
          gap: 16px;
          padding: 14px 18px 12px;
          border-bottom: 1px solid rgba(125, 211, 252, 0.14);
          background:
            linear-gradient(180deg, rgba(7, 16, 29, 0.98), rgba(6, 13, 24, 0.98));
          box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.02);
        }
        .pc-adminshell__copy {
          display: grid;
          gap: 4px;
          min-width: 0;
        }
        .pc-adminshell__kicker {
          color: rgba(186, 230, 253, 0.64);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0.11em;
          line-height: 1;
          text-transform: uppercase;
        }
        .pc-adminshell__header h1 {
          margin: 0;
          font-size: 28px;
          font-weight: 760;
          line-height: 1;
          letter-spacing: -0.02em;
          color: #f4fbff;
        }
        .pc-adminshell__tabs {
          align-self: stretch;
          display: flex;
          align-items: flex-end;
        }
        .pc-adminshell__tablist {
          display: inline-flex;
          align-items: flex-end;
          gap: 6px;
          padding: 0 0 1px;
        }
        .pc-adminshell__tab {
          display: inline-flex;
          align-items: center;
          min-height: 34px;
          padding: 0 12px;
          border: 1px solid rgba(125, 211, 252, 0.14);
          border-bottom-color: rgba(125, 211, 252, 0.08);
          border-radius: 10px 10px 0 0;
          background: rgba(255, 255, 255, 0.02);
          color: rgba(214, 236, 248, 0.72);
          font-size: 12px;
          font-weight: 650;
          letter-spacing: 0.02em;
          text-decoration: none !important;
          transition: background-color 120ms, border-color 120ms, color 120ms, transform 120ms;
        }
        .pc-adminshell__tab:hover {
          color: #eff8ff;
          background: rgba(12, 24, 38, 0.96);
          border-color: rgba(125, 211, 252, 0.28);
          text-decoration: none !important;
        }
        .pc-adminshell__tab[aria-selected="true"] {
          color: #f7fdff;
          background:
            linear-gradient(180deg, rgba(17, 34, 53, 0.98), rgba(10, 20, 33, 0.99));
          border-color: rgba(103, 232, 249, 0.38);
          border-bottom-color: rgba(7, 16, 29, 0.98);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
          transform: translateY(1px);
        }
        .pc-adminshell__tab:focus-visible {
          outline: 2px solid rgba(103, 232, 249, 0.58);
          outline-offset: 2px;
        }
        .pc-adminshell__spacer { flex: 1; }
        .pc-adminshell__host {
          align-self: center;
          padding: 5px 10px;
          border: 1px solid rgba(125, 211, 252, 0.12);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.025);
          color: rgba(186, 230, 253, 0.68);
          font-size: 11px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .pc-adminshell__body {
          flex: 1;
          min-height: 0;
          overflow: auto;
        }
      `}</style>
    </div>
  );
}
