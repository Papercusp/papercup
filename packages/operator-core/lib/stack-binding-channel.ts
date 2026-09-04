/**
 * The operator side of the STACK-MUTATION PRIMITIVE (`identities-v1-2026-08-30` P-012,
 * D-022) — a live session's stack binding as CONTROL STATE, delivered through the
 * existing mode-flip channel.
 *
 * TWO HALVES.
 *
 *   1. `stackRefsForRoute` — the binding is DERIVED, never a new table. The fleet posture
 *      a session runs is presence's `fleet_role` (already projected into the control
 *      anchor as `route.role`); the mode axes are `agent_modes` (already `modes`), with
 *      no mode-axis DOCUMENT in v1 (D-008; P-021 supplies them). This function projects
 *      those facts into the anchor's `stack` — bound-layer refs `slot:id` — so a posture
 *      change bumps the anchor generation exactly like a mode flip does.
 *
 *   2. `renderStackTransitionContext` — at turn start the hook consumes the pending
 *      `⟦CTRL:transition⟧` (turn-start-memory.ts); this renders, as a SEPARATE context
 *      block outside the anchor's 384-token budget, the inject-now payloads for every
 *      mutation between the transition's `stackBefore` and its `state.stack`, over the
 *      REAL su stack (`composeSuStackMutation`: the next render is composed under the
 *      seal first, so a layer that would BLOCK is never injected). A transition without
 *      `stackBefore` (a full-resync) re-delivers every bound layer — the anchor's
 *      replace-full-never-merge-behind rule applied to the stack.
 *
 * The orchestrator barrel is imported LAZILY (it pulls the blueprint loader and its
 * harness-path resolution), and every failure degrades to an EMPTY block: a broken
 * layer render must never block the prompt, exactly like the control anchor itself.
 */
import type { ControlAnchorState, ControlTransition } from './agent-tools/coordination/control-anchor';

/**
 * The su posture layer refs. Inlined here (see the lazy-import note above) and PINNED
 * to the orchestrator's `suPostureLayer` by `stack-binding-channel.test.ts`, so the two
 * copies cannot drift.
 */
export const SU_POSTURE_REFS = {
  member: 'fleet-posture:su.fleet-member',
  leader: 'fleet-posture:su.fleet-leader',
} as const;

/** The bound-layer refs a session's route implies (v1: the fleet posture only). */
export function stackRefsForRoute(route: ControlAnchorState['route']): string[] {
  if (route.kind !== 'fleet') return [];
  const role = (route.role ?? '').trim().toLowerCase();
  if (role === 'leader' || role === 'member') return [SU_POSTURE_REFS[role]];
  return [];
}

function sameRefs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

type Blueprint = typeof import('@papercusp/orchestrator/blueprint');

export interface StackTransitionContextOptions {
  /** The harness install dir (default: `harnessRoot()`). */
  harnessDir?: string;
  /** DI seam: the orchestrator blueprint module (tests pass the real one loaded eagerly). */
  blueprint?: Pick<Blueprint, 'stackBindingFromRefs' | 'emptyStackBinding' | 'diffStackBindings' | 'composeSuStackMutation'>;
  /** Where a compose failure is reported (default: console.warn). */
  warn?: (message: string) => void;
}

/**
 * The inject-now context for a control transition — '' when the stack did not move
 * (or nothing is bound on a full-resync). Never throws.
 */
export async function renderStackTransitionContext(
  delivery: Partial<Pick<ControlTransition, 'state' | 'stackBefore'>> | null | undefined,
  opts: StackTransitionContextOptions = {},
): Promise<string> {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  // Read defensively: a transition shaped by an older operator (or a test double) may
  // carry no `state` at all — that is "nothing bound", never a throw past the CTRL line.
  const after = Array.isArray(delivery?.state?.stack) ? delivery!.state!.stack!.map(String) : [];
  const before = Array.isArray(delivery?.stackBefore) ? delivery!.stackBefore!.map(String) : undefined;
  if (before == null && after.length === 0) return '';
  if (before != null && sameRefs(before, after)) return '';
  try {
    const bp = opts.blueprint ?? (await import('@papercusp/orchestrator/blueprint'));
    const harnessDir = opts.harnessDir ?? (await import('@papercusp/harness/paths')).harnessRoot();
    const from = before == null ? bp.emptyStackBinding() : bp.stackBindingFromRefs(before);
    const to = bp.stackBindingFromRefs(after);
    const parts: string[] = [];
    let cursor = from;
    for (const m of bp.diffStackBindings(from, to)) {
      const applied = bp.composeSuStackMutation({ harnessDir, binding: cursor, op: m.op, layer: { slot: m.slot, id: m.id } });
      if (applied.injection) parts.push(applied.injection);
      cursor = applied.runtimeBinding;
    }
    return parts.join('\n\n');
  } catch (e) {
    warn(`[stack-binding-channel] stack transition not delivered (${JSON.stringify(before ?? null)} → ${JSON.stringify(after)}): ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
}
