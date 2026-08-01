/**
 * Recurrence guard for WI-6746 — `getWorkItem(...).catch(() => null)` must not come back.
 *
 * `getWorkItem` returns null ONLY for a zero-row result; it never catches, so a PG fault
 * throws through it. Swallowing that to null collapses "it is not there" with "I could not
 * ask", and two SAFETY GUARDS that derived their refusal from the collapsed value therefore
 * FAILED OPEN exactly when the database was unhealthy (work_items:claim's claim-hold guard,
 * work_items:checkpoint's not_holder guard — neither underlying write re-checks). Use
 * `lookupWorkItem()` from ./_lookup instead, and match on `status`.
 *
 * WHY A GUARD AND NOT A ONE-OFF SWEEP: the six bad sites were found by a scripted scan, not
 * by reading — a hand grep only ever encodes the call forms you happened to think of that
 * day, and one written an hour earlier had already missed them. A committed guard encodes
 * them once and re-checks forever.
 *
 * WHY IT COUNTS OCCURRENCES RATHER THAN ALLOWLISTING FILES (WI-6727's lesson, paid for
 * once already): a FILE-granular allowlist answers "is this file known?", which stays
 * truthfully green while a SECOND, unreviewed seam is added a few lines below the reviewed
 * one. Pinning the expected count per file makes that addition fail here instead of in
 * production.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LIB_ROOT = join(__dirname, '..', '..');

/**
 * Sites where collapsing "missing" and "unreadable" is genuinely harmless: the value is a
 * DECORATION and nothing downstream asserts on it — no prose claiming the item is absent,
 * no guard deciding whether to proceed. That is the whole triage rule; if a site's null
 * ever starts feeding an assertion, it belongs in the fix, not in here.
 *
 * `count` is the number of swallowed getWorkItem reads expected in that file.
 */
const ALLOWED: { file: string; count: number; why: string }[] = [
  {
    file: 'handoff-context.ts',
    count: 1,
    why: 'predecessor-item enrichment for a handoff brief — an absent predecessor omits a hint line; nothing asserts the item does not exist',
  },
  {
    file: 'external-bench/hive-backlog-live.ts',
    count: 1,
    why: 'bench harness reporting — a skipped row costs a bench datapoint, never a guard decision or a claim about absence',
  },
  {
    file: 'fleet/placement-gather.ts',
    count: 1,
    why: 'placement candidate enrichment — an unreadable item is simply not enriched; placement never concludes it is absent',
  },
];

/** Every .ts file under operator-core/lib, excluding tests. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

/**
 * A swallowed work-item read: `getWorkItem(...)` (or the family-half readers) whose promise
 * is immediately `.catch(...)`-ed. Deliberately matches ANY catch handler, not just
 * `() => null` — `.catch(() => undefined)` and `.catch(() => ({}))` collapse the same two
 * facts, and the point of a guard is to cover the forms nobody thought to grep for.
 */
const SWALLOWED = /\b(getWorkItem|getIssue|getFeatureWorkItemOnly)\s*\([^;]*?\)\s*\.catch\s*\(/gs;

function swallowedSites(): Map<string, number> {
  const found = new Map<string, number>();
  for (const full of sourceFiles(LIB_ROOT)) {
    const src = readFileSync(full, 'utf8');
    const n = (src.match(SWALLOWED) ?? []).length;
    if (n > 0) found.set(full.slice(LIB_ROOT.length + 1), n);
  }
  return found;
}

describe('WI-6746 — a swallowed getWorkItem read must not render as absence', () => {
  it('no un-allowlisted site swallows a work-item read', () => {
    const found = swallowedSites();
    const allowed = new Map(ALLOWED.map((a) => [a.file, a]));
    const offenders = [...found.entries()].filter(([file]) => !allowed.has(file));

    expect(
      offenders.map(([file, n]) => `${file} (${n} site${n === 1 ? '' : 's'})`),
      'A read failure must not be indistinguishable from "item absent". Use lookupWorkItem() ' +
        'from agent-tools/work_items/_lookup and match on status: unreadable => refuse/report ' +
        'the read failure (FAIL CLOSED if the value gates a guard), missing => the honest ' +
        'not-found. If the value is genuinely only a decoration that nothing asserts on, add ' +
        'it to ALLOWED here with a why that says what would break if it were wrong.',
    ).toEqual([]);
  });

  it('every allowlisted file still has exactly the reviewed number of swallowed reads', () => {
    // Occurrence-granular on purpose: a second, unreviewed swallow added to an
    // already-allowlisted file must fail here rather than inherit its neighbour's exemption.
    const found = swallowedSites();
    const actual = ALLOWED.map((a) => `${a.file}=${found.get(a.file) ?? 0}`);
    const expected = ALLOWED.map((a) => `${a.file}=${a.count}`);
    expect(actual, 'A count mismatch means a swallowed read was ADDED to (or removed from) an allowlisted file — review the new site on its own merits, do not just bump the count.').toEqual(expected);
  });

  it('the allowlist has no stale entries (a fixed site must be removed from it)', () => {
    const found = swallowedSites();
    const stale = ALLOWED.filter((a) => !found.has(a.file)).map((a) => a.file);
    expect(stale, 'These files no longer swallow a work-item read — drop them from ALLOWED so it keeps describing reality.').toEqual([]);
  });

  it('the fixed surfaces route through lookupWorkItem rather than a bare swallow', () => {
    // Pins the POSITIVE half: the six sites WI-6746 fixed must still be using the
    // fail-closed/honest-error path. A regression that reverted them would otherwise only
    // show up as a re-added offender if it also re-added a `.catch`.
    const fixed = [
      'agent-tools/work_items/claim.ts',
      'agent-tools/work_items/checkpoint.ts',
      'agent-tools/work_items/hold_open.ts',
      'agent-tools/work_items/park.ts',
      'agent-tools/work_items/request_release.ts',
      'agent-tools/work_items/decline_release_request.ts',
    ];
    const missing = fixed.filter((f) => !readFileSync(join(LIB_ROOT, f), 'utf8').includes('lookupWorkItem'));
    expect(missing, 'These surfaces derive a guard or an error message from a work-item read and must use lookupWorkItem().').toEqual([]);
  });
});
