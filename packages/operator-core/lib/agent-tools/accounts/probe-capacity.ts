/**
 * accounts:probe-capacity — ask UPSTREAM what each account's real budget is, and record the truth
 * (plan gateway-clamp-advisory-capacity-probe-2026-07-09, P-001).
 *
 * WHY THIS EXISTS. The account-pool's `utilization7d` projection is written ONLY from the response
 * headers of live traffic routed through that account (inference-gateway/launch.ts). A walled account
 * is routed no traffic, so it never gets a fresh reading, so it stays walled until its PROJECTED reset
 * — days. Nothing else in the tree ever re-asks upstream. `accounts:reset-rate` cannot help: it
 * deliberately PRESERVES the windows. This tool is the missing detector: one minimal request per
 * account recovers the authoritative `anthropic-ratelimit-unified-*` headers (which ride on 200s, not
 * just 429s) and feeds them through the SAME `recordAccountWindow` the live recorder uses.
 *
 * EVIDENCE, NOT ASSERTION (plan D-001). Prefer this over `accounts:reset-rate { resetWindows }`: the
 * probe PROVES a window reset where `resetWindows` merely asserts it. A 429 reply is signal too — it
 * CONFIRMS a real wall (and carries the true reset), in which case forcing an unwall would only make the
 * fleet hammer a capped account into fresh 429s.
 *
 * Out-of-process (plan D-002): talks to upstream directly through each account's own egress + credential,
 * so it works against a gateway that is wedged, walled, or too old to expose the routes you need — no
 * restart required.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { DRAIN_FULL_UTIL } from '../../deployment/account-pool';
import { probeCapacityForAccounts, type CapacityProbeResult } from '../../inference-gateway/capacity-probe';

const wsArg = z.string().min(1).optional().describe('Workspace id (defaults to the active workspace)');

// { data } shape (definetool-token-optimization P-003): the framework owns wire
// encoding (auto-TOON on the MCP transport, lossless JSON elsewhere) — no hand-rolled
// inline-JSON content array. Payload is identical to the legacy shape.
const ok = (payload: Record<string, unknown>) => ({
  data: { ok: true, ...payload },
});

/** One legible evidence row: what we thought, what upstream says, and the verdict. */
function reportRow(r: CapacityProbeResult) {
  return {
    accountId: r.accountId,
    ok: r.ok,
    status: r.status,
    before: { utilization: r.before.utilization, utilization7d: r.before.utilization7d },
    upstream: { utilization: r.windows.utilization, utilization7d: r.windows.utilization7d },
    verdict: !r.ok ? 'no-reading' : r.unwalls ? 'UNWALLED (stale projection)' : 'confirmed',
    ...(r.error ? { error: r.error } : {}),
  };
}

export default defineTool({
  name: 'accounts:probe-capacity',
  description:
    "Ask UPSTREAM for each pooled Claude account's REAL unified-5h/7d budget and record it into the account-pool projection. Sends one minimal (1-token) request per account through that account's own egress + credential and reads the authoritative `anthropic-ratelimit-unified-*` headers (present on 200s, not just 429s). This is the ONLY way a usage-walled account gets a fresh reading: it is routed no live traffic, so its projection can never self-heal — it stays walled until its PROJECTED reset (days), even after a real capacity reset. Prefer this over `accounts:reset-rate { resetWindows }`, which merely ASSERTS a reset; this PROVES it (and a 429 reply CONFIRMS a genuine wall instead). Runs out-of-process — no gateway restart needed. `apply:false` for a read-only dry run. Returns { ok, probed, unwalled, applied, rows[] }.",
  guidance: {
    when: 'After a capacity/quota reset, or whenever an account reads usageWalled / healthyAccounts is 0 but you suspect the projection is STALE. Also the durable self-heal a schedule should call.',
    notWhen:
      'Clearing a stale rate-limit PAUSE (accounts:reset-rate — a different meter). Clearing the gateway’s IN-MEMORY exhaustedUntil (POST /admin/readmit or a gateway restart — a different process).',
    chaining:
      'accounts:probe-capacity { walledOnly:true } → accounts:status (confirm usageWalled cleared) → if upstream CONFIRMS the wall, do NOT force it; if the probe cannot run at all, accounts:reset-rate { resetWindows:true } is the deliberate override.',
    seeAlso: [
      'accounts:status (the projection this tool corrects)',
      'accounts:reset-rate (clears the PAUSE meter; resetWindows is the manual unwall override)',
      'accounts:test-egress (the network-level probe — exit IP, not budget)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).optional().describe('Probe a single account id.'),
    ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('Probe these account ids.'),
    walledOnly: z
      .boolean()
      .optional()
      .describe('Probe only accounts whose stored projection reads at/over the full-utilization threshold (default false ⇒ probe all Claude accounts).'),
    apply: z
      .boolean()
      .optional()
      .describe('Write the upstream reading into the account-pool projection (default true). false ⇒ read-only dry run.'),
    workspace: wsArg,
  }),
  async handler(args) {
    const { loadAccountPool, updateAccountPool } = await import('../../deployment/account-pool-store');
    const { recordAccountWindow } = await import('../../deployment/account-pool');
    const ws = args.workspace ?? activeWorkspaceId();
    const apply = args.apply ?? true;

    const pool = await loadAccountPool(ws);
    const wanted = new Set([...(args.id ? [args.id] : []), ...(args.ids ?? [])]);
    const accounts = wanted.size > 0 ? pool.accounts.filter((a) => wanted.has(a.id)) : pool.accounts;

    const results = await probeCapacityForAccounts(accounts, {
      walledOnly: args.walledOnly ?? false,
      fullUtil: DRAIN_FULL_UTIL,
    });

    // Record every USABLE reading — a probe reading is exactly what live traffic would have written, so
    // recording it is never a "force". A failed probe writes nothing (we must not invent a window).
    const applied: string[] = [];
    if (apply) {
      const t = Date.now();
      for (const r of results) {
        if (!r.ok) continue;
        const w = r.windows;
        if (w.utilization === undefined && w.utilization7d === undefined) continue;
        await updateAccountPool(
          (p) =>
            recordAccountWindow(
              p,
              r.accountId,
              {
                utilization: w.utilization,
                windowResetAt: w.windowResetAt,
                utilization7d: w.utilization7d,
                windowResetAt7d: w.windowResetAt7d,
              },
              t,
            ),
          ws,
        );
        applied.push(r.accountId);
      }
      if (applied.length > 0) {
        void import('../../sync-sse')
          .then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {}))
          .catch(() => {});
      }
    }

    return ok({
      probed: results.length,
      unwalled: results.filter((r) => r.unwalls).map((r) => r.accountId),
      confirmedWalled: results.filter((r) => r.ok && !r.unwalls && r.status === 429).map((r) => r.accountId),
      failed: results.filter((r) => !r.ok).map((r) => r.accountId),
      applied,
      dryRun: !apply,
      rows: results.map(reportRow),
    });
  },
});
