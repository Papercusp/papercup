/**
 * AutomationPane — the shared body behind the Blender (learning) and Docs tabs.
 *
 * WHY (owner ask 2026-07-25): cron-spawned agents were consuming the owner's
 * weekly Claude limit with no surface to see or stop them. They are EPHEMERAL —
 * spawn, take a few turns, exit — so the agents-running roster reads empty while
 * spend is continuous, and there was nothing to click. This pane is that surface:
 * every scheduled routine in a category, which ones can COST TOKENS, and a
 * one-click pause for each (and for the whole category).
 *
 * Narrow-rail idiom mirrors MugTab / OverwatchTab: vertical sections, `{ active }`
 * gated so queries only run while the tab is open, data via useSyncQuery, writes
 * through the audited run-tool bridge (`routines:set` / `routines:group-set`).
 *
 * The spend section reports 7d cost BY ROLE, deliberately not per-routine — there
 * is no link from a usage row back to the routine that spawned it, so a per-routine
 * number would be a guess rendered as fact. See lib/automation/catalog.ts.
 */
import { useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { AlertTriangle, Coins, Pause, Play, Zap } from 'lucide-react';
import { Tooltip } from '@/app/harness/Tooltip';
import type {
  AutomationCatalog,
  AutomationCategory,
  AutomationRoutine,
} from '@papercusp/operator-core/lib/automation/catalog';

/** Fire a routine control tool through the gated/audited run-tool bridge (mirrors OverwatchTab). */
async function runRoutineTool(
  name: 'routines:set' | 'routines:group-set',
  args: Record<string, unknown>,
): Promise<void> {
  const res = await fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args, confirmed: true }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    result?: { content?: Array<{ text?: string }> };
  };
  if (!res.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  const text = body.result?.content?.[0]?.text;
  if (text) {
    const payload = JSON.parse(text) as { ok?: boolean; message?: string };
    if (payload.ok === false) throw new Error(payload.message ?? `${name} refused`);
  }
}

function agoLabel(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 0) return 'now';
  const min = ms / 60000;
  if (min < 1) return 'just now';
  if (min < 90) return `${Math.round(min)}m ago`;
  const hr = min / 60;
  if (hr < 36) return `${Math.round(hr)}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function usd(n: number): string {
  if (n >= 100) return `$${Math.round(n)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

export interface AutomationPaneProps {
  active: boolean;
  /** Which categories this pane owns. Blender → ['learning'], Docs → ['docs']. */
  categories: readonly AutomationCategory[];
  title: string;
  blurb: string;
  /** Roles whose 7d spend belongs to this pane's story (empty ⇒ show all). */
  spendRoles?: readonly string[];
}

export default function AutomationPane({ active, categories, title, blurb, spendRoles }: AutomationPaneProps) {
  const cat = useSyncQuery<AutomationCatalog>({
    queryName: 'automation.catalog',
    args: {},
    staleTime: 20_000,
    enabled: active,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // useSyncQuery always yields an ARRAY (SyncQueryResult<T>.data is T[]); the
  // resolver returns a single catalog row, so unwrap it.
  const data = cat.data?.[0] ?? null;

  const rows: AutomationRoutine[] = useMemo(() => {
    if (!data) return [];
    return data.routines
      .filter((r) => categories.includes(r.category))
      // Agent-spawning (costly) first, then active, then name — the owner is here
      // to find what is spending money, so it must never be below the noise.
      .sort(
        (a, b) =>
          Number(b.spawnsAgent) - Number(a.spawnsAgent) ||
          Number(b.active) - Number(a.active) ||
          a.name.localeCompare(b.name),
      );
  }, [data, categories]);

  const activeSpawning = rows.filter((r) => r.active && r.spawnsAgent).length;

  const spend = useMemo(() => {
    if (!data) return [];
    const list = spendRoles?.length
      ? data.spend7d.filter((s) => spendRoles.includes(s.role))
      : data.spend7d;
    return list.slice(0, 6);
  }, [data, spendRoles]);

  const spendTotal = spend.reduce((a, b) => a + b.costUsd, 0);

  async function toggleRoutine(r: AutomationRoutine) {
    const key = `${r.installSlug}/${r.name}`;
    setBusy(key);
    setErr(null);
    try {
      await runRoutineTool('routines:set', {
        name: r.name,
        installSlug: r.installSlug,
        active: !r.active,
      });
      cat.invalidate?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function pauseAll(nextActive: boolean) {
    setBusy('__all__');
    setErr(null);
    try {
      // No group-set here: this pane's categories are an owner-facing grouping that
      // does NOT map 1:1 to a routine group_slug (a docs routine can be filed under
      // health). Pausing each member by name is the only way the button does exactly
      // what its label says — and it never touches a routine outside this pane.
      for (const r of rows.filter((x) => x.spawnsAgent && x.active !== nextActive)) {
        await runRoutineTool('routines:set', {
          name: r.name,
          installSlug: r.installSlug,
          active: nextActive,
        });
      }
      cat.invalidate?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!active) return null;

  return (
    <div className="pclsb-panel pc-auto">
      <div className="pclsb-panel__bar">
        <span className="pclsb-panel__bar-label">{title}</span>
        <span className="pclsb-panel__bar-spacer" />
        {activeSpawning > 0 && (
          <Tooltip label={`${activeSpawning} scheduled agent${activeSpawning === 1 ? '' : 's'} can spend tokens`} side="bottom">
            <span className="pc-auto__pill pc-auto__pill--live">
              <Zap size={11} aria-hidden="true" /> {activeSpawning} live
            </span>
          </Tooltip>
        )}
      </div>

      <p className="pc-auto__blurb">{blurb}</p>

      {cat.loading && !data && <div className="pclsb-panel__empty">Loading…</div>}
      {cat.error && <div className="pclsb-panel__error">{String(cat.error)}</div>}
      {err && <div className="pclsb-panel__error">{err}</div>}

      {data && rows.length === 0 && (
        <div className="pclsb-panel__empty">
          No scheduled agents in this category. Nothing here is consuming tokens.
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="pc-auto__actions">
            <button
              type="button"
              className="pc-auto__btn pc-auto__btn--danger"
              disabled={busy !== null || activeSpawning === 0}
              onClick={() => void pauseAll(false)}
              data-testid="automation-pause-all"
            >
              <Pause size={12} aria-hidden="true" /> Pause all
            </button>
            <button
              type="button"
              className="pc-auto__btn"
              disabled={busy !== null}
              onClick={() => void pauseAll(true)}
              data-testid="automation-resume-all"
            >
              <Play size={12} aria-hidden="true" /> Resume all
            </button>
          </div>

          <div className="pc-auto__list" role="list">
            {rows.map((r) => {
              const key = `${r.installSlug}/${r.name}`;
              return (
                <div
                  key={key}
                  role="listitem"
                  className={`pc-auto__row${r.active ? ' is-active' : ''}`}
                  data-testid={`automation-row-${r.name}`}
                >
                  <div className="pc-auto__row-main">
                    <span className="pc-auto__name" title={key}>
                      {r.name}
                    </span>
                    <span className="pc-auto__meta">
                      {r.cadence ?? 'event-driven'}
                      {r.spawnsAgent && (
                        <Tooltip label="This routine spawns a model-backed agent — it costs tokens when it fires" side="top">
                          <span className="pc-auto__tokenflag">
                            <Coins size={10} aria-hidden="true" /> tokens
                          </span>
                        </Tooltip>
                      )}
                    </span>
                    <span className="pc-auto__when">last {agoLabel(r.lastFiredAt)}</span>
                  </div>
                  <button
                    type="button"
                    className={`pc-auto__toggle${r.active ? ' is-on' : ''}`}
                    disabled={busy !== null}
                    aria-pressed={r.active}
                    aria-label={`${r.active ? 'Pause' : 'Resume'} ${r.name}`}
                    onClick={() => void toggleRoutine(r)}
                    data-testid={`automation-toggle-${r.name}`}
                  >
                    {busy === key ? '…' : r.active ? <Pause size={12} /> : <Play size={12} />}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {spend.length > 0 && (
        <div className="pc-auto__section">
          <div className="pc-auto__section-head">
            <Coins size={12} aria-hidden="true" /> Spend · last 7 days
            <span className="pclsb-panel__bar-spacer" />
            <strong>{usd(spendTotal)}</strong>
          </div>
          {spend.map((s) => (
            <div className="pc-auto__spend-row" key={`${s.role}:${s.modelClass ?? ''}`}>
              <span className="pc-auto__spend-role">
                {s.role}
                {s.modelClass && <em> · {s.modelClass}</em>}
              </span>
              <span className="pc-auto__spend-turns">{s.turns.toLocaleString()} turns</span>
              <span className="pc-auto__spend-usd">{usd(s.costUsd)}</span>
            </div>
          ))}
          <p className="pc-auto__foot">
            <AlertTriangle size={10} aria-hidden="true" /> Cost is grouped by agent role, not by
            routine — usage rows carry no link back to the schedule that spawned them.
          </p>
        </div>
      )}
    </div>
  );
}
