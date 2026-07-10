/**
 * probe:record-hop — stamp a later pipeline hop for a federation probe
 * (fleet-reliability-verification-2026-07-10 P-010, WI-3812).
 *
 * The EXTENSION SEAM: probe:emit only ever stamps `captured` itself. A
 * pipeline-stage integration (P-012 named-hop observability, or a manual
 * diagnostic caller on a live rig) calls this as the probe op is actually
 * OBSERVED at drain/replicate/merge/member_guard/project — never
 * self-reported by the emitter, so a hop landing is real evidence, not an
 * assumption.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { PROBE_HOPS } from '../../sync/pot-git/federation-probe';
import { recordProbeHop } from '../../sync/pot-git/federation-probe-store';

const RECORDABLE_HOPS = PROBE_HOPS.filter((h) => h !== 'captured') as Exclude<
  (typeof PROBE_HOPS)[number],
  'captured'
>[];

export default defineTool({
  name: 'probe:record-hop',
  description:
    'Stamp that a federation probe (from probe:emit) has been OBSERVED at a later pipeline hop (drained/replicated/merged/member_guard/projected). Idempotent — re-stamping an already-landed hop is a no-op, so a retried observation can never move a receipt backwards. A hop can only be recorded while the probe is still `pending` (a refused/acked/timed_out probe is terminal).',
  guidance: {
    when: 'You are pipeline-stage code (or a diagnostic script on a live rig) that just watched a specific federation_probe op pass a named stage — e.g. the outbox drain wrote it, a replicator delivered it, the merge loop admitted it, member-content-guard passed it, or projection applied it.',
    notWhen: 'You are the emitter (probe:emit already stamps `captured`) or you only SUSPECT a hop happened — this must be a real observation, never a guess.',
    seeAlso: ['probe:emit', 'probe:get'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    probeKey: z.string().min(1).max(300).describe('The probeKey from probe:emit.'),
    hop: z.enum(RECORDABLE_HOPS as [string, ...string[]]).describe('Which hop was just observed.'),
    detail: z.string().max(500).optional().describe('Optional human note on what was observed at this hop.'),
  }),
  async handler(args) {
    const receipt = await recordProbeHop(args.probeKey, args.hop as (typeof PROBE_HOPS)[number], Date.now(), args.detail);
    if (!receipt) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              recorded: false,
              probeKey: args.probeKey,
              detail: 'no matching PENDING probe for this key (unknown probeKey, or the probe is already refused/acked/timed_out)',
            }),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            recorded: true,
            probeKey: receipt.probeKey,
            hop: args.hop,
            hopsLanded: Object.keys(receipt.hops),
          }),
        },
      ],
    };
  },
});
