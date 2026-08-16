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
  auditRecoveryDependencies,
  fateSharedComponents,
  findBrokenBackstops,
  renderRecoveryAuditTable,
  verdictFor,
  type RecoveryMechanism,
} from './recovery-dependency-audit';
import { extractManagedTimerCalls, scanWatchdogTimers } from './recovery-dependency-scan';

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

describe('recovery-dependency-audit — coverage of the live tree (THE ANTI-ROT GATE)', () => {
  const scanned = scanWatchdogTimers(REPO_ROOT);

  it('finds the watchdog population (the scan itself is not silently broken)', () => {
    // A scan that returns nothing would make the coverage assertion below vacuously
    // pass — the classic false-clean. Pin a floor well under the real count.
    expect(scanned.length).toBeGreaterThan(20);
  });

  it('every category:\'watchdog\' timer in the tree is declared in RECOVERY_MECHANISMS', () => {
    const declared = new Set(RECOVERY_MECHANISMS.map((m) => m.name));
    const undeclared = scanned
      .filter((t) => t.name !== null && !declared.has(t.name))
      .map((t) => `${t.name}  (${t.file})`);

    expect(
      undeclared,
      'These timers register as category:\'watchdog\' — whose contract in @papercusp/scheduled-registry is "out-of-band sentinel, MUST SURVIVE WHAT IT WATCHES" — but are not declared in RECOVERY_MECHANISMS (packages/operator-core/lib/system-health/recovery-dependency-audit.ts).\n' +
        'Add a row naming its executor and, in `recovers`, which substrate components are INSIDE the failure it targets (empty is the common, correct answer). See the module header for the rule.',
    ).toEqual([]);
  });

  it('no declared ephemeral-tier mechanism has gone missing from the tree', () => {
    const scannedNames = new Set(scanned.map((t) => t.name));
    const ephemeral = RECOVERY_MECHANISMS.filter((m) => m.executor === 'operator-in-process-timer');
    // A declaration for a timer that no longer exists is stale bookkeeping that makes the
    // table look more complete than it is.
    const stale = ephemeral.filter((m) => !scannedNames.has(m.name)).map((m) => m.name);
    expect(stale).toEqual([]);
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

  it('THE FINDING: the blender steward heartbeat is fate-shared on the agent layer it recovers', () => {
    const row = byName.get('plan-schedule-blender-steward-heartbeat-2026-08-11');
    expect(row?.executor).toBe('routine-agent-dispatch');
    expect(row?.verdict).toBe('fate-shared');
    expect(row?.fateSharedOn).toEqual(['agent-session', 'work-item-dispatch']);
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

  it('renders a markdown table that leads with the unmitigated findings and states its coverage', () => {
    const table = renderRecoveryAuditTable(result);
    const lines = table.split('\n');
    const firstRow = lines[2] ?? '';
    expect(firstRow).toContain('fate-shared');
    expect(firstRow).not.toContain('fate-shared-mitigated');
    expect(table).toContain('the durable-tier list is NOT exhaustive');
  });
});
