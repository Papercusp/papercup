/**
 * The pure half of the "this goal ends when" inline editors
 * (goals-tab-improvement-2026-08-09 P-009).
 *
 * WHY THIS EXISTS AT ALL. The section it serves is the loudest thing the panel
 * can say — "No kill criterion was set — nothing can stop this goal" — and
 * until now it attached no remedy: the owner read an alarm and had nowhere to
 * go. The item's fix is that the warning BECOMES the control that fixes it, and
 * the money ceiling beside it becomes editable for the same reason (a ceiling
 * is usually wrong until the goal's shape is understood).
 *
 * WHY THE CRITERION RULE IS IMPORTED AND NOT RESTATED. `killCriterionProblem`
 * is the ONE definition of what counts as a written criterion, and its module
 * says in as many words why a second copy is dangerous: a private copy "drifts
 * silently and only ever in the permissive direction", so the edit door quietly
 * becomes the way to install a criterion the create door would have refused.
 * The item states this as a hard constraint. So this file adds no rule of its
 * own for the criterion — it forwards, and surfaces the shared message VERBATIM,
 * which is exactly the contract that module's header describes for this caller.
 *
 * ⚠ THIS EDITOR CANNOT CLEAR THE CRITERION, AND THAT IS DELIBERATE — not an
 * oversight to "fix" later. `goals:update` does treat a blank as an explicit
 * clear, so the capability exists one layer down; what does not exist is a
 * reason to reach it from a one-click control sitting under an alarm about the
 * criterion being absent. A blank submit here fails the shared rule like any
 * other non-criterion, and the refusal is the shared message.
 *
 * ⚠ NOR CAN IT CLEAR THE CEILING — and here the reason is the WRITE PATH, not
 * a judgement. `goals:update`'s `budgetCents` is
 * `z.number().int().nonnegative().optional()`: no `.nullable()`, unlike its
 * `tripwires`, `parentId` and `launchSettings` siblings, which all take null to
 * clear. So there is no value this editor could send that unsets a ceiling; a
 * blank field that appeared to clear one would either be refused by zod or
 * silently omitted and read as "leave unchanged" — a control that lies about
 * what it did. Blank is therefore "no change requested" and Save stays
 * disabled. If clearing is ever wanted, the change is to widen THAT schema
 * (and its handler) first — not to add a blank-clears path here that the
 * server has no way to honour.
 */
import { killCriterionProblem } from '@papercusp/operator-core/lib/goals/kill-criterion';

/**
 * Ten million dollars. Not a policy about what a goal may spend — the ceiling
 * is the owner's number, not ours. It is a TYPO fence: the realistic distance
 * between an intended ceiling and a slipped keystroke is orders of magnitude,
 * and a ceiling that can never be reached is indistinguishable from none while
 * looking like a bound.
 */
export const MAX_CEILING_USD = 10_000_000;

export interface CeilingInputResult {
  /**
   * Cents to write. Present only when `problem` is null — a caller that reads
   * `cents` without checking `problem` would write `undefined`, which
   * `goals:update` reads as "leave unchanged", turning a refusal into a
   * silent no-op that still closes the editor.
   */
  cents?: number;
  /** The refusal to render under the field, or null when the input is usable. */
  problem: string | null;
}

/**
 * Parse what the owner typed into the ceiling field.
 *
 * Accepts a leading `$` and thousands commas because both are what a person
 * types when the label beside the field is a dollar amount. Rejects everything
 * else by pattern rather than by `Number()`, which would quietly accept `1e9`,
 * `0x10`, `Infinity` and a trailing-garbage `500abc` — each a number the owner
 * did not mean and none of them a typo we should silently round into a binding
 * ceiling.
 *
 * More than two decimal places is a refusal rather than a round, because cents
 * are the stored unit: rounding `12.345` to `$12.35` writes a ceiling the owner
 * never typed and never sees corrected.
 */
export function parseCeilingInput(raw: string): CeilingInputResult {
  const text = raw.trim().replace(/^\$/, '').replace(/,/g, '').trim();
  if (!text) {
    return {
      problem:
        'Enter a ceiling in dollars, like 500. This control sets or revises a ceiling — it cannot remove one; press Cancel to leave the current ceiling as it is.',
    };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return {
      problem: `'${raw.trim()}' is not a dollar amount — enter a number like 500 or 1250.50`,
    };
  }
  const usd = Number(text);
  if (!Number.isFinite(usd)) {
    return { problem: `'${raw.trim()}' is not a dollar amount` };
  }
  if (usd > MAX_CEILING_USD) {
    return {
      problem: `$${usd.toLocaleString('en-US')} is past the $${MAX_CEILING_USD.toLocaleString('en-US')} limit this field accepts — a ceiling that large cannot bind anything, so it is more likely a typo than an intent`,
    };
  }
  return { cents: Math.round(usd * 100), problem: null };
}

/**
 * The stored ceiling as the owner should see it in the input.
 *
 * Empty for "no ceiling" — the same absence the field's own note names — and
 * two decimals ONLY when the stored value actually has cents, so a $500 ceiling
 * reads `500` rather than the invoice-looking `500.00`.
 */
export function ceilingToInput(budgetCents: number | null | undefined): string {
  if (budgetCents == null || !Number.isFinite(budgetCents)) return '';
  const cents = Math.round(budgetCents);
  if (cents < 0) return '';
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/**
 * The criterion's refusal message, or null.
 *
 * A forwarder with no logic of its own — see the header. It exists as a named
 * export so the editor imports ONE thing from this module and a reader looking
 * for "where does the editor decide?" lands on the file that says the rule is
 * not decided here.
 */
export function criterionSubmitProblem(draft: string): string | null {
  return killCriterionProblem(draft);
}

/** Has the criterion draft actually moved off what is stored? */
export function criterionDirty(stored: string | null | undefined, draft: string): boolean {
  return (stored ?? '').trim() !== draft.trim();
}

/**
 * Has the ceiling draft actually moved off what is stored?
 *
 * Compares PARSED values, not text, so `$500`, `500` and `500.00` are all the
 * same ceiling and none of them offers a Save that would write nothing.
 *
 * BLANK IS NOT DIRTY, even when a ceiling IS stored. Blank cannot mean "clear
 * it" here (see the header — the write path has no way to unset a ceiling), so
 * the only honest reading left is "no change requested", and an enabled Save
 * over an empty field would promise a clear this control cannot deliver.
 *
 * An unparseable NON-blank draft does count as dirty: the owner typed
 * something, and disabling Save on it would hide the refusal that explains
 * why it is not a ceiling.
 */
export function ceilingDirty(storedCents: number | null | undefined, draft: string): boolean {
  const typed = draft.trim().replace(/^\$/, '').replace(/,/g, '').trim();
  if (!typed) return false;
  const parsed = parseCeilingInput(draft);
  if (parsed.problem) return true;
  const stored = storedCents == null || storedCents < 0 ? null : Math.round(storedCents);
  return parsed.cents !== stored;
}
