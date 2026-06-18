/**
 * `system:token-weekly-report` — the SQL-only week-over-week token/spend report
 * (token-usage-reduction-audit-2026-06-09 P-003; the re-measure gate for every
 * reduction item in that plan).
 *
 * Aggregates `harness_shared.agent_usage_samples` for the trailing window vs the
 * window before it (per source, per model class, top roles) and broadcasts one
 * coord notification. Zero LLM calls — pure SQL + string assembly.
 *
 * Config (routine `trigger_config`, optional):
 *   - `window_days` — report window (default 7).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { PRESENCE_INLINE_GLANCE_TOKEN_BUDGET } from '../../agent-tools/coordination/presence-cost';
import { getOrgPg } from '@papercusp/db-org';

/** Coord identity for the report broadcast (mirrors git-sync / service-health). */
const TOKEN_REPORT_IDENTITY: AgentIdentity = {
  ownerId: 'system:token-report',
  ownerLabel: 'token-report',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

interface AggRow {
  dim: string;
  calls: string;
  in_t: string | null;
  out_t: string | null;
  cr_t: string | null;
  cw_t: string | null;
  usd: number | null;
}

const mtok = (v: string | null): number => Number(v ?? 0) / 1e6;
const fmtM = (v: number): string => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const fmtUsd = (v: number | null): string => `$${(v ?? 0).toFixed(2)}`;

function renderDim(label: string, cur: AggRow[], prev: Map<string, AggRow>): string {
  const lines = [`**By ${label}** (window vs prior):`];
  for (const r of cur) {
    const p = prev.get(r.dim);
    const curTok = mtok(r.in_t) + mtok(r.out_t) + mtok(r.cr_t) + mtok(r.cw_t);
    const prevTok = p ? mtok(p.in_t) + mtok(p.out_t) + mtok(p.cr_t) + mtok(p.cw_t) : 0;
    const delta = prevTok > 0 ? ` (${curTok >= prevTok ? '+' : ''}${(((curTok - prevTok) / prevTok) * 100).toFixed(0)}%)` : '';
    lines.push(
      `- ${r.dim}: ${fmtM(curTok)} MTok${delta} — ${fmtM(mtok(r.cr_t))} cache-read + ${fmtM(mtok(r.cw_t))} cache-write, ` +
        `${fmtM(mtok(r.out_t))} out, ${fmtUsd(r.usd)} (${r.calls} samples)`,
    );
  }
  if (cur.length === 0) lines.push('- (no samples)');
  return lines.join('\n');
}

/**
 * The presence/coord READ surface the P-016 guardrail watches (presence-v2 D-009
 * — "presence-v2 adds payload to a system token-usage-reduction just shrank; it
 * only wins if hive-scope + read-once+delta hold — guardrail in the weekly
 * report"). coord:presence is the roster read itself; coord:inbox is the
 * [coord+N] delta channel presence rides (token-usage-reduction's #4 payload);
 * fleet:assignments is the folded work-detail projection (P-006/P-007).
 */
const PRESENCE_READ_TOOLS: string[] = ['coord:presence', 'coord:inbox', 'fleet:assignments'];

interface VolRow {
  tool: string;
  calls: string;
  bytes: string | null;
  avg_bytes: string | null;
}

const fmtBytes = (b: number): string =>
  b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(1)} KB` : `${Math.round(b)} B`;

const wowPct = (cur: number, prev: number): string =>
  prev > 0 ? ` (${cur >= prev ? '+' : ''}${(((cur - prev) / prev) * 100).toFixed(0)}%)` : '';

/**
 * Render the presence/coord read-volume guardrail block (presence-v2-2026-06-14
 * P-016): per tool, calls + total payload bytes + avg/call, each with a
 * week-over-week delta. Makes a richer presence's token cost NON-silent — a
 * regression in the call-count (#1) or tool-result-size (#2) levers shows as a
 * WoW jump. The result-size signal is `tool_invocations.output_size` (the
 * serialized result length the generic dispatch records for every tool). Pure
 * (rows in → string out) so it is unit-testable without a DB.
 */
export function renderPresenceVolume(cur: VolRow[], prev: VolRow[]): string {
  const prevByTool = new Map(prev.map((r) => [r.tool, r]));
  const lines = [
    `**Presence/coord read-volume** (guardrail — presence-v2-2026-06-14 P-016; watches the levers a ` +
      `richer presence could regress: #1 call-count, #2 tool-result size). A hive-scoped read should be ` +
      `a <~${PRESENCE_INLINE_GLANCE_TOKEN_BUDGET}-token inline glance; workspace/admin reads are larger ` +
      `by design, so a WoW jump — not the absolute size — is the regression signal.`,
  ];
  let any = false;
  for (const tool of PRESENCE_READ_TOOLS) {
    const c = cur.find((r) => r.tool === tool);
    const p = prevByTool.get(tool);
    const calls = Number(c?.calls ?? 0);
    const bytes = Number(c?.bytes ?? 0);
    const avg = Number(c?.avg_bytes ?? 0);
    if (calls > 0) any = true;
    lines.push(
      `- ${tool}: ${calls} calls${wowPct(calls, Number(p?.calls ?? 0))} — ` +
        `${fmtBytes(bytes)} payload${wowPct(bytes, Number(p?.bytes ?? 0))}, avg ${fmtBytes(avg)}/call`,
    );
  }
  if (!any) lines.push('- (no presence/coord reads recorded this window)');
  return lines.join('\n');
}

registerSystemAction('token-weekly-report', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const windowDays = Number.isFinite(Number(cfg.window_days)) && Number(cfg.window_days) > 0 ? Number(cfg.window_days) : 7;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const { sql } = getOrgPg();

  const agg = async (dim: 'source' | 'model_class' | 'role', from: number, to: number): Promise<AggRow[]> => sql<AggRow[]>`
    SELECT COALESCE(${sql(dim)}, '(none)') AS dim, COUNT(*) AS calls,
           SUM(input_tokens) AS in_t, SUM(output_tokens) AS out_t,
           SUM(cache_read_tokens) AS cr_t, SUM(cache_creation_tokens) AS cw_t,
           SUM(cost_usd) AS usd
      FROM harness_shared.agent_usage_samples
     WHERE workspace_id = ${ctx.workspaceId} AND ts >= ${from} AND ts < ${to}
     GROUP BY 1 ORDER BY SUM(COALESCE(cache_read_tokens,0)+COALESCE(cache_creation_tokens,0)+COALESCE(input_tokens,0)) DESC
     LIMIT 12
  `;

  // P-016 presence/coord read-volume: calls + result-size from tool_invocations
  // (output_size = the serialized result length the dispatch records per call,
  // dispatch-stack.ts `r.outputSize ?? JSON.stringify(r.content).length`).
  const presenceVol = async (from: number, to: number): Promise<VolRow[]> => sql<VolRow[]>`
    SELECT tool_name AS tool, COUNT(*) AS calls,
           SUM(output_size) AS bytes, ROUND(AVG(output_size)) AS avg_bytes
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${ctx.workspaceId}
       AND invoked_at >= to_timestamp(${from}::double precision / 1000.0)
       AND invoked_at <  to_timestamp(${to}::double precision / 1000.0)
       AND tool_name = ANY(${PRESENCE_READ_TOOLS})
     GROUP BY 1
  `;

  const [curSrc, prevSrc, curModel, prevModel, curRole, prevRole, curVol, prevVol] = await Promise.all([
    agg('source', now - windowMs, now),
    agg('source', now - 2 * windowMs, now - windowMs),
    agg('model_class', now - windowMs, now),
    agg('model_class', now - 2 * windowMs, now - windowMs),
    agg('role', now - windowMs, now),
    agg('role', now - 2 * windowMs, now - windowMs),
    presenceVol(now - windowMs, now),
    presenceVol(now - 2 * windowMs, now - windowMs),
  ]);

  const tot = (rows: AggRow[]): { tok: number; usd: number } => ({
    tok: rows.reduce((a, r) => a + mtok(r.in_t) + mtok(r.out_t) + mtok(r.cr_t) + mtok(r.cw_t), 0),
    usd: rows.reduce((a, r) => a + (r.usd ?? 0), 0),
  });
  const cur = tot(curSrc);
  const prev = tot(prevSrc);
  const wow = prev.tok > 0 ? `${cur.tok >= prev.tok ? '+' : ''}${(((cur.tok - prev.tok) / prev.tok) * 100).toFixed(0)}%` : 'n/a';

  const summary =
    `Token report (${windowDays}d): ${fmtM(cur.tok)} MTok total (${wow} WoW), ${fmtUsd(cur.usd)} attributed. ` +
    `Top source: ${curSrc[0]?.dim ?? 'n/a'}.`;
  const byKey = (rows: AggRow[]): Map<string, AggRow> => new Map(rows.map((r) => [r.dim, r]));
  const body = [
    `Window: last ${windowDays}d vs the ${windowDays}d before. $ are attributed cost (provider-reported or list-price estimate; interactive sessions are subscription-billed — their $ quantifies rate-limit headroom, not invoices).`,
    renderDim('source', curSrc, byKey(prevSrc)),
    renderDim('model class', curModel, byKey(prevModel)),
    renderDim('role', curRole, byKey(prevRole)),
    renderPresenceVolume(curVol, prevVol),
    `Acceptance tracking (token-usage-reduction-audit-2026-06-09 P-013): target ≥40% weekly cache-read+write reduction vs the 2026-06-09 baseline (235 MTok read + 170 MTok write interactive; ~122 MTok fleet).`,
  ].join('\n\n');

  await sendMessage(TOKEN_REPORT_IDENTITY, { to: ['*'], summary, body }).catch(() => {});
  console.log(`[token-report] ${summary}`);
});
