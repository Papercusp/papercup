/**
 * A work-item is FINISHED only through `work_items:complete`: an agent may not move one to a
 * successful terminal state (`done`, or an alias of it such as `passed` or `resolved`) with
 * `work_items:set_state`.
 *
 * Why: `work_items:complete` is where a close's proof is checked (the change-kind proof gate:
 * `testsRun` and a passing `testResult` for logic, and the rest), and its judgement is stamped as
 * `completionAuthority`. `set_state` writes the state alone, with a prose `completionRef`, so a
 * successful close there skipped every proof check: measured in a live fleet run, an agent whose
 * `complete` was refused closed four code changes by `set_state` instead, on its leader's word.
 * The owner's rule is that an agent closes its work with its own proof.
 *
 * What stays on `set_state`: every non-terminal move, and the closes that give an item up rather
 * than finish it (`dropped`, and its aliases `deprecated` and `closed`), which claim no work
 * done and so need no proof. The owner's own UI action stays exempt, as at the other work doors
 * (`isOwnerUiCaller`, D-038): the owner may settle any row by hand.
 */
import { normalizeFeatureStateInput } from '../work-item-dispatch-states';
import { isOwnerUiCaller, type AgentWorkDoorCaller } from './agent-work-door-gate';

export const CLOSE_THROUGH_COMPLETE = 'close_through_complete' as const;

export type SuccessfulCloseRefusal = {
  ok: false;
  id: string;
  error: typeof CLOSE_THROUGH_COMPLETE;
  requestedState: string;
  hint: string;
};

/** Whether `state` resolves to the successful terminal state (`done`), aliases folded. */
export function isSuccessfulCloseState(state: unknown): boolean {
  if (typeof state !== 'string') return false;
  const normalized = normalizeFeatureStateInput(state);
  return normalized.ok && normalized.state === 'done';
}

/** The refusal of an agent's `set_state` to a successful close, or null when the write may go on. */
export function refuseSuccessfulCloseOutsideComplete(
  id: string,
  state: unknown,
  caller: AgentWorkDoorCaller | null,
): SuccessfulCloseRefusal | null {
  if (!isSuccessfulCloseState(state)) return null;
  if (isOwnerUiCaller(caller)) return null;
  return {
    ok: false,
    id,
    error: CLOSE_THROUGH_COMPLETE,
    requestedState: String(state),
    hint:
      `work_items:set_state does not finish a work-item: close ${id} with work_items:complete, ` +
      '`state: "done"`, and the proof its change kinds require (for logic: `testsRun` naming the ' +
      'test command and a passing `testResult`; for a close that changed no code, ' +
      '`changeKinds: ["no-code-change"]` with a `changeKindReason`). If complete refuses, fix what ' +
      'its refusal names; do not route around it. To give the item up instead, set_state `dropped` ' +
      'with the reason.',
  };
}
