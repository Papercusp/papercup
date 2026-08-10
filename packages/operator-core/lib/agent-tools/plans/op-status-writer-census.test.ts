/**
 * op-status-writer-census.test.ts — the recurrence guard for P-047
 * (retire-mug-kettle-su-only-2026-08-09 / D-010, D-061).
 *
 * ## What retiring an AXIS means, and why prose cannot hold it
 *
 * `op_status` ('started' | 'paused' | 'done') is the OPERATIONAL axis of a plan —
 * the "pickable by the orchestrator" bit — and it retires with the Mug/Kettle
 * tier. P-047 gates the WRITERS rather than deleting the column, because the
 * READER half (`reservedPlanLaneExclusionSql`, work-items.ts) still reserves the
 * 34 items already sitting behind it; unreserving those is P-048, gated on D-055.
 *
 * That split is exactly what makes a new writer dangerous rather than untidy.
 * op_status does not ENABLE anything for an su agent: it RESERVES a plan's items
 * FROM scheduler self-selection, on the premise that a dispatcher will hand them
 * out. Retire the dispatcher, leave a writer, and every plan it touches silently
 * strands its own items — which presents as "the queue is empty", not as a bug.
 * D-010 measured the scale of that leak at 16 plans when it was written.
 *
 * A comment saying "do not write op_status" cannot fail a build. This can.
 *
 * ## The predicate
 *
 * A non-test source file that SQL-writes op_status to an ENTERING value must
 * either call the retirement gate, or hold an ALLOW entry stating why it does
 * not. 'done' is deliberately NOT an entering value — it is how a plan LEAVES
 * the axis (plan-start-state.ts), and refusing an exit is never the safe
 * direction (the same rule _mug-kettle-gate.ts applies to pot:pause/kettle:pause).
 *
 * Awareness is a CALL, not a mention. The sibling guard
 * (../mug-kettle-gate-strands-suite.test.ts) deliberately counts any mention,
 * because it detects human *unawareness* in test files. Here the claim is
 * stronger — "this writer is actually gated" — and pause.ts is the proof that
 * mention-matching would be too weak: its header discusses the gate at length
 * precisely to explain why it must NOT be applied there.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** packages/operator-core/lib — every op_status writer found today lives under it. */
const libRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * A SQL write that puts a plan ONTO the retired axis. Matches the tree's own
 * formatting (`op_status     = 'started'`), and only uppercase `SET` so the
 * prose in these modules' headers ("Sets op_status='paused' on the plan's row")
 * is not mistaken for a write.
 */
export const ENTERING_WRITE = /SET\s+op_status\s*=\s*'(?:started|paused)'/;

/**
 * Gate AWARENESS, as an actual call. A file that merely names the gate — as
 * pause.ts does, to explain why it is absent — is NOT gated, and must earn an
 * ALLOW entry instead of passing on vocabulary.
 */
export const GATE_CALL = /(?:mugKettleSystemEnabled|refuseIfMugKettleRetired)\s*\(/;

/** Exposed so the guard's teeth are provable against SYNTHETIC sources — never by
 *  briefly mutating a file in a tree the whole fleet shares (git-sync sweeps every
 *  few minutes and would commit the mutant even though nothing went wrong). */
export function writesUngatedOpStatus(src: string): boolean {
  return ENTERING_WRITE.test(src) && !GATE_CALL.test(src);
}

/**
 * Writers that enter the axis WITHOUT the gate, each with the reason it is
 * tolerated. An entry is a real claim, not a silencer: it says this writer
 * cannot strand items today AND names what would make it start.
 */
const ALLOW: ReadonlyMap<string, string> = new Map([
  [
    'agent-tools/plans/pause.ts',
    "EXIT-ONLY. The `AND op_status IS NOT NULL` guard means it can only rewrite a row ALREADY on the axis ('started'→'paused'), never put one there. It is also the sole remaining lever that removes a pre-P-047 plan from the DBOS frontier's dispatch (orchestrator-loop.ts reads op_status='started' and is NOT gated), so refusing it would freeze those plans dispatchable with no off switch — the stopper carve-out in _mug-kettle-gate.ts's scope note. D-061.",
  ],
]);

const isTest = (f: string) => /\.(test|integration\.test)\.tsx?$/.test(f);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__snapshots__' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (full.endsWith('.ts') && !isTest(full)) out.push(full);
  }
  return out;
}

/** Every non-test source under lib/ that SQL-writes op_status onto the axis. */
function enteringWriters(): { rel: string; gated: boolean }[] {
  const out: { rel: string; gated: boolean }[] = [];
  for (const file of walk(libRoot)) {
    const src = readFileSync(file, 'utf8');
    if (!ENTERING_WRITE.test(src)) continue;
    out.push({ rel: relative(libRoot, file), gated: GATE_CALL.test(src) });
  }
  return out;
}

describe('op_status writer census — the predicate has teeth', () => {
  // A guard nobody has watched FAIL is decoration.
  it('flags an ungated writer', () => {
    expect(
      writesUngatedOpStatus(`
        await tx\`UPDATE harness_shared.harness_plans
                    SET op_status = 'started', op_updated_at = \${now}\`;
      `),
    ).toBe(true);
  });

  it('clears the same writer once it calls the gate', () => {
    expect(
      writesUngatedOpStatus(`
        if (!(await mugKettleSystemEnabled())) return;
        await tx\`UPDATE harness_shared.harness_plans SET op_status = 'started'\`;
      `),
    ).toBe(false);
  });

  it("does not flag an EXIT write ('done') — leaving the axis is always allowed", () => {
    expect(writesUngatedOpStatus(`await tx\`... SET op_status = 'done', op_updated_at = \${now}\`;`)).toBe(false);
  });

  it('does not flag prose that merely describes the write', () => {
    expect(writesUngatedOpStatus(`/** Sets op_status='started' on the plan row. */`)).toBe(false);
  });

  it('is NOT satisfied by naming the gate without calling it', () => {
    // pause.ts is exactly this shape: it discusses refuseIfMugKettleRetired in
    // order to explain why it is deliberately absent.
    expect(
      writesUngatedOpStatus(`
        // Deliberately not gated: do not add refuseIfMugKettleRetired here.
        await tx\`... SET op_status = 'paused'\`;
      `),
    ).toBe(true);
  });
});

describe('op_status writer census — the live tree', () => {
  it('every writer that ENTERS the retired axis is gated or explicitly allowed', () => {
    const offenders = enteringWriters()
      .filter((w) => !w.gated && !ALLOW.has(w.rel))
      .map((w) => w.rel);
    expect(
      offenders,
      'A new writer puts plans back on the retired op_status axis, where their items are ' +
        'RESERVED from scheduler self-selection for a dispatcher that no longer runs (D-010). ' +
        'Gate it with mugKettleSystemEnabled (see agent-tools/plans/start.ts), or add an ALLOW ' +
        'entry above stating why it cannot strand a lane.',
    ).toEqual([]);
  });

  it('plans:start — the owner-facing writer — is gated', () => {
    const start = enteringWriters().find((w) => w.rel === 'agent-tools/plans/start.ts');
    // If this goes undefined the write was removed or reshaped: re-read P-047
    // before deleting the assertion, because an un-findable writer also makes
    // the census above silently weaker.
    expect(start, 'plans:start no longer contains a recognisable op_status write').toBeDefined();
    expect(start?.gated).toBe(true);
  });

  it('spawn-child — the promote-time writer — is gated (P-071, ALLOW entry deleted)', () => {
    const spawn = enteringWriters().find((w) => w.rel === 'agent-tools/coordination/spawn-child.ts');
    // Same shape as the plans:start assertion above, and for the same reason: if
    // the write is removed or reshaped this goes undefined, which would ALSO make
    // the census silently weaker. P-071 gated it and deleted its ALLOW entry, so
    // an ungated re-appearance must fail here rather than inherit an exemption.
    expect(spawn, 'spawn-child no longer contains a recognisable op_status write').toBeDefined();
    expect(spawn?.gated).toBe(true);
  });

  it('ready-plan-autostart — the scout-sweep writer — is gated (P-070, ALLOW entry deleted)', () => {
    const sweep = enteringWriters().find((w) => w.rel === 'scout/ready-plan-autostart.ts');
    // The last writer to come off the ALLOW list. Its exemption was earned by
    // being DORMANT (no started pot ⇒ the sweep returns before reaching the
    // write), which is a property of the DATA, not of the code — one
    // `hive_started` row flipping true would have re-armed an ungated write with
    // nothing failing. P-070 replaced that with a real gate plus a debounce latch
    // standing in for the op_status write's own once-only property.
    expect(sweep, 'ready-plan-autostart no longer contains a recognisable op_status write').toBeDefined();
    expect(sweep?.gated).toBe(true);
  });

  it('has no STALE allowances — an entry whose file stopped writing is removed', () => {
    const writing = new Set(enteringWriters().map((w) => w.rel));
    const stale = [...ALLOW.keys()].filter((rel) => !writing.has(rel));
    expect(
      stale,
      'These files no longer write op_status onto the axis (or moved). Drop the ALLOW entry — ' +
        'a stale allowance is how the next real writer inherits a pre-approved exemption.',
    ).toEqual([]);
  });
});
