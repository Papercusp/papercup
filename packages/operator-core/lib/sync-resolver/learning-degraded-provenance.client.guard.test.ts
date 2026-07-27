import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  collectClientQueryConsumers,
  degradedCapableResolvers,
  type ClientQueryConsumer,
} from './learning-degraded-provenance.scan';

/**
 * WI-6410 structural guard — the CLIENT half of WI-6382.
 *
 * ## The defect this exists to prevent
 *
 * WI-6382 gave 15 `learning.*` resolvers degraded provenance, and
 * learning-degraded-provenance.guard.test.ts has enforced the server rule ever
 * since. It was green for the entire period in which three views —
 * `learning.bakeoff`, `learning.hiveEvalTrend`, `learning.analyze` — took that
 * carefully-reported `unavailable` flag and threw it away, rendering a failed
 * read as a confident empty state. Bake-off's empty copy went so far as to
 * promise "Results appear here once one has finished."
 *
 * That is worth stating plainly, because it is the reusable lesson: the server
 * guard's greenness was not evidence the user was told the truth. It was
 * evidence of one half of a two-half contract, and a half-contract reads as a
 * whole one until somebody opens the other file. A resolver that reports
 * `unavailable` into a component that ignores it is byte-for-byte as harmful as
 * a resolver that never reported it.
 *
 * ## The rule
 *
 * A component reading a degraded-CAPABLE `learning.*` query must perform at
 * least as many degraded-provenance checks as it has such queries — via the
 * shared `snapshotFault()` helper, or a hand-rolled `.unavailable` /
 * `degradedFields` branch.
 *
 * The COUNT is the load-bearing part. A boolean "does this component handle
 * faults?" would have passed ThroughputView, which reads two degraded-capable
 * queries (`learning.hiveThroughput` + `learning.soakReport`) and — before this
 * guard — folded only one of them into its fault check, leaving a failed soak
 * read to render as healthy silence.
 */

const RESOLVER_INDEX = join(__dirname, 'index.ts');
const ADV_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'apps',
  'operator-vite',
  'src',
  'components',
  'adv',
);

const DEGRADED_CAPABLE = degradedCapableResolvers(readFileSync(RESOLVER_INDEX, 'utf8'));

function scanAdvComponents(): ClientQueryConsumer[] {
  const out: ClientQueryConsumer[] = [];
  for (const name of readdirSync(ADV_DIR)) {
    if (!name.endsWith('.tsx') || name.endsWith('.test.tsx')) continue;
    const src = readFileSync(join(ADV_DIR, name), 'utf8');
    out.push(...collectClientQueryConsumers(src, name));
  }
  return out;
}

const CONSUMERS = scanAdvComponents();

/** Consumers filtered to the queries that can actually arrive degraded. */
function degradedCapableConsumers(consumers: ClientQueryConsumer[]) {
  return consumers
    .map((c) => ({
      ...c,
      queryNames: c.queryNames.filter((q) => DEGRADED_CAPABLE.has(q)),
    }))
    .filter((c) => c.queryNames.length > 0);
}

function violationsOf(consumers: ClientQueryConsumer[]): string[] {
  return degradedCapableConsumers(consumers)
    .filter((c) => c.faultChecks < c.queryNames.length)
    .map(
      (c) =>
        `${c.component} (${c.file}:${c.line}) reads ${c.queryNames.length} degraded-capable ` +
        `quer${c.queryNames.length === 1 ? 'y' : 'ies'} [${c.queryNames.join(', ')}] ` +
        `but performs only ${c.faultChecks} provenance check(s)`,
    );
}

describe('WI-6410 guard — a degraded-capable learning.* read must be checked by its consumer', () => {
  // ── NON-BLINDNESS ────────────────────────────────────────────────────────
  // Same discipline as the server guard (and plan D-005): a green result from a
  // blind instrument is indistinguishable from a green result from a working
  // one. This scanner crosses a TREE boundary and depends on a relative path,
  // so it has an extra way to go quietly blind — prove it sees, first.
  it('the scanner is not blind: it finds the adv components and their learning reads', () => {
    expect(DEGRADED_CAPABLE.size).toBeGreaterThanOrEqual(10);
    expect(CONSUMERS.length).toBeGreaterThanOrEqual(10);
    const withDegradable = degradedCapableConsumers(CONSUMERS);
    expect(withDegradable.length).toBeGreaterThanOrEqual(8);
    // …and it resolves the cross-tree path to real files, not an empty dir.
    const files = new Set(CONSUMERS.map((c) => c.file));
    expect(files.has('LearningTab.tsx')).toBe(true);
    expect(files.size).toBeGreaterThanOrEqual(4);
  });

  it('the scanner can actually SEE a violation (it is not vacuously green)', () => {
    const synthetic = [
      'function SyntheticPanel() {',
      '  const sync = useSyncQuery({',
      `    queryName: "${[...DEGRADED_CAPABLE][0]}",`,
      '  });',
      '  const rows = sync.data?.[0]?.rows ?? [];',
      '  return <Empty />;',
      '}',
    ].join('\n');
    const found = collectClientQueryConsumers(synthetic, 'Synthetic.tsx');
    expect(found).toHaveLength(1);
    expect(found[0].faultChecks).toBe(0);
    expect(violationsOf(found)).toHaveLength(1);
  });

  it('the count rule catches a component that checks only ONE of two reads', () => {
    // The exact shape a presence-only test waves through, and the exact shape
    // ThroughputView had.
    const capable = [...DEGRADED_CAPABLE];
    const synthetic = [
      'function TwoReadPanel() {',
      `  const a = useSyncQuery({ queryName: "${capable[0]}" });`,
      `  const b = useSyncQuery({ queryName: "${capable[1]}" });`,
      '  const fault = snapshotFault(a.error, a.data?.[0], "A");',
      '  return <div />;',
      '}',
    ].join('\n');
    const found = collectClientQueryConsumers(synthetic, 'Synthetic.tsx');
    expect(found[0].queryNames).toHaveLength(2);
    expect(found[0].faultChecks).toBe(1);
    expect(violationsOf(found)).toHaveLength(1);
  });

  it('would have RED-ed on the pre-fix tree — the fix is what makes it green', () => {
    // The strongest non-blindness proof available, and the one the server guard
    // taught: a guard that has never gone red is indistinguishable from a guard
    // that cannot. Reconstruct the pre-WI-6410 client by stripping the fault
    // reads back out, in memory (the tree is shared and swept whole by
    // git-sync, so breaking it on disk would risk committing the intermediate).
    const stripped: ClientQueryConsumer[] = [];
    for (const name of readdirSync(ADV_DIR)) {
      if (!name.endsWith('.tsx') || name.endsWith('.test.tsx')) continue;
      const src = readFileSync(join(ADV_DIR, name), 'utf8')
        .replace(/\bsnapshotFault\s*\(/g, 'noFaultCheck(')
        .replace(/[?.]\.?unavailable\b/g, '.absent')
        .replace(/\bdegradedFields\b/g, 'absentFields');
      stripped.push(...collectClientQueryConsumers(src, name));
    }
    const violations = violationsOf(stripped);
    expect(violations.length).toBeGreaterThanOrEqual(8);
    // The three views WI-6410 actually fixed must be among them.
    const joined = violations.join('\n');
    for (const q of ['learning.bakeoff', 'learning.hiveEvalTrend', 'learning.analyze']) {
      expect(joined).toContain(q);
    }
  });

  // ── THE RULE ─────────────────────────────────────────────────────────────
  it('every degraded-capable learning.* read is provenance-checked by its consumer', () => {
    expect(
      violationsOf(CONSUMERS),
      'This resolver can hand the client a degraded snapshot, and this component ' +
        'discards it — so a FAILED read renders as a confident empty state. Call ' +
        'snapshotFault(sync.error, sync.data?.[0], "<Label>") and render ' +
        '<LearningVisualError> when fault.failed, the way EkgPanel/ExperimentsPanel do.',
    ).toEqual([]);
  });

  it('the shared helper is the convention (the rule has live call sites)', () => {
    const usingHelper = readdirSync(ADV_DIR).filter(
      (n) =>
        n.endsWith('.tsx') &&
        !n.endsWith('.test.tsx') &&
        /\bsnapshotFault\s*\(/.test(readFileSync(join(ADV_DIR, n), 'utf8')),
    );
    expect(usingHelper.length).toBeGreaterThanOrEqual(5);
  });
});
