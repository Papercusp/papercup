/**
 * vacuous-flag-guard.test.ts — falsifiability controls for
 * `scripts/check-vacuous-flag-guard.mjs` (WI-38269).
 *
 * ── WHY THE CONTROLS ARE FIXTURES, NOT A MUTATION PROBE ──────────────────────
 * A guard that has never failed is a guard nobody has tested, and this one is
 * *about* tests that pass for the wrong reason — so shipping it unfalsified would
 * be the exact defect it detects, one level up.
 *
 * The obvious way to prove it — mutate a real test file, run the guard, restore —
 * is unsafe in this repo and has already cost a committed mutant: git-sync sweeps
 * the WHOLE working tree on a timer, so a probe legitimately holding a file
 * mutated for the length of a run can be COMMITTED even when nothing goes wrong
 * and no handler fails. A `trap` cannot fix that; it is a race, not an error path.
 *
 * So these are tier-1 controls per the repo rule: deliberately-wrong SUBJECTS live
 * permanently in this file and are fed to the guard through its injected
 * `readFile`/`files` seam. Nothing on disk is touched, there is no restore step to
 * skip, and the controls cannot rot away from the guard because they ARE the
 * guard's input.
 *
 * The positive controls alone are not enough: a guard that flagged EVERYTHING
 * would pass all of them. Each is therefore paired with a CALIBRATION case — the
 * same tree with the one defect removed — which must come back clean.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs guard, imported for its exports exactly as the sibling
// guard tests do (lint-migrations.test.ts, no-bespoke-state-read-guard.test.ts).
import { scan } from '../../../scripts/check-vacuous-flag-guard.mjs';

/**
 * The repo root this suite enforces the guard OVER.
 *
 * Passed explicitly rather than leaning on the script's own default, for two
 * reasons. It states the subject of the real-tree case at the call site — a test
 * that runs a detector over "wherever it happens to point" is not an enforcement
 * test. And `check-lint-guard-reachability.mjs` classifies a guard's coverage by
 * whether its test actually DRIVES A SCAN OVER REPOSITORY FILES
 * (`ENFORCING_TEST_RE`) rather than merely feeding its helpers fixtures: the
 * fixtures-only shape is the `logic-test` tier, which that script documents as
 * ADVISORY — it "makes the guard look thoroughly covered, which is worse than no
 * test at all", measured on lint:mock-cast-escape while its real-tree count drifted
 * +45 past baseline with every unit test green. The real-tree case below is what
 * makes this guard BLOCKING; deleting it would silently demote the guard to
 * unenforced while leaving 10 green tests behind.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

type Tree = Record<string, string>;

function run(tree: Tree) {
  return scan({
    files: Object.keys(tree),
    readFile: (rel: string) => (rel in tree ? tree[rel] : null),
  });
}

/** A component that genuinely reads a flag. */
const SUBJECT_READS_FLAG = `
  import { useFlag } from '@papercusp/flags/client';
  export default function Widget() {
    const on = useFlag('papercusp-thing');
    return on ? 'yes' : null;
  }
`;

/** The same component AFTER the flag read was removed — the motivating shape. */
const SUBJECT_READS_NOTHING = `
  import { runControl } from './control';
  export default function Widget() {
    return runControl() ? 'yes' : null;
  }
`;

/** A test whose flag mock is driven by a knob it reassigns between cases. */
const TEST_WITH_MUTABLE_KNOB = `
  import { render } from '@testing-library/react';
  let tierLive = false;
  vi.mock('@papercusp/flags/client', () => ({ useFlag: () => tierLive }));
  import Widget from './Widget';
  it('hides when off', () => { tierLive = false; render(<Widget />); });
  it('shows when on', () => { tierLive = true; render(<Widget />); });
`;

describe('vacuous flag guard — RULE B: a flag mock with no consumer', () => {
  it('GATES a mutable flag knob whose subject reads no flag (the motivating instance)', () => {
    const r = run({
      'app/Widget.tsx': SUBJECT_READS_NOTHING,
      'app/control.ts': 'export const runControl = () => true;',
      'app/Widget.test.tsx': TEST_WITH_MUTABLE_KNOB,
    });

    expect(r.gating).toHaveLength(1);
    expect(r.gating[0]).toMatchObject({
      file: 'app/Widget.test.tsx',
      verdict: 'VACUOUS-TOGGLE',
      knob: 'tierLive',
    });
  });

  it('CALIBRATION: the identical tree is CLEAN once the subject actually reads the flag', () => {
    // Same test file, same knob, same mock — only the subject differs. If this
    // ever gates, the control above is passing for the wrong reason and proves
    // nothing about the detector.
    const r = run({
      'app/Widget.tsx': SUBJECT_READS_FLAG,
      'app/Widget.test.tsx': TEST_WITH_MUTABLE_KNOB,
    });

    expect(r.gating).toHaveLength(0);
    expect(r.reported).toHaveLength(0);
  });

  it('CALIBRATION: a flag read reached TRANSITIVELY still counts as binding', () => {
    // The mock insulates a real consumer two hops down. Flagging this would be the
    // detector's most likely false-positive shape.
    const r = run({
      'app/Widget.tsx': `import { helper } from './helper';\nexport default () => helper();`,
      'app/helper.ts': `import { deep } from './deep';\nexport const helper = () => deep();`,
      'app/deep.ts': `import { getFlag } from '@papercusp/flags/server';\nexport const deep = () => getFlag('x');`,
      'app/Widget.test.tsx': TEST_WITH_MUTABLE_KNOB,
    });

    expect(r.gating).toHaveLength(0);
  });

  it('demotes a CONSTANT mock to the report bucket instead of gating', () => {
    const r = run({
      'app/Widget.tsx': SUBJECT_READS_NOTHING,
      'app/control.ts': 'export const runControl = () => true;',
      'app/Widget.test.tsx': `
        vi.mock('@papercusp/flags/client', () => ({ useFlag: () => false }));
        import Widget from './Widget';
      `,
    });

    expect(r.gating).toHaveLength(0);
    expect(r.reported).toHaveLength(1);
    expect(r.reported[0].verdict).toBe('INERT-MOCK');
  });

  it('does NOT gate when a local import could not be resolved — "could not look" ≠ "nothing there"', () => {
    // `./generated-api` is not in the file set (a generated module). The subject tree
    // was therefore never fully read, so a gating verdict would be manufactured out of
    // a blind spot. This is the fail-safe direction and the property most likely to be
    // "simplified" away by a later editor.
    const r = run({
      'app/Widget.tsx': SUBJECT_READS_NOTHING,
      'app/control.ts': `import { gen } from './generated-api';\nexport const runControl = () => gen();`,
      'app/Widget.test.tsx': `
        let tierLive = false;
        vi.mock('@papercusp/flags/client', () => ({ useFlag: () => tierLive }));
        import Widget from './Widget';
        import { gen } from './generated-api';
        it('a', () => { tierLive = true; });
      `,
    });

    expect(r.gating).toHaveLength(0);
    expect(r.reported[0].verdict).toBe('UNPROVABLE-TOGGLE');
  });

  it('honors the `vacuous-flag-ok:` suppression pragma, on the line and in the comment above', () => {
    const onLine = run({
      'app/Widget.tsx': SUBJECT_READS_NOTHING,
      'app/Widget.test.tsx': `
        let tierLive = false;
        vi.mock('@papercusp/flags/client', () => ({ useFlag: () => tierLive })); // vacuous-flag-ok: deliberate
        import Widget from './Widget';
        it('a', () => { tierLive = true; });
      `,
    });
    expect(onLine.gating).toHaveLength(0);
    expect(onLine.reported).toHaveLength(0);

    const inComment = run({
      'app/Widget.tsx': SUBJECT_READS_NOTHING,
      'app/Widget.test.tsx': `
        let tierLive = false;
        // vacuous-flag-ok: the component drops the hook behind a lazy boundary
        vi.mock('@papercusp/flags/client', () => ({ useFlag: () => tierLive }));
        import Widget from './Widget';
        it('a', () => { tierLive = true; });
      `,
    });
    expect(inComment.gating).toHaveLength(0);
    expect(inComment.reported).toHaveLength(0);
  });

  it('ignores tests whose SUBJECT is the flag machinery itself', () => {
    const r = run({
      'libs/flags/src/client.ts': 'export const useFlag = () => false;',
      'libs/flags/src/client.test.ts': `
        let tierLive = false;
        vi.mock('@papercusp/flags/client', () => ({ useFlag: () => tierLive }));
        it('a', () => { tierLive = true; });
      `,
    });

    expect(r.gating).toHaveLength(0);
    expect(r.reported).toHaveLength(0);
  });
});

describe('vacuous flag guard — RULE A: a flag key no source file reads', () => {
  it('reports a FLAGS key referenced only by tests', () => {
    const r = run({
      'app/thing.ts': 'export const thing = 1;',
      'app/thing.test.ts': `import { FLAGS } from '@papercusp/flags';\nit('a', () => { expect(FLAGS.ORPHANED_KEY).toBeDefined(); });`,
    });

    expect(r.testOnlyKeys).toHaveLength(1);
    expect(r.testOnlyKeys[0].key).toBe('ORPHANED_KEY');
  });

  it('CALIBRATION: the same key is NOT reported once a source file references it', () => {
    const r = run({
      'app/thing.ts': `import { FLAGS } from '@papercusp/flags';\nexport const k = FLAGS.ORPHANED_KEY;`,
      'app/thing.test.ts': `import { FLAGS } from '@papercusp/flags';\nit('a', () => { expect(FLAGS.ORPHANED_KEY).toBeDefined(); });`,
    });

    expect(r.testOnlyKeys).toHaveLength(0);
  });

  it("does not report the flags library's own synthetic fixture registries", () => {
    // libs/flags' own tests declare fake FLAGS objects (ALPHA, BETA, GAMMA…). These
    // produced 8 confident findings on the detector's first run, every one a false
    // positive — and a report whose entire content is noise is one nobody reads.
    const r = run({
      'libs/flags/src/types.ts': 'export const FLAGS = {} as const;',
      'libs/flags/src/flag-comment-lint.test.ts': `const FLAGS = { ALPHA: 'a' };\nit('a', () => { expect(FLAGS.ALPHA).toBe('a'); });`,
    });

    expect(r.testOnlyKeys).toHaveLength(0);
  });
});

describe('vacuous flag guard — the real tree', () => {
  // 120s, not the 60s default. This case walks the whole tracked tree, and this box runs
  // ~60 agents behind a `pc-heavy` slot queue — so the wall-clock here is dominated by
  // contention, not by the scan (measured standalone: ~4s). It HAS already failed as
  // `Test timed out in 60000ms`, which reads as a real ratchet violation and would send the
  // next reader hunting a vacuous toggle that does not exist. A generous budget on a
  // whole-tree case is the cheap way to keep a red meaningful.
  it('gates nothing on the current checkout (the ratchet this guard installs)', { timeout: 120_000 }, () => {
    // The population was verified clean when this landed, which is exactly when a
    // detector is cheap to add. If this ever fails, a real vacuous toggle has been
    // introduced — fix the test or write the suppression pragma with a reason. Do
    // NOT open a baseline file to park it in.
    const r = scan({ root: REPO_ROOT });
    // Guard the guard: if the enumeration ever comes back empty, `gating` is empty
    // too and this assertion passes while checking nothing — the vacuous shape this
    // whole file exists to detect.
    expect(r.counts.testFiles).toBeGreaterThan(1000);
    expect(r.gating).toEqual([]);
  });
});
