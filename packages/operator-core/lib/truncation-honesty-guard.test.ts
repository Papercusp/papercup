/**
 * RECURRENCE GUARD for prose-only truncation (plan
 * `agent-context-firewall-and-output-spill-2026-08-02`, P-010 — the guard leg of
 * the P-009 fix recorded as D-007).
 *
 * ## The class being guarded
 *
 * A truncation DOOR cuts an agent-facing payload because it exceeds a context
 * budget. P-009 found the result door announced its own cut ONLY as an English
 * sentence appended to the text, while its sibling stage (payload-tier) stamped
 * a machine-readable `_meta.payloadProjection`. A consumer therefore had to
 * string-match prose to learn its data was incomplete — one refactor away from
 * silently trusting a truncated result. That is the silent-wrong-answer class.
 *
 * The fix stamps `_meta.resultDoor`. This guard is what stops the class coming
 * back the next time someone adds a door.
 *
 * ## What this guard actually asserts — read this before trusting its green
 *
 * It does NOT assert "every truncation in the tree is machine-readable". Tools
 * cut their own fields all over the place (`summary_truncated`,
 * `body_truncated`, capability:git's inline output cap) and those are a
 * different, tool-local question. What it asserts is narrower and true:
 *
 *   1. every DOOR — recognised structurally, by its call to the shared cutting
 *      primitive `capInjectionText`, or by the house `[<name>-door: …]` footer —
 *      is present in {@link DOORS} with an explicit disposition;
 *   2. a door registered as `structured` still stamps its declared marker key;
 *   3. the result door really does stamp `_meta.resultDoor` at runtime (a
 *      textual check alone would pass on a marker that is built and dropped);
 *   4. any CODE that parses a door's prose footer is declared as a consumer of
 *      it, in both directions — so nobody rewords a footer that something is
 *      quietly regex-matching, and nobody leaves a stale declaration behind.
 *
 * A door that is legitimately prose-only or lossless is allowed — it just has
 * to say so, with a reason, in {@link DOORS}. Forcing that sentence to be
 * written is the whole mechanism: the failure mode is not "someone chose prose",
 * it is "nobody noticed a choice was being made".
 *
 * ## Adding a door
 *
 * Stamp a structured marker on your result and add a `structured` entry. If
 * your door has no envelope to stamp (you are emitting prompt text) or loses
 * nothing (the tail re-delivers), add a `prose-only` / `lossless` entry with the
 * reason. Do not widen the detector to exclude yourself.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanSource, type DoorSite } from './truncation-honesty-scan.js';
import { BAKED_DOOR_CONSTANTS, CHARS_PER_TOKEN_ESTIMATE } from './context-doors';
// Typed via scripts/lib/tracked-files.d.mts.
import { listFilesIncludingUntracked, describeUnscanned } from '../../../scripts/lib/tracked-files.mjs';

// P-023: the door resolves its constants through the config surface per call —
// stub it (that module has its own suite) so this guard runs PG-free. `vi.mock`
// is hoisted above the imports below, so `applyResultDoor` gets the stub.
const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('./context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

import { applyResultDoor, RESULT_DOOR_TOKENS, type DoorableResult } from './result-door';

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  cwd: import.meta.dirname,
}).trim();

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

type Disposition =
  /** The door stamps a machine-readable marker on the result envelope. */
  | { kind: 'structured'; markerKey: string }
  /** No envelope exists to stamp — the payload IS text a model reads. */
  | { kind: 'prose-only'; reason: string }
  /** Nothing is lost, so there is nothing to announce. */
  | { kind: 'lossless'; reason: string };

interface DoorEntry {
  /** Door id — must equal the `<name>` in its `[<name>-door: …]` footer, when
   *  it emits one. */
  id: string;
  /** Repo-relative module that performs the cut. */
  module: string;
  disposition: Disposition;
  /** Repo-relative files whose CODE parses this door's prose footer. Listing
   *  one here is a statement that the footer's wording is load-bearing. */
  footerConsumers?: string[];
}

const DOORS: DoorEntry[] = [
  {
    id: 'result-door',
    module: 'packages/operator-core/lib/result-door.ts',
    disposition: { kind: 'structured', markerKey: 'resultDoor' },
  },
  {
    // No footer: payload-tier shapes structured `data`, it does not append prose.
    id: 'payload-tier',
    module: 'libs/generic/tooldef/src/payload-tier.ts',
    disposition: { kind: 'structured', markerKey: 'payloadProjection' },
  },
  {
    id: 'injection-door',
    // P-024 clause D (review-system-rework-reduction-2026-09-23): the door no longer
    // slices text. wake-executor.ts applyInjectionDoor calls packWakeText, which lives
    // here and emits the footer; nothing is cut mid-section any more.
    module: 'packages/operator-core/lib/events/await/wake-text-budget.ts',
    disposition: {
      kind: 'prose-only',
      reason:
        'The payload is a wake PROMPT typed into a PTY — there is no result envelope to stamp, ' +
        'and the consumer is a model reading text. Prose is the only channel that exists here. ' +
        'Since P-024 clause D the door builds to the budget: whole sections are kept by priority, ' +
        'every section left out is NAMED in the footer, and the full original plus a section ' +
        'index is spilled to ~/.papercusp/wake-spills; the footer names that path.',
    },
    // turn-provenance strips the footer back off with a regex, so its exact
    // opening literal is load-bearing for CODE, not only for a reader.
    footerConsumers: ['packages/operator-core/lib/turn-provenance/turn-provenance.ts'],
  },
  {
    id: 'ambient-push-door',
    module: 'packages/operator-core/lib/ambient-push-delivery.ts',
    disposition: {
      kind: 'lossless',
      reason:
        'Lossless BY CONSTRUCTION as of WI-36688 (SHIPPED — this reason has now been wrong in ' +
        'both directions, so read the ordering off the code, not off any prose: WI-36683 ' +
        'corrected a false re-delivery claim, then this entry went stale the other way by still ' +
        'describing the pre-WI-36688 order and calling the fix pending). The CURRENT order is: ' +
        'fit FIRST (ambient-push-delivery.ts fitPushesToBudget), record ONLY the fitting set ' +
        'delivered (recordDelivered), THEN render and pass the door. A push is delivered iff its ' +
        'WHOLE teaser line is in the block; one that did not fit gets NEITHER recordDelivered nor ' +
        'recordDropped, so it stays `queued` and is genuinely reconsidered next pass. The ' +
        'exemption no longer rests on a margin: fitPushesToBudget composes header + n + Σ(line ' +
        'lengths), byte-identical to renderPushBlock, and sizes against the SAME ' +
        'pushInjectionDoorTokens × CHARS_PER_TOKEN_ESTIMATE the door itself uses — so the ' +
        'rendered block cannot exceed the door and capInjectionText returns it untouched. The ' +
        'only cuttable tail is the appended peer-brief region, which is ' +
        'PAPERCUSP_AMBIENT_CURSOR-gated (default off) and re-pullable from the teaser handle; a ' +
        'head-keep cut there cannot reach back into the teaser lines, which sit entirely within ' +
        'the budget. Pinned by ambient-push-delivery.test.ts "a push selectPushes admits but the ' +
        'injection door can\'t hold is left QUEUED, not delivered or dropped (WI-36688)", which ' +
        'asserts block.length <= the real door AND that the overflow ids got neither store call. ' +
        'If THAT reds, this entry is no longer true and the door needs a marker.',
    },
  },
];

const BY_ID = new Map(DOORS.map((d) => [d.id, d]));
const BY_MODULE = new Map(DOORS.map((d) => [d.module, d]));

/**
 * Files that contain the patterns as DATA rather than as behaviour: the
 * scanner's own regexes and this guard's own registry. Excluded by exact path —
 * never by a glob that could swallow a real door.
 */
const SELF_EXCLUDED = new Set([
  'packages/operator-core/lib/truncation-honesty-scan.ts',
  'packages/operator-core/lib/truncation-honesty-guard.test.ts',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Tree scan
// ─────────────────────────────────────────────────────────────────────────────

function scanTree(): { sites: DoorSite[]; unscanned: string[] } {
  const listed = listFilesIncludingUntracked(REPO_ROOT) as {
    files: string[];
    unscanned: string[];
  };
  const sites: DoorSite[] = [];
  for (const rel of listed.files) {
    if (!rel.endsWith('.ts') && !rel.endsWith('.mts')) continue;
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.mts') || rel.endsWith('.d.ts')) continue;
    if (rel.includes('/_retired/') || rel.startsWith('_retired/')) continue;
    if (rel.includes('node_modules/') || rel.includes('/dist/')) continue;
    if (SELF_EXCLUDED.has(rel)) continue;
    let src: string;
    try {
      src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    } catch {
      continue; // a listed-but-unreadable path is not a door
    }
    // Cheap pre-filter: skip the ~99% of files that mention neither idiom.
    if (!src.includes('capInjectionText') && !src.includes('-door:')) continue;
    sites.push(...scanSource(rel, src));
  }
  return { sites, unscanned: listed.unscanned ?? [] };
}

let SCAN: { sites: DoorSite[]; unscanned: string[] };
function sites(): DoorSite[] {
  SCAN ??= scanTree();
  return SCAN.sites;
}

describe('truncation honesty — every door is registered with an explicit disposition', () => {
  it('states its scan coverage rather than implying a bare ✓', () => {
    SCAN ??= scanTree();
    // Not an assertion about doors — an assertion that the guard says what it
    // could NOT check, so its green is never read as broader than it is.
    // eslint-disable-next-line no-console
    console.log(`[truncation-honesty] ${describeUnscanned(SCAN.unscanned, REPO_ROOT)}`);
    expect(Array.isArray(SCAN.unscanned)).toBe(true);
  });

  it('finds the doors it already knows about (the detector is not blind)', () => {
    const found = sites();
    // If this fails, the detector stopped matching — every other assertion in
    // this file would then pass vacuously.
    // The result door stopped calling the character-slicing primitive when
    // EI-20435986111760474 made every overflow structurally projected, and the
    // injection door stopped slicing when P-024 clause D made it pack whole
    // sections (review-system-rework-reduction-2026-09-23). The ambient-push door
    // is the one remaining capInjectionText caller; pin it by FILE so the
    // calibration cannot pass on some other, unrelated call site. The result door
    // is still covered independently by its runtime `_meta.resultDoor` assertion.
    expect(
      found.filter((s) => s.kind === 'cap-call' && s.file === 'packages/operator-core/lib/ambient-push-delivery.ts')
        .length,
    ).toBeGreaterThanOrEqual(1);
    // Result overflows are now a single parseable JSON value with
    // `_projection` plus `_meta.resultDoor`, never a prose footer appended to a
    // sliced value. The runtime marker assertion below calibrates that arm.
    expect(
      found.filter((s) => s.kind === 'footer-emit' && s.doorName === 'result-door').length,
    ).toBe(0);
    expect(
      found.filter((s) => s.kind === 'footer-emit' && s.doorName === 'injection-door').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('every capInjectionText call site belongs to a registered door module', () => {
    const unregistered = sites()
      .filter((s) => s.kind === 'cap-call' && !BY_MODULE.has(s.file))
      .map((s) => `${s.file}:${s.line}  ${s.text}`);
    expect(
      unregistered,
      'A new truncation door cuts text here but is not in DOORS. Stamp a structured marker on ' +
        'the result and register it as `structured`, or register it as `prose-only`/`lossless` ' +
        'WITH a reason. See the header of this file.',
    ).toEqual([]);
  });

  it('every emitted [<name>-door: …] footer names a registered door, from its own module', () => {
    const problems = sites()
      .filter((s) => s.kind === 'footer-emit')
      .flatMap((s) => {
        const entry = s.doorName ? BY_ID.get(s.doorName) : undefined;
        if (!entry) return [`${s.file}:${s.line}  emits an unregistered door footer [${s.doorName}: …]`];
        if (entry.module !== s.file) {
          return [
            `${s.file}:${s.line}  emits [${s.doorName}: …] but DOORS says that door lives in ${entry.module}`,
          ];
        }
        return [];
      });
    expect(problems).toEqual([]);
  });

  it('every registered door module exists on disk', () => {
    const missing = DOORS.filter((d) => !existsSync(join(REPO_ROOT, d.module))).map((d) => d.module);
    expect(missing, 'A registered door module was moved or deleted — update DOORS.').toEqual([]);
  });

  it('every `structured` door still stamps its declared marker key', () => {
    const broken: string[] = [];
    for (const d of DOORS) {
      if (d.disposition.kind !== 'structured') continue;
      const src = readFileSync(join(REPO_ROOT, d.module), 'utf8');
      if (!src.includes(d.disposition.markerKey)) {
        broken.push(`${d.id}: ${d.module} no longer mentions '${d.disposition.markerKey}'`);
      }
    }
    expect(
      broken,
      'A door registered as machine-readable lost its marker. Restore it, or change its ' +
        'disposition to prose-only/lossless WITH a reason — do not just delete the entry.',
    ).toEqual([]);
  });

  it('every non-structured door carries a written reason', () => {
    const unreasoned = DOORS.filter(
      (d) => d.disposition.kind !== 'structured' && d.disposition.reason.trim().length < 40,
    ).map((d) => d.id);
    expect(
      unreasoned,
      'A prose-only / lossless door needs a real reason, not a placeholder — the sentence IS the guard.',
    ).toEqual([]);
  });
});

describe('truncation honesty — prose footers that CODE parses are declared both ways', () => {
  it('every regex consuming a door footer is declared on that door', () => {
    const problems = sites()
      .filter((s) => s.kind === 'footer-match')
      .flatMap((s) => {
        const entry = s.doorName ? BY_ID.get(s.doorName) : undefined;
        if (!entry) return [`${s.file}:${s.line}  parses an unregistered door footer [${s.doorName}: …]`];
        if (!(entry.footerConsumers ?? []).includes(s.file)) {
          return [
            `${s.file}:${s.line}  parses the ${s.doorName} footer but is not listed in its ` +
              `footerConsumers. Code that string-matches a footer makes its wording load-bearing — declare it.`,
          ];
        }
        return [];
      });
    expect(problems).toEqual([]);
  });

  it('every declared footerConsumer really still parses that footer', () => {
    const stale: string[] = [];
    for (const d of DOORS) {
      for (const consumer of d.footerConsumers ?? []) {
        const abs = join(REPO_ROOT, consumer);
        const src = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
        if (!src.includes(`\\[${d.id}:`)) {
          stale.push(`${d.id}: ${consumer} no longer parses the footer — drop it from footerConsumers`);
        }
      }
    }
    // A stale declaration is not harmless: it is the reason the next author
    // believes a footer is load-bearing when it is not, and preserves wording
    // nothing reads.
    expect(stale).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The detector's own teeth — fixtures, so a blind scanner cannot pass silently
// ─────────────────────────────────────────────────────────────────────────────

describe('truncation honesty — the detector itself', () => {
  it('catches a new door that calls the shared cutting primitive', () => {
    const hits = scanSource(
      'x.ts',
      ['const { kept } = capInjectionText(text, budget);', 'return kept;'].join('\n'),
    );
    expect(hits).toEqual([
      expect.objectContaining({ kind: 'cap-call', line: 1, doorName: null }),
    ]);
  });

  it('does not mistake the primitive DECLARATION or an import for a door', () => {
    const src = [
      "import { capInjectionText } from './context-doors';",
      'export function capInjectionText(text: string, doorTokens: number) {',
      '  return { kept: text, overflow: null };',
      '}',
    ].join('\n');
    expect(scanSource('context-doors.ts', src)).toEqual([]);
  });

  it('separates an EMITTED footer from a regex that CONSUMES it', () => {
    const src = [
      'const footer = `\\n[widget-door: this was truncated]`;',
      'const STRIP = /\\[widget-door:[\\s\\S]*?\\]/g;',
    ].join('\n');
    const hits = scanSource('x.ts', src);
    expect(hits.map((h) => `${h.kind}:${h.doorName}`)).toEqual([
      'footer-emit:widget-door',
      'footer-match:widget-door',
    ]);
  });

  it('ignores commentary about a door', () => {
    const src = [
      '// see the [result-door: …] footer, which calls capInjectionText(…)',
      ' * the [injection-door: …] footer is stripped later',
      '/** capInjectionText(x, y) is the primitive */',
    ].join('\n');
    expect(scanSource('x.ts', src)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Behavioural leg — the marker is actually STAMPED, not merely mentioned
// ─────────────────────────────────────────────────────────────────────────────

const BUDGET_CHARS = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

describe('truncation honesty — the result door stamps its marker at runtime', () => {
  let sandbox: string;
  let prevScratchRoot: string | undefined;
  let prevKillSwitch: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'papercusp-truncation-honesty-'));
    prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
    prevKillSwitch = process.env.PAPERCUSP_RESULT_DOOR_OFF;
    delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
    doorConstantsMock.mockReset();
    doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
  });

  afterEach(() => {
    if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
    else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
    if (prevKillSwitch === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
    else process.env.PAPERCUSP_RESULT_DOOR_OFF = prevKillSwitch;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('stamps a machine-readable _meta.resultDoor on a truncated result', () => {
    const input: DoorableResult = { content: [{ type: 'text', text: 'x'.repeat(BUDGET_CHARS * 3) }] };
    const out = applyResultDoor(input, { toolName: 'demo:tool', workspaceId: 'ws' });
    const marker = (out._meta as { resultDoor?: Record<string, unknown> } | undefined)?.resultDoor;
    // The point of the whole plan item: a reader learns this from a FIELD, not
    // by string-matching the English footer beside it.
    expect(marker).toBeDefined();
    expect(marker).toMatchObject({ truncated: true });
    expect(typeof marker?.spillPath).toBe('string');
    expect(typeof marker?.originalChars).toBe('number');
    expect(marker?.originalChars as number).toBeGreaterThan(BUDGET_CHARS);
  });

  it('does not stamp the marker on a result that fits (no false truncation signal)', () => {
    const input: DoorableResult = { content: [{ type: 'text', text: 'small' }] };
    const out = applyResultDoor(input, { toolName: 'demo:tool', workspaceId: 'ws' });
    expect((out._meta as { resultDoor?: unknown } | undefined)?.resultDoor).toBeUndefined();
  });
});
