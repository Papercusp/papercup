/**
 * _mug-kettle-gate.ts — the ONE refusal every retired mug/kettle/cup ACTUATOR
 * tool returns while `FLAGS.MUG_KETTLE_SYSTEM` is OFF
 * (retire-mug-kettle-su-only-2026-08-09 P-010 / D-017).
 *
 * ⚠ POLARITY IS INVERTED, like the flag itself (D-016): OFF is the DELIVERED
 * state — the tier is retired and su + GOAL mode are the only way to drive the
 * app. ON is the reversible testing escape hatch. So `retired` here is the
 * expected steady-state answer, not a degradation.
 *
 * WHY A HELPER AND NOT FIVE HAND-ROLLED REFUSALS: the gate is a safety
 * invariant (its failure mode is "an autonomous loop the owner retired restarts
 * itself"), and five independently-worded copies are five things free to drift
 * apart — exactly the failure `mugKettleSystemEnabled` was extracted to prevent
 * one layer down. One predicate, one refusal shape, one place to change.
 *
 * WHY A HANDLER REFUSAL AND NOT SKIPPED REGISTRATION (D-017):
 *   - Registration is a SYNCHRONOUS import-time side effect (`export default
 *     defineTool(...)` + the side-effect imports in ./index.ts) while
 *     `mugKettleSystemEnabled()` is async — skipping it is not mechanically
 *     available without restructuring registration itself.
 *   - It is also the wrong shape. A tool that VANISHES teaches the caller
 *     nothing; a refusal that NAMES the flag is self-explaining, and matches the
 *     dominant measured pattern in this tree (loop/arm.ts:474,
 *     capability/grant-role.ts:58, templates/new-app.ts:110).
 *   - `requires:` (tooldef's declarative preconditions) is excluded by its OWN
 *     design doc — "never for a guard whose failure mode is harm".
 *
 * SCOPE — ACTUATORS ONLY. This gate belongs on a tool that INITIATES or SUSTAINS
 * mug/kettle/cup autonomous work. It deliberately does NOT go on:
 *   - the STOPPERS (`pot:pause`, `kettle:pause`) — refusing a stop is never the
 *     safe direction; they must stay reachable to wind a tier down when the flag
 *     flips ON → OFF;
 *   - the pot-as-CONTAINER surface (`pot:create`, `pot:list`, `pot:get`, …) or
 *     the P2P sovereignty/moderation surface — a Pot is a harness container and
 *     a federation peer, not only a Mug host (the D-003 finding, one layer up);
 *   - `curation:*` — zero census entry points, and `curation:state-of-pot` is
 *     Scout's own corpus-synthesis step, which D-001 keeps INTACT.
 * The population and the evidence behind it are D-017; the recurrence guard that
 * holds new entry points to it is P-016.
 */
import { mugKettleSystemEnabled } from '../pot/started';

/** The stable machine-readable code every retired-actuator refusal carries. */
export const MUG_KETTLE_RETIRED_ERROR = 'mug_kettle_retired' as const;

/**
 * The refusal payload, as the MCP content envelope these tools return.
 * `action` names what the caller was trying to do, in the imperative, so the
 * message reads as a sentence: e.g. `'start the Mug'` → "Cannot start the Mug —
 * …". `alternative` is the su/GOAL-mode route that replaces it.
 */
export function mugKettleRetiredRefusal(action: string, alternative: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          error: MUG_KETTLE_RETIRED_ERROR,
          flag: 'papercusp-mug-kettle-system',
          message:
            `Cannot ${action} — the Mug/Kettle/Cup tier is RETIRED (flag ` +
            `papercusp-mug-kettle-system is OFF, which is the delivered state). ` +
            `${alternative} To re-enable the tier for testing, flip the flag ON in /admin/features.`,
        }),
      },
    ],
    isError: true,
  };
}

/**
 * `null` ⇒ the tier is ENABLED, proceed. Non-null ⇒ RETURN IT DIRECTLY as the
 * tool's result; it is the refusal.
 *
 * Fail-CLOSED via `mugKettleSystemEnabled`, whose own catch resolves an
 * unreadable flag to retired: a false `true` restarts a loop the owner retired,
 * while a false `false` leaves a deliberately-retired tier retired.
 */
export async function refuseIfMugKettleRetired(
  action: string,
  alternative: string,
): Promise<ReturnType<typeof mugKettleRetiredRefusal> | null> {
  if (await mugKettleSystemEnabled()) return null;
  return mugKettleRetiredRefusal(action, alternative);
}
