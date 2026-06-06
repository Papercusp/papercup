/**
 * Dev admin rail (plan dev-admin-sidebar-2026-06-05) — a collapsible, DEV-ONLY
 * right rail that re-presents the URL-only /admin surfaces + SU dev glances as one
 * always-at-hand cockpit while working.
 *
 * Gating: this component is mounted only behind `import.meta.env.MODE !==
 * 'production'` (in __root.tsx, via a dev-gated lazy import) so it is ABSENT from
 * production / user builds — it never ships to users (D-001). MODE (not DEV) is
 * the gate because Vite ties DEV/PROD to the command, and the desktop dev shell
 * runs `vite build --mode development` (a build, so DEV===false) — see __root.tsx.
 * Don't add an unconditional import of it anywhere.
 *
 * State (D-005, per the nuqs-default): open/collapsed + the active accordion
 * section live in the URL (`?devRail=1&devSec=flags`), so the rail is deep-linkable
 * and agent-driveable (ui:get_state / ui:dispatch read/write the URL). Exactly one
 * section is open at a time; only the open section's body is mounted, so an
 * inactive panel's SSE/queries never run.
 */
import { lazy, Suspense } from 'react';
import { useQueryState, parseAsBoolean, parseAsStringLiteral } from 'nuqs';
import {
  Flag,
  Terminal,
  Bell,
  Activity,
  Rocket,
  Database,
  Users,
  X,
  ChevronRight,
  FlaskConical,
} from 'lucide-react';
import { RAIL_CSS } from './dev-admin-rail.styles';

// Heavy panels are lazy so opening the rail (not loading the app) pays for them.
const FlagsPanel = lazy(() => import('./panels/FlagsPanel'));
const RunPanel = lazy(() => import('./panels/RunPanel'));
const NotificationsPanel = lazy(() => import('./panels/NotificationsPanel'));
const ServiceHealthPanel = lazy(() => import('./panels/ServiceHealthPanel'));
const DeployStatePanel = lazy(() => import('./panels/DeployStatePanel'));
const DbHealthPanel = lazy(() => import('./panels/DbHealthPanel'));
const FleetPanel = lazy(() => import('./panels/FleetPanel'));

const SECTIONS = [
  { id: 'flags', label: 'Feature flags', icon: Flag, render: () => <FlagsPanel /> },
  { id: 'run', label: 'Run', icon: Terminal, render: () => <RunPanel /> },
  { id: 'notifications', label: 'Notifications / errors', icon: Bell, render: (a: boolean) => <NotificationsPanel active={a} /> },
  { id: 'health', label: 'Service health', icon: Activity, render: (a: boolean) => <ServiceHealthPanel active={a} /> },
  { id: 'deploy', label: 'Deploy / release gate', icon: Rocket, render: (a: boolean) => <DeployStatePanel active={a} /> },
  { id: 'db', label: 'DB health', icon: Database, render: (a: boolean) => <DbHealthPanel active={a} /> },
  { id: 'fleet', label: 'Fleet / coord', icon: Users, render: (a: boolean) => <FleetPanel active={a} /> },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];
const SECTION_IDS = SECTIONS.map((s) => s.id) as unknown as SectionId[];

export default function DevAdminRail() {
  const [open, setOpen] = useQueryState('devRail', parseAsBoolean.withDefault(false));
  const [section, setSection] = useQueryState(
    'devSec',
    parseAsStringLiteral(SECTION_IDS).withDefault('flags'),
  );

  // Collapsed: render only the edge handle (nothing else mounted → no queries).
  if (!open) {
    return (
      <>
        <style>{RAIL_CSS}</style>
        <button
          type="button"
          className="pcdar__handle"
          data-testid="dev-admin-rail-handle"
          onClick={() => setOpen(true)}
          aria-label="Open dev admin rail"
        >
          <span className="pcdar__handle-dot" aria-hidden="true" />
          Dev
        </button>
      </>
    );
  }

  return (
    <>
    <style>{RAIL_CSS}</style>
    <aside className="pcdar" data-testid="dev-admin-rail" aria-label="Dev admin rail">
      <div className="pcdar__header">
        <span className="pcdar__title">
          <FlaskConical size={14} aria-hidden="true" />
          Dev admin
          <span className="pcdar__title-badge">DEV</span>
        </span>
        <span className="pcdar__spacer" />
        <button
          type="button"
          className="pcdar__iconbtn"
          onClick={() => setOpen(false)}
          aria-label="Close dev admin rail"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="pcdar__acc">
        {SECTIONS.map((s) => {
          const isActive = s.id === section;
          const Icon = s.icon;
          return (
            <div key={s.id} className={`pcdar__sec${isActive ? ' is-active' : ''}`}>
              <button
                type="button"
                className="pcdar__sec-head"
                data-testid={`dev-rail-sec-${s.id}`}
                aria-expanded={isActive}
                onClick={() => setSection(s.id)}
              >
                <span className="pcdar__sec-icon">
                  <Icon size={15} aria-hidden="true" />
                </span>
                <span className="pcdar__sec-label">{s.label}</span>
                <span className="pcdar__sec-chevron">
                  <ChevronRight size={15} aria-hidden="true" />
                </span>
              </button>
              {isActive && (
                <div className="pcdar__sec-body">
                  <Suspense fallback={<div className="pcdar-panel__empty">Loading…</div>}>
                    {s.render(true)}
                  </Suspense>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
    </>
  );
}
