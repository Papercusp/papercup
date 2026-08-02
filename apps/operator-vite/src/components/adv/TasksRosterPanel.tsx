/**
 * TasksRosterPanel — the Task Manager dropdown body (WI-6844).
 *
 * The popover face of the task manager, opened by TasksRunningPill. It is NOT
 * TasksClient: that is a 780px-prose full admin page and stays exactly where it
 * is at /admin/tasks. This is the same data re-laid-out for a 620px popover, in
 * the idiom the owner asked it to match — AgentsRunningPill's roster (grouped
 * scrolling rows, hover-to-preview detail strip, a footer out to the full view).
 *
 * ── What this shows that the ledger alone cannot ──
 * Two row sources, deliberately kept visually distinct rather than merged:
 *
 *   LEDGER rows   — enrolled tasks, with the provenance a process table cannot
 *                   give: who launched it, for which work-item, under what budget.
 *   SCANNED rows  — `liveProcesses`, every process actually running (WI-6475).
 *                   An `owned:false` row is inside our signature but was never
 *                   enrolled by a chokepoint; it renders in the unenrolled style
 *                   because that gap is the point, not an implementation detail
 *                   to hide. P-009 is what shrinks this group toward empty.
 *
 * Merging them would imply a provenance the scanned rows do not have. Separating
 * them makes "every Papercusp process is visible here" true today, while keeping
 * "we know who started this" honest.
 *
 * READ-ONLY, like the page it mirrors: kill / freeze / limit are the capability-
 * gated `processes:*` tools, and a dashboard must not be able to end someone's
 * work. The footer links out for anything actionable.
 */
import { useMemo } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import type {
  TaskInventory,
  TaskInventoryRow,
  LiveProcessRow,
} from '@papercusp/operator-core/lib/task-manager/inventory';

/** `live` is `unknown` on TaskInventory — the scan's own shape, narrowed here. */
type LiveScan = {
  alive?: number;
  stranded?: number;
  unaccounted?: number | { cgroupPath: string; pids: number[]; sample: string }[];
  foreign?: number;
  degraded?: boolean;
  degradedReason?: string;
  scan?: { processes: number; ownedTruncated: boolean; foreignTruncated: boolean };
};

const CLASS_GLYPH: Record<string, string> = {
  'agent-session': '◆',
  'bash-job': '▪',
  sidecar: '⬢',
  routine: '⟳',
  build: '⬒',
};

/** Bytes → a 3-significant-figure human size. Pure. */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** An ISO start → a compact age like `4s` / `12m` / `6h`. Pure. */
export function fmtAge(startedAt: string | null | undefined, nowMs: number): string {
  if (!startedAt) return '—';
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * `node …/foo/bar.ts --flag` → `bar.ts`.
 *
 * The original version skipped INTERPRETER names but not FLAGS, so the first
 * surviving token was frequently the flag itself. Measured against the live scan
 * (647 rows, 2026-08-02), 321 of them — just under half — rendered as a bare flag
 * or shell builtin: `-lc` ×188, `--require` ×65, `-c` ×55, `exec` ×48. Owner-reported
 * as "why am i seeing so many tasks like this — `-lc` pid 1623888".
 *
 * Two things make this harder than dropping tokens that start with `-`:
 *
 *  1. Some flags CONSUME the next token (`node --require <loader> real-script.ts`),
 *     so blindly skipping only the flag promotes the loader shim instead.
 *  2. `/proc/<pid>/cmdline` is captured TRUNCATED at 300 chars, so for a shell
 *     wrapper like `bash -lc 'trap … ; exec real-thing'` the actual command is
 *     genuinely not present in the string. No parser can recover it.
 *
 * (2) is why this returns an honest shell shape (`bash -lc`) rather than digging for
 * something command-like: inventing a confident label from a truncated wrapper is how
 * the pane would end up asserting something it cannot know. A vague-but-true label is
 * the right failure mode for a diagnostic surface — the full cmdline is still on the
 * row's `title` tooltip.
 *
 * Pure.
 */
const CMD_INTERPRETERS = /^(node|npx|npm|pnpm|yarn|bash|sh|zsh|dash|python3?|tsx|ts-node|env)$/;
/** Shell builtins/keywords that are never the interesting command. */
const CMD_SHELL_NOISE = /^(exec|trap|source|cd|set|shopt|export|eval|command|nohup|builtin|unalias|unset|echo|true|false|then|do|fi|done|if|while)$/;
/** Flags that swallow the FOLLOWING token, which must not be mistaken for the script. */
const CMD_VALUE_FLAGS = /^(-r|--require|--import|--loader|--experimental-loader|--conditions|-e|--eval|--max-old-space-size)$/;
/** Looks like a thing you actually run. */
const CMD_SCRIPT_RE = /\.(mjs|cjs|js|mts|cts|ts|tsx|py|sh)$/;

function cmdBase(tok: string): string {
  return tok.replace(/^['"]+/, '').replace(/['"]+$/, '').replace(/.*\//, '');
}

export function shortCmd(cmdline: string | null): string {
  if (!cmdline) return '—';
  const raw = cmdline.trim();
  if (raw.length === 0) return '—';
  const parts = raw.split(/\s+/);

  const argv0 = cmdBase(parts[0] ?? '');
  const shellFlagIdx = parts.findIndex((p) => /^-[a-z]*c$/.test(p));
  const isShellWrapper = /^(bash|sh|zsh|dash)$/.test(argv0) && shellFlagIdx > 0;

  // A shell -c/-lc wrapper: the interesting thing is inside the script body. Take the
  // FIRST script-like token there (what is being sourced/run), never a later one from
  // the `&&`-chain, and never something under node_modules (a loader shim, not the job).
  if (isShellWrapper) {
    const body = parts.slice(shellFlagIdx + 1);
    const script = body.find((p) => CMD_SCRIPT_RE.test(cmdBase(p)) && !p.includes('node_modules'));
    if (script) return cmdBase(script);
    // Truncated or pure-shell body — say what it honestly is.
    return `${argv0} ${parts[shellFlagIdx]}`;
  }

  const candidates: string[] = [];
  for (let i = 1; i <= parts.length - 1; i++) {
    const tok = parts[i];
    if (CMD_VALUE_FLAGS.test(tok)) { i++; continue; } // skip the flag AND its value
    if (tok.startsWith('-')) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue; // FOO=bar env assignment
    const b = cmdBase(tok);
    if (b.length === 0) continue;
    if (CMD_INTERPRETERS.test(b) || CMD_SHELL_NOISE.test(b)) continue;
    if (tok.includes('node_modules')) continue;
    candidates.push(tok);
  }

  const script = candidates.find((p) => CMD_SCRIPT_RE.test(cmdBase(p)));
  const picked = script ?? candidates[0];
  if (picked) return cmdBase(picked);

  // Nothing but interpreter + flags (e.g. a bare `node`): the argv0 IS the answer.
  return argv0.length > 0 ? argv0 : raw.slice(0, 40);
}

/** Unaccounted cgroup groups, whichever of the two shapes the scan used. Pure. */
export function unaccountedGroups(live: LiveScan | null): { cgroupPath: string; pids: number[]; sample: string }[] {
  const u = live?.unaccounted;
  return Array.isArray(u) ? u : [];
}

/** Group ledger rows by class, stable order, biggest group first. Pure. */
export function groupByClass(rows: TaskInventoryRow[]): { cls: string; rows: TaskInventoryRow[] }[] {
  const by = new Map<string, TaskInventoryRow[]>();
  for (const r of rows) {
    const list = by.get(r.class) ?? [];
    list.push(r);
    by.set(r.class, list);
  }
  return [...by.entries()]
    .map(([cls, list]) => ({ cls, rows: list }))
    .sort((a, b) => b.rows.length - a.rows.length || a.cls.localeCompare(b.cls));
}

export default function TasksRosterPanel({ active }: { active: boolean }) {
  const [qRaw, setQ] = useQueryState('tasksQ', parseAsString);
  const q = typeof qRaw === 'string' ? qRaw : '';

  // `live: true` walks the cgroup tree — that is the whole point of this panel
  // (it is what makes every process visible), and it is why `active` gates the
  // query rather than merely hiding the output.
  const query = useSyncQuery<TaskInventory>({
    queryName: 'taskManager.inventory',
    args: active ? { live: true } : {},
    staleTime: 5_000,
  });

  const data = (query.data as TaskInventory[] | undefined)?.[0] ?? null;
  const live = (data?.live ?? null) as LiveScan | null;
  const nowMs = Date.now();

  const needle = q.trim().toLowerCase();
  const match = (...fields: (string | null | undefined)[]) =>
    needle.length === 0 || fields.some((f) => (f ?? '').toLowerCase().includes(needle));

  const ledger = useMemo(
    () => (data?.rows ?? []).filter((r) => match(r.title, r.launchedBy, r.workItemId, r.planSlug, r.class, r.scopeUnit)),
    [data?.rows, needle],
  );
  const scanned = useMemo(
    () => (data?.liveProcesses ?? []).filter((p: LiveProcessRow) => match(p.cmdline, p.cgroupPath)),
    [data?.liveProcesses, needle],
  );
  const groups = useMemo(() => groupByClass(ledger), [ledger]);
  const unenrolled = useMemo(() => scanned.filter((p: LiveProcessRow) => !p.owned), [scanned]);
  const orphans = unaccountedGroups(live);

  if (!data) {
    return <div className="pc-tasks-roster__loading" data-testid="tasks-roster-loading">Scanning…</div>;
  }

  return (
    <div className="pc-tasks-roster" role="group" aria-label="Task manager" data-testid="tasks-roster">
      {/* Summary before detail. `scan.processes` is the honest process total —
          strictly larger than the ledger count until every seam enrols. */}
      <dl className="pc-tasks-roster__pressure">
        <div><dt>Enrolled</dt><dd>{data.summary.total}</dd></div>
        <div><dt>Scanned</dt><dd>{live?.scan?.processes ?? '—'}</dd></div>
        <div><dt>Stranded</dt><dd className={live?.stranded ? 'is-warn' : ''}>{live?.stranded ?? '—'}</dd></div>
        <div><dt>Unaccounted</dt><dd className={orphans.length ? 'is-bad' : ''}>{orphans.length || '0'}</dd></div>
      </dl>

      {live?.degraded && (
        <div className="pc-tasks-roster__alarm is-warn" data-testid="tasks-degraded">
          ⚠ Live scan degraded — {live.degradedReason}. Rows below are the ledger's; nothing is being closed out while
          the scan cannot be trusted.
        </div>
      )}

      {orphans.length > 0 && (
        <div className="pc-tasks-roster__alarm" data-testid="tasks-unaccounted">
          <strong>{orphans.length} unaccounted cgroup{orphans.length === 1 ? '' : 's'}</strong>
          <span>Running inside our slice with no ledger row — something spawned outside a chokepoint.</span>
        </div>
      )}

      <div className="pc-tasks-roster__search">
        <input
          type="text"
          value={q}
          onChange={(e) => void setQ(e.target.value || null)}
          placeholder="Search command, agent, work-item, plan, scope unit…"
          aria-label="Search tasks"
          data-testid="tasks-search"
        />
      </div>

      <div className="pc-tasks-roster__scroll" data-testid="tasks-roster-scroll">
        {groups.map((g) => (
          <section key={g.cls} className="pc-tasks-roster__group">
            <header className="pc-tasks-roster__group-head">
              <span aria-hidden>{CLASS_GLYPH[g.cls] ?? '·'}</span> {g.cls}
              <span className="pc-tasks-roster__group-count">({g.rows.length})</span>
            </header>
            {g.rows.map((r) => (
              <div
                key={r.taskId}
                className={`pc-tasks-roster__row${r.confined ? '' : ' is-unconfined'}`}
                data-testid={`task-row-${r.taskId}`}
                data-state={r.state}
              >
                <span className="pc-tasks-roster__age">{fmtAge(r.startedAt, nowMs)}</span>
                <span className="pc-tasks-roster__name" title={r.scopeUnit ?? r.taskId}>
                  {r.title || shortCmd(null) || r.taskId}
                </span>
                <span className="pc-tasks-roster__doing" title={r.launchedBy}>
                  {r.workItemId && <span className="pc-tasks-roster__wi">{r.workItemId}</span>}
                  {r.launchedBy}
                </span>
                <span className="pc-tasks-roster__num">{fmtBytes(r.rssBytes)}</span>
                <span className="pc-tasks-roster__num">{r.pids ?? '—'}</span>
              </div>
            ))}
          </section>
        ))}

        {/* The gap, shown rather than hidden. These are real Papercusp processes
            the scan saw that no chokepoint enrolled, so they have a command line
            and nothing else — no work-item, no budget, no owner. */}
        {unenrolled.length > 0 && (
          <section className="pc-tasks-roster__group">
            <header className="pc-tasks-roster__group-head is-bad">
              <span aria-hidden>○</span> unenrolled
              <span className="pc-tasks-roster__group-count">({unenrolled.length})</span>
              <span className="pc-tasks-roster__chip">no ledger row — provenance unknown</span>
            </header>
            {unenrolled.map((p: LiveProcessRow) => (
              <div
                key={p.pid}
                className="pc-tasks-roster__row is-orphan"
                data-testid={`task-scanned-${p.pid}`}
              >
                <span className="pc-tasks-roster__age">—</span>
                <span className="pc-tasks-roster__name" title={p.cmdline ?? ''}>{shortCmd(p.cmdline)}</span>
                <span className="pc-tasks-roster__doing" title={p.cgroupPath}>pid {p.pid}</span>
                <span className="pc-tasks-roster__num">—</span>
                <span className="pc-tasks-roster__num">—</span>
              </div>
            ))}
          </section>
        )}

        {groups.length === 0 && unenrolled.length === 0 && (
          <div className="pc-tasks-roster__empty" data-testid="tasks-roster-empty">
            {needle ? `Nothing matches “${q}”.` : 'Nothing running.'}
          </div>
        )}
      </div>

      <div className="pc-tasks-roster__foot">
        <span>
          {live?.scan?.ownedTruncated || live?.scan?.foreignTruncated
            ? 'Scan capped — some processes are not listed'
            : 'Ledger + kernel scan agree'}
        </span>
        <a href="/admin/tasks">Open full Task Manager →</a>
      </div>
    </div>
  );
}
