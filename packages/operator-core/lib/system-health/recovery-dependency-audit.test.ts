/**
 * Tests for the P-004 recovery-mechanism circular-dependency audit.
 *
 * Three jobs, in descending order of what actually stops rot:
 *
 *  1. THE ANTI-ROT GATE — every `category: 'watchdog'` timer in the tree must be declared
 *     in `RECOVERY_MECHANISMS`. This is the whole point: the "must survive what it
 *     watches" invariant has been true-but-unchecked since the category was introduced,
 *     so a NEW sentinel that violates it is caught by nobody. Now it is caught here.
 *  2. THE VERDICT LOGIC is falsifiable on synthetic mechanisms — deliberately-wrong
 *     controls live in this file permanently, so the property is never passing merely
 *     because the real table happens to be clean (the repo's tier-1 falsifiability rule:
 *     never mutate the shared tree to prove a guard fails).
 *  3. THE REAL TABLE's verdicts are pinned, so a silent re-classification of a known
 *     fate-shared mechanism has to be a deliberate edit here.
 */
import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RECOVERY_MECHANISMS,
  EXECUTOR_REQUIRES,
  HOLDER_LOSS_DISPOSITIONS,
  auditRecoveryDependencies,
  fateSharedComponents,
  findBrokenBackstops,
  findCoverageGaps,
  findHolderLossGaps,
  renderRecoveryAuditTable,
  verdictFor,
  type HolderLossDisposition,
  type RecoveryMechanism,
} from './recovery-dependency-audit';
import { GOAL_HOLDER_ON_LOSS } from '../goal-launch-settings-shared';
import {
  extractManagedTimerCalls,
  scanWatchdogTimers,
  stripCommentsAndStringBodies,
} from './recovery-dependency-scan';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('recovery-dependency-audit — verdict logic (falsifiable controls)', () => {
  /** CONTROL: an executor that requires exactly the thing the mechanism recovers. */
  const circularControl: RecoveryMechanism = {
    name: 'control-circular',
    file: 'control.ts',
    executor: 'routine-system-action',
    recovers: ['routines-tick'],
    note: 'A routine that recovers the routines tick — cannot fire when it is needed.',
  };

  /** CONTROL: the same defect, papered over with a mitigation. */
  const mitigatedControl: RecoveryMechanism = {
    ...circularControl,
    name: 'control-mitigated',
    mitigation: { kind: 'leading-indicator', why: 'acts before the tick dies' },
  };

  /** CALIBRATION: a genuinely sound mechanism, so the controls above are not passing
   *  because the predicate returns the same answer for everything. */
  const soundControl: RecoveryMechanism = {
    name: 'control-sound',
    file: 'control.ts',
    executor: 'sidecar-process-timer',
    recovers: ['operator-host-process'],
    note: 'A sidecar watching the operator — observer outside the failure domain.',
  };

  it('flags an executor that depends on what it recovers', () => {
    expect(fateSharedComponents(circularControl)).toEqual(['routines-tick']);
    expect(verdictFor(circularControl)).toBe('fate-shared');
  });

  it('downgrades — but does not clear — a fate-shared mechanism with a mitigation', () => {
    expect(fateSharedComponents(mitigatedControl)).toEqual(['routines-tick']);
    expect(verdictFor(mitigatedControl)).toBe('fate-shared-mitigated');
  });

  it('calls a mechanism sound when its executor is outside the failure domain', () => {
    expect(fateSharedComponents(soundControl)).toEqual([]);
    expect(verdictFor(soundControl)).toBe('sound');
  });

  it('counts verdicts and reports the coverage boundary', () => {
    const result = auditRecoveryDependencies([circularControl, mitigatedControl, soundControl]);
    expect(result.counts).toEqual({ sound: 1, 'fate-shared-mitigated': 1, 'fate-shared': 1 });
    // The durable-tier limit must travel WITH the numbers, never be inferred by the reader.
    expect(result.coverage.durableTierDiscovery).toBe('manual');
    expect(result.coverage.ephemeralTierDiscovery).toBe('mechanical');
    expect(result.coverage.declared).toBe(3);
    expect(result.coverage.durableTierDeclared).toBe(2);
  });

  it('composes executor requirements downward — an agent-dispatching routine needs strictly more than a plain one', () => {
    const plain = new Set(EXECUTOR_REQUIRES['routine-system-action']);
    for (const c of plain) expect(EXECUTOR_REQUIRES['routine-agent-dispatch']).toContain(c);
    expect(EXECUTOR_REQUIRES['routine-agent-dispatch']).toContain('agent-session');
    expect(EXECUTOR_REQUIRES['routine-system-action']).not.toContain('agent-session');
  });

  it('an off-loop executor survives a main-loop stall; an in-process timer does not', () => {
    expect(EXECUTOR_REQUIRES['operator-in-process-timer']).toContain('operator-event-loop');
    expect(EXECUTOR_REQUIRES['operator-off-loop']).not.toContain('operator-event-loop');
    expect(EXECUTOR_REQUIRES['cluster-primary-timer']).not.toContain('operator-event-loop');
  });
});

describe('recovery-dependency-audit — backstop integrity (falsifiable controls)', () => {
  it('rejects a backstop that names a mechanism not in the table', () => {
    const broken = findBrokenBackstops([
      {
        name: 'a',
        file: 'a.ts',
        executor: 'operator-in-process-timer',
        recovers: ['operator-event-loop'],
        mitigation: { kind: 'out-of-band-backstop', backstop: 'does-not-exist', why: 'x' },
        note: '',
      },
    ]);
    expect(broken).toEqual([{ name: 'a', backstop: 'does-not-exist', reason: 'unknown-backstop' }]);
  });

  it('rejects a backstop that is itself unmitigated fate-shared on the same component', () => {
    const broken = findBrokenBackstops([
      {
        name: 'a',
        file: 'a.ts',
        executor: 'operator-in-process-timer',
        recovers: ['operator-event-loop'],
        mitigation: { kind: 'out-of-band-backstop', backstop: 'b', why: 'x' },
        note: '',
      },
      {
        name: 'b',
        file: 'b.ts',
        executor: 'operator-in-process-timer',
        recovers: ['operator-event-loop'],
        note: 'also on the loop it judges',
      },
    ]);
    expect(broken).toEqual([{ name: 'a', backstop: 'b', reason: 'backstop-also-fate-shared' }]);
  });

  it('accepts a backstop that is genuinely out of the failure domain', () => {
    expect(
      findBrokenBackstops([
        {
          name: 'a',
          file: 'a.ts',
          executor: 'operator-in-process-timer',
          recovers: ['operator-event-loop'],
          mitigation: { kind: 'out-of-band-backstop', backstop: 'b', why: 'x' },
          note: '',
        },
        {
          name: 'b',
          file: 'b.ts',
          executor: 'cluster-primary-timer',
          recovers: ['operator-event-loop'],
          note: 'primary observes the worker',
        },
      ]),
    ).toEqual([]);
  });

  it('every backstop named in the REAL table resolves and is itself sound on that component', () => {
    expect(findBrokenBackstops()).toEqual([]);
  });
});

describe('recovery-dependency-scan — call extraction', () => {
  it('reads the literal name and category out of a call', () => {
    expect(
      extractManagedTimerCalls(
        `managedSetInterval('my-watchdog', 5_000, tick, { category: 'watchdog' });`,
      ),
    ).toEqual([{ name: 'my-watchdog', category: 'watchdog' }]);
  });

  it('handles nested parens in the callback without losing the trailing options', () => {
    expect(
      extractManagedTimerCalls(
        `managedSetInterval('x', ms(30), () => void run(a, (b) => c(b)), { category: 'watchdog', shed: true });`,
      ),
    ).toEqual([{ name: 'x', category: 'watchdog' }]);
  });

  it('reports an unreadable category as null rather than dropping the site', () => {
    const calls = extractManagedTimerCalls(`managedSetInterval(check.name, ms, fn, { category: cat });`);
    expect(calls).toEqual([{ name: null, category: null }]);
  });

  it('does not match a longer identifier that merely ends in the call name', () => {
    expect(extractManagedTimerCalls(`wrapManagedSetInterval('x', 1, fn, { category: 'watchdog' });`)).toEqual([]);
  });

  it('ignores a call written inside a comment', () => {
    expect(
      extractManagedTimerCalls(
        `/** Describes managedSetInterval('ghost', 1, fn, { category: 'watchdog' }) in prose. */\n` +
          `managedSetInterval('real', 1, fn, { category: 'watchdog' });`,
      ),
    ).toEqual([{ name: 'real', category: 'watchdog' }]);
  });

  it('ignores a call written inside a string literal', () => {
    expect(
      extractManagedTimerCalls(
        `const msg = "use managedSetInterval('ghost', 1, fn, { category: 'watchdog' })";`,
      ),
    ).toEqual([]);
  });

  it('the stripper preserves offsets so literals stay readable at the same span', () => {
    const src = `// managedSetInterval('ghost')\nmanagedSetInterval('real', 1, fn, {});`;
    const stripped = stripCommentsAndStringBodies(src);
    expect(stripped.length).toBe(src.length);
    expect(stripped.split('\n').length).toBe(src.split('\n').length);
  });

  it('finds every call in a file, not just the first', () => {
    expect(
      extractManagedTimerCalls(
        `managedSetInterval('a', 1, fn, { category: 'watchdog' });\nmanagedSetInterval('b', 2, fn, { category: 'cache' });`,
      ),
    ).toEqual([
      { name: 'a', category: 'watchdog' },
      { name: 'b', category: 'cache' },
    ]);
  });
});

describe('recovery-dependency-audit — the coverage gate itself is falsifiable', () => {
  const declaredOnly: RecoveryMechanism[] = [
    {
      name: 'known-timer',
      file: 'x.ts',
      executor: 'operator-in-process-timer',
      recovers: [],
      note: '',
    },
  ];

  it('reports a scanned timer that has no declaration', () => {
    const gaps = findCoverageGaps(
      [
        { name: 'known-timer', file: 'x.ts' },
        { name: 'brand-new-watchdog', file: 'y.ts' },
      ],
      declaredOnly,
    );
    expect(gaps.undeclared).toEqual([{ name: 'brand-new-watchdog', file: 'y.ts' }]);
  });

  it('reports an unreadable timer name rather than treating it as covered', () => {
    const gaps = findCoverageGaps([{ name: null, file: 'z.ts' }], declaredOnly);
    expect(gaps.unreadable).toEqual([{ file: 'z.ts' }]);
    expect(gaps.undeclared).toEqual([]);
  });

  it('reports a declaration whose timer no longer exists in the tree', () => {
    const gaps = findCoverageGaps([], declaredOnly);
    expect(gaps.stale).toEqual(['known-timer']);
  });

  it('is clean when the scan and the declarations agree', () => {
    expect(findCoverageGaps([{ name: 'known-timer', file: 'x.ts' }], declaredOnly)).toEqual({
      undeclared: [],
      unreadable: [],
      stale: [],
    });
  });
});

describe('recovery-dependency-audit — coverage of the live tree (THE ANTI-ROT GATE)', () => {
  const scanned = scanWatchdogTimers(REPO_ROOT);

  it('finds the watchdog population (the scan itself is not silently broken)', () => {
    // A scan that returns nothing would make the coverage assertion below vacuously
    // pass — the classic false-clean. Pin a floor well under the real count (35 at
    // the time of writing).
    expect(scanned.length).toBeGreaterThan(25);
  });

  it('the scan does not match call-shaped text in prose (no phantom rows)', () => {
    // This module's own header describes the call it looks for. Before comments and
    // string bodies were stripped, that produced a 36th "timer" in a file that arms
    // none — a phantom that inflates the population the gate claims to cover.
    const selfMatches = scanned.filter((t) => t.file.includes('recovery-dependency-'));
    expect(selfMatches).toEqual([]);
  });

  it('every category:\'watchdog\' timer in the tree is declared in RECOVERY_MECHANISMS', () => {
    const gaps = findCoverageGaps(scanned);

    expect(
      gaps.undeclared,
      'These timers register as category:\'watchdog\' — whose contract in @papercusp/scheduled-registry is "out-of-band sentinel, MUST SURVIVE WHAT IT WATCHES" — but are not declared in RECOVERY_MECHANISMS (packages/operator-core/lib/system-health/recovery-dependency-audit.ts).\n' +
        'Add a row naming its executor and, in `recovers`, which substrate components are INSIDE the failure it targets (empty is the common, correct answer). See the module header for the rule.',
    ).toEqual([]);
    expect(gaps.unreadable, 'watchdog timers whose name is not a literal — undeclarable, so unverifiable').toEqual(
      [],
    );
  });

  it('no declared ephemeral-tier mechanism has gone missing from the tree', () => {
    // A declaration for a timer that no longer exists is stale bookkeeping that makes
    // the table look more complete than it is.
    expect(findCoverageGaps(scanned).stale).toEqual([]);
  });
});

describe('recovery-dependency-audit — holder-loss dispositions (falsifiable controls)', () => {
  /** CONTROL: an on-loss value the schema admits that nobody declared a disposition for. */
  const undeclaredControl = { deactivate: HOLDER_LOSS_DISPOSITIONS.deactivate };

  /** CONTROL: a disposition claiming a real actor that is not in RECOVERY_MECHANISMS. */
  const phantomMechanismControl: Record<string, HolderLossDisposition> = {
    deactivate: HOLDER_LOSS_DISPOSITIONS.deactivate,
    respawn: { kind: 'recovery-mechanism', mechanism: 'not-a-real-holder-respawner', why: 'control' },
  };

  /** CONTROL: an IOU with nobody on the hook for it. */
  const unownedPlanControl: Record<string, HolderLossDisposition> = {
    deactivate: HOLDER_LOSS_DISPOSITIONS.deactivate,
    respawn: { kind: 'planned', why: 'control — no planItem' },
  };

  it('reports an admitted on-loss value with no declared disposition', () => {
    const gaps = findHolderLossGaps(['deactivate', 'respawn'], undeclaredControl);
    expect(gaps.undeclared).toEqual(['respawn']);
  });

  it('reports a disposition naming a recovery mechanism that does not exist', () => {
    // This is the forcing function for P-009: the moment respawn claims a real
    // actor, that actor has to appear in RECOVERY_MECHANISMS and be judged for
    // fate-sharing like every other one. A named-but-absent mechanism is a
    // recovery that is declared and does not exist.
    const gaps = findHolderLossGaps(['deactivate', 'respawn'], phantomMechanismControl);
    expect(gaps.unresolvedMechanism).toEqual([
      { onLoss: 'respawn', mechanism: 'not-a-real-holder-respawner' },
    ]);
  });

  it('resolves a disposition whose mechanism IS in the table — the calibration case', () => {
    // Without this, the control above could be passing because the check reports
    // EVERY 'recovery-mechanism' row as unresolved.
    const realName = RECOVERY_MECHANISMS[0].name;
    const gaps = findHolderLossGaps(['deactivate', 'respawn'], {
      deactivate: HOLDER_LOSS_DISPOSITIONS.deactivate,
      respawn: { kind: 'recovery-mechanism', mechanism: realName, why: 'control' },
    });
    expect(gaps.unresolvedMechanism).toEqual([]);
  });

  it('reports a "planned" disposition that names no plan item', () => {
    const gaps = findHolderLossGaps(['deactivate', 'respawn'], unownedPlanControl);
    expect(gaps.unownedPlan).toEqual(['respawn']);
  });

  it('reports a disposition for a value the schema no longer admits', () => {
    // Drift the other way: an on-loss value removed from the schema leaves a row
    // here describing a recovery for a policy nothing can express any more.
    // Synthetic on purpose — a control driven by the REAL table would change
    // meaning every time that table legitimately grows.
    const gaps = findHolderLossGaps(['deactivate'], {
      deactivate: HOLDER_LOSS_DISPOSITIONS.deactivate,
      'retired-value': { kind: 'derived-at-read', why: 'control — no longer in the schema' },
    });
    expect(gaps.stale).toEqual(['retired-value']);
  });

  it('is clean when the closed set and the dispositions agree', () => {
    const gaps = findHolderLossGaps(['deactivate'], {
      deactivate: HOLDER_LOSS_DISPOSITIONS.deactivate,
    });
    expect(gaps).toEqual({ undeclared: [], stale: [], unresolvedMechanism: [], unownedPlan: [] });
  });
});

describe('recovery-dependency-audit — holder-loss coverage of the REAL closed set', () => {
  it('every on-loss value the goal schema admits has a declared disposition', () => {
    // THE ANTI-ROT GATE for holder-required goals, and the reason this test
    // imports the closed set rather than restating it: adding a value to
    // GOAL_HOLDER_ON_LOSS is a one-line edit that reads as harmless, but each
    // value is a promise about a recovery. This fails until the promise is
    // declared here and judged.
    expect(GOAL_HOLDER_ON_LOSS.length).toBeGreaterThan(0);
    const gaps = findHolderLossGaps(GOAL_HOLDER_ON_LOSS);
    expect(gaps.undeclared).toEqual([]);
    expect(gaps.stale).toEqual([]);
    expect(gaps.unresolvedMechanism).toEqual([]);
    expect(gaps.unownedPlan).toEqual([]);
  });

  it('deactivate is derived-at-read — it has no executor to be fate-shared with', () => {
    // The plan's whole thesis, pinned: the default disposition runs NOTHING.
    // A future edit that gives it a sweeper has to change this line, which is
    // exactly the review moment that was missing when the stale agent_modes row
    // became the accepted answer.
    expect(HOLDER_LOSS_DISPOSITIONS.deactivate.kind).toBe('derived-at-read');
    expect(HOLDER_LOSS_DISPOSITIONS.deactivate.mechanism).toBeUndefined();
  });

  it("respawn is backed by P-009's sound operator-host recovery mechanism", () => {
    expect(HOLDER_LOSS_DISPOSITIONS.respawn).toMatchObject({
      kind: 'recovery-mechanism',
      mechanism: 'goal-holder-respawner',
    });
    const mechanism = RECOVERY_MECHANISMS.find((row) => row.name === 'goal-holder-respawner');
    expect(mechanism).toMatchObject({
      executor: 'operator-in-process-timer',
      recovers: [],
    });
    if (!mechanism) throw new Error('goal-holder-respawner declaration missing');
    expect(verdictFor(mechanism)).toBe('sound');
  });

  it('every disposition carries a reason — an unexplained one is just a label', () => {
    for (const [onLoss, d] of Object.entries(HOLDER_LOSS_DISPOSITIONS)) {
      expect(d.why.length, `${onLoss} has no why`).toBeGreaterThan(40);
    }
  });
});

describe('recovery-dependency-audit — the real table (pinned verdicts)', () => {
  const result = auditRecoveryDependencies();
  const byName = new Map(result.rows.map((r) => [r.name, r]));

  it('every declared mechanism resolves to a verdict', () => {
    expect(result.rows.length).toBe(RECOVERY_MECHANISMS.length);
    expect(result.counts.sound + result.counts['fate-shared-mitigated'] + result.counts['fate-shared']).toBe(
      result.rows.length,
    );
  });

  it('names are unique — a duplicate row would double-count a verdict', () => {
    expect(new Set(RECOVERY_MECHANISMS.map((m) => m.name)).size).toBe(RECOVERY_MECHANISMS.length);
  });

  it('THE FINDING: the blender steward heartbeat is fate-shared, with an out-of-band mitigation', () => {
    const row = byName.get('plan-schedule-blender-steward-heartbeat-2026-08-11');
    expect(row?.executor).toBe('routine-agent-dispatch');
    // The heartbeat still cannot perform the recovery when the agent layer is
    // empty; P-006 only makes the real backstop explicit.
    expect(row?.verdict).toBe('fate-shared-mitigated');
    expect(row?.fateSharedOn).toEqual(['agent-session', 'work-item-dispatch']);
    expect(row?.mitigation).toMatchObject({
      kind: 'out-of-band-backstop',
      backstop: 'goal-liveness-watchdog',
    });
  });

  it('the event-loop family is classified by whether the executor rides the judged loop', () => {
    // On the loop, covering only the degraded case — mitigated by a named out-of-band backstop.
    expect(byName.get('event-loop-lag-monitor')?.verdict).toBe('fate-shared-mitigated');
    expect(byName.get('lag-self-restart')?.verdict).toBe('fate-shared-mitigated');
    // Fate-shared ON PURPOSE: their silence is what the off-loop observer reads.
    expect(byName.get('event-loop-sentinel-heartbeat')?.mitigation?.kind).toBe('absence-is-the-signal');
    expect(byName.get('cluster-lag-beat')?.mitigation?.kind).toBe('absence-is-the-signal');
    // The observer that is genuinely outside the failure domain.
    expect(byName.get('cluster-lag-scan')?.verdict).toBe('sound');
  });

  it('the deliberately-out-of-band DBOS mechanisms are sound', () => {
    // Their headers each argue this in prose; the audit now agrees mechanically.
    expect(byName.get('dbos-executor-reaper')?.verdict).toBe('sound');
    expect(byName.get('red-queen-engine-death')?.verdict).toBe('sound');
    expect(byName.get('routine-fire-cancellation-alarm')?.verdict).toBe('sound');
  });

  it('a mitigation always carries a reason — an unexplained one is just a label', () => {
    for (const m of RECOVERY_MECHANISMS) {
      if (!m.mitigation) continue;
      expect(m.mitigation.why.length, `${m.name} mitigation.why`).toBeGreaterThan(20);
      if (m.mitigation.kind === 'out-of-band-backstop') {
        expect(m.mitigation.backstop, `${m.name} names its backstop`).toBeTruthy();
      }
    }
  });

  it('renders a markdown table with the mitigated findings and states its coverage', () => {
    const table = renderRecoveryAuditTable(result);
    const lines = table.split('\n');
    const firstRow = lines[2] ?? '';
    // P-006 closes the final unmitigated real-table finding; the first rows are
    // now the explicitly mitigated cases, still ordered ahead of sound rows.
    expect(firstRow).toContain('fate-shared');
    expect(firstRow).toContain('fate-shared-mitigated');
    expect(result.counts['fate-shared']).toBe(0);
    expect(table).toContain('the durable-tier list is NOT exhaustive');
  });
});
