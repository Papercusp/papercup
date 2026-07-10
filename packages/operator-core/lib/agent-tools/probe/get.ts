/**
 * probe:get — read a federation probe's receipts + derived verdict
 * (fleet-reliability-verification-2026-07-10 P-010, WI-3812).
 *
 * The verdict NAMES the exact hop a stalled probe is stuck at (P-010's core
 * ask) instead of just reading "still red" — see federation-probe.ts
 * `deriveProbeVerdict` for the pure logic.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  deriveProbeVerdict,
  formatProbeVerdict,
  hopTrackingCaveat,
  PROBE_HOPS,
} from '../../sync/pot-git/federation-probe';
import { getProbe, markProbeAcked } from '../../sync/pot-git/federation-probe-store';

export default defineTool({
  name: 'probe:get',
  description:
    'Read a probe:emit-created federation probe: its per-hop receipts (captured/drained/replicated/merged/member_guard/projected) and a derived verdict that NAMES the exact hop it is stalled at, rather than just "still red". Auto-marks the probe acked once every expected hop has landed. ⚠ WI-3962: no pipeline stage calls probe:record-hop yet, so a default (unnarrowed) verdict WILL read "stalled" past capture for every probe, forever — that reflects a missing observation, not a broken pipeline (response carries an instrumentationCaveat saying so). Pass expectedHops:["captured"] to get the real, trustworthy signal today; check substrate_outbox/merge-cursor state for actual federation health.',
  guidance: {
    when: 'Checking whether a probe:emit\'d probe has round-tripped the federation pipeline, or diagnosing exactly which hop a stalled one is stuck at.',
    notWhen: 'You never called probe:emit for this key — there is nothing to read.',
    chaining: 'probe:emit → (wait / other work) → probe:get { probeKey }, repeat if verdict is pending/stalled.',
    seeAlso: ['probe:emit', 'probe:record-hop'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    probeKey: z.string().min(1).max(300).describe('The probeKey returned by probe:emit.'),
    expectedHops: z
      .array(z.enum(PROBE_HOPS))
      .min(1)
      .max(PROBE_HOPS.length)
      .optional()
      .describe('Same narrowing as probe:emit — pass the SAME list you emitted with, or the verdict may read a never-expected hop as stalled.'),
    staleAfterMs: z
      .number()
      .int()
      .positive()
      .max(3600_000)
      .optional()
      .describe('Grace window before a missing next hop reads as stalled rather than pending. Default 180000 (3min).'),
  }),
  async handler(args) {
    const receipt = await getProbe(args.probeKey);
    if (!receipt) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, found: false, probeKey: args.probeKey }) }],
      };
    }
    const nowMs = Date.now();
    const verdict = deriveProbeVerdict(receipt, {
      nowMs,
      ...(args.expectedHops ? { expectedHops: args.expectedHops } : {}),
      ...(args.staleAfterMs ? { staleAfterMs: args.staleAfterMs } : {}),
    });
    if (verdict.verdict === 'acked') {
      try {
        await markProbeAcked(receipt.probeKey);
      } catch {
        // best-effort status write-back — the verdict returned below is
        // correct regardless of whether the row's status column caught up.
      }
    }
    // WI-3962: no pipeline stage anywhere calls probe:record-hop yet, so a
    // 'stalled' verdict past 'captured' is a missing observation, not proof
    // of a broken pipeline — surface that distinction explicitly rather than
    // let a caller (agent or gate) misread it as a data-flow defect.
    const caveat = hopTrackingCaveat(verdict, { expectedHopsWasNarrowed: args.expectedHops !== undefined });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            found: true,
            probeKey: receipt.probeKey,
            harnessSlug: receipt.harnessSlug,
            emittedAt: new Date(receipt.emittedAtMs).toISOString(),
            status: receipt.status,
            ...(receipt.refusalReason ? { refusalReason: receipt.refusalReason } : {}),
            hops: Object.fromEntries(
              Object.entries(receipt.hops).map(([hop, atMs]) => [hop, new Date(atMs).toISOString()]),
            ),
            verdict: verdict.verdict,
            lastHopReached: verdict.lastHopReached,
            stalledAtHop: verdict.stalledAtHop,
            detail: verdict.detail,
            summary: formatProbeVerdict(receipt, verdict),
            ...(caveat ? { instrumentationCaveat: caveat } : {}),
          }),
        },
      ],
    };
  },
});
