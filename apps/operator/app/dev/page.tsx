/**
 * /dev — cross-harness, cross-workspace developer console.
 *
 * Three-pane shell: left rail (workspace picker + tabs), main content,
 * right rail (live state). Every tab is built on top of the
 * function-as-truth tool registry so adding a new MCP tool surfaces here
 * on next refresh without any per-tool code.
 */
'use client';

import { Suspense, useCallback, useState } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import dynamic from 'next/dynamic';
import WorkspacePicker from './_components/WorkspacePicker';
import RightRail from './_components/RightRail';

export interface RerunContext {
  toolName: string;
  workspace?: string;
  harness?: string;
  role?: string;
  run?: string;
  spawn?: string;
  /** Pre-fill the API tab form with these args (post-zod-parse JSON). */
  args?: Record<string, unknown>;
}

const ApiTab = dynamic(() => import('./_components/ApiTab'), { ssr: false });
const HarnessesTab = dynamic(() => import('./_components/HarnessesTab'), { ssr: false });
const SessionsTab = dynamic(() => import('./_components/SessionsTab'), { ssr: false });
const TelemetryTab = dynamic(() => import('./_components/TelemetryTab'), { ssr: false });
const AuditTab = dynamic(() => import('./_components/AuditTab'), { ssr: false });
const PgTab = dynamic(() => import('./_components/PgTab'), { ssr: false });
const ProcessesTab = dynamic(() => import('./_components/ProcessesTab'), { ssr: false });
const StudioTab = dynamic(() => import('./_components/StudioTab'), { ssr: false });
const TablesTab = dynamic(() => import('./_components/TablesTab'), { ssr: false });
const BackupsTab = dynamic(() => import('./_components/BackupsTab'), { ssr: false });

type TabId = 'harnesses' | 'api' | 'sessions' | 'telemetry' | 'audit' | 'pg' | 'processes' | 'tables' | 'studio' | 'backups';

const TABS: { id: TabId; label: string }[] = [
  { id: 'harnesses', label: 'Harnesses' },
  { id: 'api', label: 'API' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'audit', label: 'Audit' },
  { id: 'pg', label: 'PG' },
  { id: 'processes', label: 'Processes' },
  { id: 'tables', label: 'Tables' },
  { id: 'studio', label: 'Drizzle Studio' },
  { id: 'backups', label: 'Backups' },
];

export default function DevPage() {
  // Top-level /dev tab — URL-backed so agents can read it via ui:get_state
  // and switch panels via set_url. nuqs keeps the deep-link working
  // across reloads and lets agents navigate the dev console without
  // a per-tab tool.
  const [tab, setTab] = useQueryState(
    'tab',
    parseAsStringEnum<TabId>([
      'harnesses', 'api', 'sessions', 'telemetry', 'audit',
      'pg', 'processes', 'tables', 'studio', 'backups',
    ]).withDefault('api'),
  );
  // null = all workspaces; otherwise specific ids
  const [workspaceIds, setWorkspaceIds] = useState<string[] | null>(null);
  // Set by Sessions/Telemetry "rerun" → consumed by ApiTab on mount.
  const [rerun, setRerun] = useState<RerunContext | null>(null);

  const rerunAndSwitch = useCallback((ctx: RerunContext) => {
    setRerun(ctx);
    setTab('api');
  }, []);

  return (
    <div className="pc-dev-shell">
      <aside className="pc-dev-left">
        <div className="pc-dev-section">
          <div className="pc-dev-section-label">Workspaces</div>
          <WorkspacePicker selected={workspaceIds} onChange={setWorkspaceIds} />
        </div>
        <nav className="pc-dev-section" aria-label="Dev page tabs">
          <div className="pc-dev-section-label">Tools</div>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`pc-dev-tab ${tab === t.id ? 'is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="pc-dev-main">
        <Suspense fallback={<div className="pc-dev-loading">loading…</div>}>
          {tab === 'api' && (
            <ApiTab workspaceIds={workspaceIds} rerun={rerun} onRerunConsumed={() => setRerun(null)} />
          )}
          {tab === 'harnesses' && <HarnessesTab workspaceIds={workspaceIds} />}
          {tab === 'sessions' && <SessionsTab workspaceIds={workspaceIds} onRerun={rerunAndSwitch} />}
          {tab === 'telemetry' && <TelemetryTab workspaceIds={workspaceIds} onRerun={rerunAndSwitch} />}
          {tab === 'audit' && <AuditTab workspaceIds={workspaceIds} />}
          {tab === 'pg' && <PgTab />}
          {tab === 'processes' && <ProcessesTab />}
          {tab === 'tables' && <TablesTab />}
          {tab === 'studio' && <StudioTab />}
          {tab === 'backups' && <BackupsTab />}
        </Suspense>
      </main>
      <aside className="pc-dev-right">
        <RightRail workspaceIds={workspaceIds} />
      </aside>
    </div>
  );
}
