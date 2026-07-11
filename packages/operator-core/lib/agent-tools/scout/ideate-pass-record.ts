/**
 * blender:ideate-pass-record — record one su IDEATE pass on the Scout tick
 * ledger (su-ideate-learning-substrate-2026-07-10 P-010).
 *
 * The scout-cycle routine writes a durable row per tick (tick-ledger.ts /
 * harness_shared.scout_ticks) so "is the ideation engine actually firing, and
 * with what yield?" is answerable. An su session running IDEATE mode does the
 * same generative work by hand but left no such trace — so pacing/observability
 * (Phase 3) had nothing to measure the su side by. This thin tool writes the su
 * analogue: a status='ran', origin='su-ideate' tick (migration 571) attributed
 * to the caller's ownerId, carrying the pass's yield (ideas filed, observations
 * mined) and an optional note.
 *
 * origin='su-ideate' is the partition that keeps these rows OFF Scout's cadence
 * floor and health reads (readLastScoutRunAtMs / learning-loop health filter
 * origin='scout') — a su-ideate pass is observed, never mistaken for a Scout
 * cycle. Best-effort by contract, mirroring recordScoutTick: an observability
 * write must never fail the caller's real work.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';

import { recordScoutTick, type RecordScoutTickInput } from '../../scout/tick-ledger';
import { resolveAgentIdentity } from '../coordination/identity';
import { softText, LIMITS } from '../limits';

export const ideatePassRecordArgs = z
  .object({
    ideasFiled: z
      .number()
      .int()
      .min(0)
      .describe('how many ideas this pass filed/routed onward (improvements:capture / blender:route-idea)'),
    observationsMined: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('how many raw observations the pass examined before filing (the denominator of yield)'),
    notes: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('a short free-form note on the pass (theme, corpus, what was skipped) — stored on the tick detail'),
  })
  .strict();
export type IdeatePassRecordArgs = z.infer<typeof ideatePassRecordArgs>;

/** The tool's payload — what was recorded and who it was attributed to. */
export interface IdeatePassRecordResult {
  ok: boolean;
  origin: 'su-ideate';
  status: 'ran';
  ideasFiled: number;
  observationsMined?: number;
  notes?: string;
  /** The ownerId the tick is attributed to (stored on detail.owner). */
  owner: string;
  /** The harness the pass ran for (the tick's install_slug). */
  installSlug: string;
}

/** Injectable seam — unit tests drive the flow with a fake recorder (no PG). */
export interface IdeatePassRecordDeps {
  recordTick: (input: RecordScoutTickInput) => Promise<void>;
}

const defaultDeps: IdeatePassRecordDeps = {
  recordTick: recordScoutTick,
};

/**
 * The testable core: map the pass onto a su-ideate tick and persist it.
 * Column mapping for the origin='su-ideate' row (Scout readers never see it):
 *   ideas_routed    ← ideasFiled        (ideas filed/routed onward this pass)
 *   ideas_generated ← observationsMined (raw observations examined)
 *   detail          ← { owner, notes? } (attribution + free-form context)
 */
export async function runIdeatePassRecord(
  args: IdeatePassRecordArgs,
  ctx: unknown,
  deps: IdeatePassRecordDeps = defaultDeps,
): Promise<IdeatePassRecordResult> {
  const identity = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]);
  const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
  const installSlug =
    typeof ctxHarnessRaw === 'string' && ctxHarnessRaw && ctxHarnessRaw !== '*' ? ctxHarnessRaw : 'papercusp';
  const notes = typeof args.notes === 'string' && args.notes.trim() ? args.notes.trim() : undefined;

  await deps.recordTick({
    status: 'ran',
    origin: 'su-ideate',
    installSlug,
    ideasRouted: args.ideasFiled,
    ideasGenerated: args.observationsMined ?? 0,
    detail: { owner: identity.ownerId, ...(notes ? { notes } : {}) },
  });

  return {
    ok: true,
    origin: 'su-ideate',
    status: 'ran',
    ideasFiled: args.ideasFiled,
    ...(args.observationsMined != null ? { observationsMined: args.observationsMined } : {}),
    ...(notes ? { notes } : {}),
    owner: identity.ownerId,
    installSlug,
  };
}

/** Map the outcome onto the tool envelope. */
export function toToolResult(out: IdeatePassRecordResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
    ...(out.ok ? {} : { isError: true }),
  };
}

export default defineTool({
  name: 'blender:ideate-pass-record',
  description:
    "Record one su IDEATE pass on the Scout tick ledger: a status='ran', origin='su-ideate' tick attributed to you, carrying the pass's yield. Pass `ideasFiled` (required), `observationsMined?`, `notes?`. origin='su-ideate' keeps the row OFF Scout's cadence floor and health reads — a su pass is observed, never mistaken for a Scout cycle. Best-effort observability: call it once at the end of an ideate pass.",
  capability: 'harness:write',
  guidance: {
    when: 'At the END of an su IDEATE pass — after you have filed/routed the pass\'s ideas (improvements:capture / blender:route-idea) — to leave a durable, measurable trace of the pass (its yield + your attribution).',
    notWhen:
      'Filing an individual idea (improvements:capture) or routing one to a plan (blender:route-idea) — this records the PASS, not an idea. Recording a Scout-cycle tick — that is the scout-cycle routine, not this tool.',
    chaining:
      'improvements:capture / blender:route-idea (file the ideas) → blender:ideate-pass-record { ideasFiled, observationsMined?, notes? } (record the pass). The su-partition pacing/observability reads (Phase 3) aggregate these origin=su-ideate ticks.',
    seeAlso: [
      'blender:route-idea (route one idea onto the plan rail)',
      'improvements:capture (file one idea/improvement)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: ideatePassRecordArgs,
  async handler(args, ctx) {
    return toToolResult(await runIdeatePassRecord(args, ctx));
  },
});
