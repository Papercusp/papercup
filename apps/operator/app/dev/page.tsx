/**
 * /dev — cross-harness, cross-workspace developer console.
 *
 * Three-pane shell: left rail (workspace picker + tabs), main content,
 * right rail (live state). Every tab is built on top of the
 * function-as-truth tool registry so adding a new MCP tool surfaces here
 * on next refresh without any per-tool code.
 */
'use client';

import { Suspense, useState } from 'react';
import dynamic from 'next/dynamic';
import WorkspacePicker from './_components/WorkspacePicker';
import RightRail from './_components/RightRail';

const ApiTab = dynamic(() => import('./_components/ApiTab'), { ssr: false });
const HarnessesTab = dynamic(() => import('./_components/HarnessesTab'), { ssr: false });
const SessionsTab = dynamic(() => import('./_components/SessionsTab'), { ssr: false });
const TelemetryTab = dynamic(() => import('./_components/TelemetryTab'), { ssr: false });
const AuditTab = dynamic(() => import('./_components/AuditTab'), { ssr: false });
const PgTab = dynamic(() => import('./_components/PgTab'), { ssr: false });
const ProcessesTab = dynamic(() => import('./_components/ProcessesTab'), { ssr: false });

type TabId = 'harnesses' | 'api' | 'sessions' | 'telemetry' | 'audit' | 'pg' | 'processes';

const TABS: { id: TabId; label: string }[] = [
  { id: 'harnesses', label: 'Harnesses' },
  { id: 'api', label: 'API' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'audit', label: 'Audit' },
  { id: 'pg', label: 'PG' },
  { id: 'processes', label: 'Processes' },
];

export default function DevPage() {
  const [tab, setTab] = useState<TabId>('api');
  // null = all workspaces; otherwise specific ids
  const [workspaceIds, setWorkspaceIds] = useState<string[] | null>(null);

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
          {tab === 'api' && <ApiTab workspaceIds={workspaceIds} />}
          {tab === 'harnesses' && <HarnessesTab workspaceIds={workspaceIds} />}
          {tab === 'sessions' && <SessionsTab workspaceIds={workspaceIds} />}
          {tab === 'telemetry' && <TelemetryTab workspaceIds={workspaceIds} />}
          {tab === 'audit' && <AuditTab workspaceIds={workspaceIds} />}
          {tab === 'pg' && <PgTab />}
          {tab === 'processes' && <ProcessesTab />}
        </Suspense>
      </main>
      <aside className="pc-dev-right">
        <RightRail workspaceIds={workspaceIds} />
      </aside>
    </div>
  );
}
