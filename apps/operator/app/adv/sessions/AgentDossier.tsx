'use client';

/**
 * AgentDossier — the right-pane detail dossier for one selected agent (plan
 * adv-sessions-live-roster-2026-06-02, P-007). Renders the full Tier-1..3 set
 * for ANY agent in the roster, including presence-only shells with no
 * adv_sessions row:
 *
 *   Tier-1/2 (free) — comes from the already-loaded RosterEntry: intent, files,
 *     host/pid, role/feature/plan, mode + terminal handles, session age.
 *   Tier-3 (lazy) — fetched through agentDetail.byOwner on selection:
 *     SU locks held + waiting (with blockers)
 *     and coord state (last message, unread, open handoffs/escalations).
 *
 * The files list is cross-marked with the agent's own lock state (L = holds a
 * lock on it, W = waiting on it) so "what is this agent touching / contending"
 * reads at a glance.
 */

import { useSyncQuery } from '@papercusp/sync';
import { formatRelativeUpdated } from '@papercusp/operator-core/lib/format/relative-time';
import { LivenessDot } from '@/app/coord/presence-ui';
import type { NativeSessionHandle, RosterEntry } from './SessionsRosterView';

// ── Server DTO mirror (apps/operator/lib/adv-agent-detail.ts). Inlined, not
//    imported, so this client component never pulls the PG-backed server module.
interface LockHeld {
  path: string;
  intent: string;
  acquiredAt: string;
  expiresAt: string;
}
interface LockBlocker {
  path: string;
  holder: string;
  holderLabel: string | null;
  intent: string;
  expiresAt: string;
}
interface LockWaiting {
  ticketId: string;
  paths: string[];
  intent: string;
  aheadCount: number;
  queuedAt: string;
  waitUntil: string;
  blockedBy: LockBlocker[];
}
interface AgentLocks {
  held: LockHeld[];
  waiting: LockWaiting[];
  error: string | null;
}
interface CoordMessageSummary {
  msgId: string;
  from: string;
  to: string[];
  kind: string;
  summary: string;
  ts: string;
  direction: 'inbound' | 'outbound';
}
interface CoordHandoffSummary {
  msgId: string;
  from: string;
  to: string[];
  summary: string;
  ts: string;
  planSlug: string | null;
  nextAction: string | null;
  direction: 'inbound' | 'outbound';
  accepted: boolean;
}
interface CoordEscalationSummary {
  msgId: string;
  severity: 'blocker' | 'question' | 'advisory';
  summary: string;
  ts: string;
  planSlug: string | null;
}
interface AgentCoordState {
  lastMessage: CoordMessageSummary | null;
  unreadCount: number;
  openHandoffs: CoordHandoffSummary[];
  openEscalations: CoordEscalationSummary[];
  error: string | null;
}
interface CodexHomeDiagnostics {
  codexHome: string;
  exists: boolean;
  agentsPath: string;
  agentsExists: boolean;
  configPath: string;
  configExists: boolean;
  hooksPath: string;
  hooksExists: boolean;
  promptsPath: string;
  promptsExists: boolean;
  authPath: string;
  authExists: boolean;
  diagnosticsPath: string;
  diagnosticsExists: boolean;
  diagnostics: {
    lockEnforcement?: string;
    codexPreToolUseStatus?: string;
    requiresExplicitPapercuspLocks?: boolean;
    inheritedPromptsCopied?: boolean;
  } | null;
  latestRolloutId: string | null;
  latestRolloutPath: string | null;
  resumeStrategy: 'codex-resume-last-in-code-home';
  resumeCommand: string;
  error: string | null;
}
export interface AgentDetail {
  ownerId: string;
  locks: AgentLocks;
  coord: AgentCoordState;
  nativeSession: NativeSessionHandle | null;
  codex: CodexHomeDiagnostics | null;
}

function shortSource(s: string): string {
  const v = (s || '').toLowerCase();
  if (v.includes('claude')) return 'claude';
  if (v.includes('codex')) return 'codex';
  if (v.includes('omp')) return 'omp';
  return s || '—';
}

/** "19m left" / "<1m left" / "expired" from an ISO expiry. */
function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'expired';
  const min = Math.round(ms / 60_000);
  return min < 1 ? '<1m left' : `${min}m left`;
}

/** Lazy-load the Tier-3 dossier for one owner id through sync. */
function useAgentDetail(ownerId: string | null): { detail: AgentDetail | null; error: string | null; loading: boolean } {
  const query = useSyncQuery<AgentDetail>({
    queryName: 'agentDetail.byOwner',
    args: ownerId ? { ownerId } : undefined,
    enabled: !!ownerId,
  });
  return {
    detail: query.data?.[0] ?? null,
    error: query.error ? String(query.error) : null,
    loading: query.loading,
  };
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element | null {
  if (value == null || value === '' || value === false) return null;
  return (
    <div className="pc-dossier__meta-row">
      <span className="pc-dossier__meta-key">{label}</span>
      <span className="pc-dossier__meta-val">{value}</span>
    </div>
  );
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function nativeSessionCommand(handle: NativeSessionHandle): string | null {
  if (handle.backend === 'claude') {
    return handle.sessionId ? `claude --resume ${handle.sessionId}` : null;
  }
  if (handle.backend === 'codex') {
    if (!handle.codexHome) return null;
    const prefix = `CODEX_HOME=${shellSingleQuote(handle.codexHome)}`;
    return handle.rolloutId
      ? `${prefix} codex exec resume ${handle.rolloutId}`
      : `${prefix} codex resume --last`;
  }
  return handle.ompThreadId ? `omp -r ${handle.ompThreadId} --approval-mode yolo` : null;
}

export default function AgentDossier({
  ownerId,
  entry,
  onClose,
}: {
  ownerId: string;
  entry: RosterEntry | null;
  onClose: () => void;
}): React.JSX.Element {
  const { detail, error, loading } = useAgentDetail(ownerId);
  const locks = detail?.locks;
  const coord = detail?.coord;
  const codex = detail?.codex;
  const nativeSession = detail?.nativeSession ?? entry?.nativeSession ?? null;

  // Files this agent holds / waits on — to cross-mark the file list.
  const heldPaths = new Set(locks?.held.map((l) => l.path) ?? []);
  const waitPaths = new Set(locks?.waiting.flatMap((w) => w.paths) ?? []);
  const fileMark = (f: string): 'held' | 'waiting' | null =>
    heldPaths.has(f) ? 'held' : waitPaths.has(f) ? 'waiting' : null;

  const client = entry?.agent ?? shortSource(entry?.source ?? '');

  return (
    <aside className="pc-dossier" aria-label="Agent detail">
      <header className="pc-dossier__head">
        <div className="pc-dossier__head-main">
          {entry ? <LivenessDot liveness={entry.liveness} /> : null}
          <span className="pc-roster__badge" data-client={client}>
            {client || '—'}
          </span>
          {entry?.role ? <span className="pc-roster__chip">{entry.role}</span> : null}
          {entry?.feature ? (
            <span className="pc-roster__chip pc-roster__chip--feature">{entry.feature}</span>
          ) : null}
          {entry?.revoked ? (
            <span className="pc-roster__chip pc-roster__chip--warn">revoked</span>
          ) : null}
        </div>
        <button type="button" className="pc-dossier__close" onClick={onClose} aria-label="Close detail">
          ✕
        </button>
      </header>

      <div className="pc-dossier__id" title={ownerId}>
        {entry?.label || ownerId}
      </div>

      {entry ? (
        <div className="pc-dossier__intent">{entry.intent || '(no declared intent)'}</div>
      ) : (
        <div className="pc-dossier__note">This agent is no longer in the live roster.</div>
      )}

      {/* ── Tier-1/2 meta (from the roster entry) ── */}
      {entry ? (
        <section className="pc-dossier__section">
          <MetaRow
            label="liveness"
            value={`${entry.liveness} · active ${formatRelativeUpdated(entry.heartbeatAt)}`}
          />
          <MetaRow label="plan" value={entry.currentPlanSlug} />
          <MetaRow label="started" value={formatRelativeUpdated(entry.startedAt)} />
          <MetaRow label="host" value={entry.host} />
          <MetaRow label="pid" value={entry.pid != null ? String(entry.pid) : null} />
          <MetaRow label="mode" value={entry.mode} />
          <MetaRow label="cwd" value={entry.cwd} />
          <MetaRow label="window" value={entry.windowId} />
          <MetaRow label="omp thread" value={entry.ompThreadId} />
          <MetaRow label="user" value={entry.userId} />
        </section>
      ) : null}

      {nativeSession ? (
        <section className="pc-dossier__section">
          <h4 className="pc-dossier__h">
            Native Session
            <span className="pc-dossier__badge-count">{nativeSession.backend}</span>
            {!nativeSession.exactResumeSupported && nativeSession.missingReason ? (
              <span className="pc-dossier__h-note pc-dossier__h-note--err">
                {' '}
                · {nativeSession.missingReason}
              </span>
            ) : null}
          </h4>
          <MetaRow label="source" value={nativeSession.source} />
          <MetaRow label="exact resume" value={nativeSession.exactResumeSupported ? 'supported' : 'not ready'} />
          <MetaRow label="resume" value={nativeSessionCommand(nativeSession)} />
          {nativeSession.backend === 'claude' ? (
            <MetaRow label="session" value={nativeSession.sessionId ?? 'not recorded'} />
          ) : null}
          {nativeSession.backend === 'codex' ? (
            <>
              <MetaRow label="home" value={nativeSession.codexHome || 'not recorded'} />
              <MetaRow label="rollout" value={nativeSession.rolloutId ?? 'not recorded yet'} />
            </>
          ) : null}
          {nativeSession.backend === 'omp' ? (
            <>
              <MetaRow label="thread" value={nativeSession.ompThreadId ?? 'not linked yet'} />
              <MetaRow label="agent home" value={nativeSession.agentHome} />
            </>
          ) : null}
        </section>
      ) : null}

      {codex ? (
        <section className="pc-dossier__section">
          <h4 className="pc-dossier__h">
            Codex Runtime
            <span className="pc-dossier__badge-count">advanced</span>
            {codex.error ? <span className="pc-dossier__h-note pc-dossier__h-note--err"> · {codex.error}</span> : null}
          </h4>
          <MetaRow label="home" value={codex.codexHome} />
          <MetaRow label="resume" value={codex.resumeCommand} />
          <MetaRow label="rollout" value={codex.latestRolloutId ?? 'not recorded yet'} />
          <MetaRow label="AGENTS.md" value={codex.agentsExists ? codex.agentsPath : 'missing'} />
          <MetaRow label="config.toml" value={codex.configExists ? codex.configPath : 'missing'} />
          <MetaRow label="hooks" value={codex.hooksExists ? 'configured' : 'missing'} />
          <MetaRow label="auth" value={codex.authExists ? 'linked' : 'missing'} />
          <MetaRow label="prompts" value={codex.promptsExists ? 'available' : 'missing'} />
          <MetaRow label="lock status" value={codex.diagnostics?.lockEnforcement ?? 'unknown'} />
          <MetaRow
            label="PreToolUse"
            value={codex.diagnostics?.codexPreToolUseStatus ?? 'unknown'}
          />
          <MetaRow
            label="manual locks"
            value={codex.diagnostics?.requiresExplicitPapercuspLocks ? 'required' : 'not required'}
          />
        </section>
      ) : null}

      {/* ── Files in play (cross-marked with this agent's lock state) ── */}
      {entry && entry.currentFiles.length > 0 ? (
        <section className="pc-dossier__section">
          <h4 className="pc-dossier__h">Files ({entry.currentFiles.length})</h4>
          <ul className="pc-dossier__files">
            {entry.currentFiles.map((f) => {
              const mark = fileMark(f);
              return (
                <li key={f} className="pc-dossier__file" title={f}>
                  <span className="pc-dossier__file-path">{f}</span>
                  {mark === 'held' ? <span className="pc-dossier__lockmark pc-dossier__lockmark--held">L</span> : null}
                  {mark === 'waiting' ? (
                    <span className="pc-dossier__lockmark pc-dossier__lockmark--wait">W</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* ── Locks ── */}
      <section className="pc-dossier__section">
        <h4 className="pc-dossier__h">
          Locks
          {loading && !detail ? <span className="pc-dossier__h-note"> · loading…</span> : null}
          {locks?.error ? <span className="pc-dossier__h-note pc-dossier__h-note--err"> · {locks.error}</span> : null}
        </h4>
        {locks && (locks.held.length > 0 || locks.waiting.length > 0) ? (
          <>
            {locks.held.map((l) => (
              <div key={l.path} className="pc-dossier__lock">
                <span className="pc-dossier__lockmark pc-dossier__lockmark--held">L</span>
                <span className="pc-dossier__file-path">{l.path}</span>
                <span className="pc-dossier__lock-exp">{expiresIn(l.expiresAt)}</span>
                {l.intent ? <span className="pc-dossier__lock-intent">{l.intent}</span> : null}
              </div>
            ))}
            {locks.waiting.map((w) => (
              <div key={w.ticketId} className="pc-dossier__lock">
                <span className="pc-dossier__lockmark pc-dossier__lockmark--wait">W</span>
                <span className="pc-dossier__file-path">{w.paths.join(', ')}</span>
                <span className="pc-dossier__lock-exp">
                  {w.aheadCount === 0 ? 'next' : `${w.aheadCount} ahead`}
                </span>
                {w.blockedBy.length > 0 ? (
                  <span className="pc-dossier__lock-intent">
                    blocked by {w.blockedBy.map((b) => b.holderLabel || b.holder).join(', ')}
                  </span>
                ) : null}
              </div>
            ))}
          </>
        ) : (
          <div className="pc-dossier__empty-line">{detail ? 'No locks held or waiting.' : '—'}</div>
        )}
      </section>

      {/* ── Coord ── */}
      <section className="pc-dossier__section">
        <h4 className="pc-dossier__h">
          Coord
          {coord && coord.unreadCount > 0 ? (
            <span className="pc-dossier__badge-count">{coord.unreadCount} unread</span>
          ) : null}
          {coord?.error ? <span className="pc-dossier__h-note pc-dossier__h-note--err"> · {coord.error}</span> : null}
        </h4>
        {coord ? (
          <>
            {coord.lastMessage ? (
              <div className="pc-dossier__coord-line">
                <span className="pc-dossier__dir" data-dir={coord.lastMessage.direction}>
                  {coord.lastMessage.direction === 'outbound' ? '→' : '←'}
                </span>
                <span className="pc-dossier__coord-text">{coord.lastMessage.summary || '(no summary)'}</span>
                <span className="pc-dossier__coord-ts">{formatRelativeUpdated(coord.lastMessage.ts)}</span>
              </div>
            ) : (
              <div className="pc-dossier__empty-line">No recent messages.</div>
            )}
            {coord.openHandoffs.map((h) => (
              <div key={h.msgId} className="pc-dossier__coord-line">
                <span className="pc-dossier__dir" data-dir={h.direction}>
                  {h.direction === 'outbound' ? 'handoff →' : 'handoff ←'}
                </span>
                <span className="pc-dossier__coord-text">{h.summary || '(handoff)'}</span>
                <span className="pc-dossier__coord-ts">{h.accepted ? 'accepted' : 'open'}</span>
              </div>
            ))}
            {coord.openEscalations.map((e) => (
              <div key={e.msgId} className="pc-dossier__coord-line">
                <span className="pc-dossier__dir pc-dossier__dir--esc" data-sev={e.severity}>
                  {e.severity}
                </span>
                <span className="pc-dossier__coord-text">{e.summary || '(escalation)'}</span>
                <span className="pc-dossier__coord-ts">{formatRelativeUpdated(e.ts)}</span>
              </div>
            ))}
          </>
        ) : (
          <div className="pc-dossier__empty-line">{error ? `Couldn’t load coord: ${error}` : '—'}</div>
        )}
      </section>
    </aside>
  );
}
