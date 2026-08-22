/**
 * CLAUDE.md's RETIRED-SURFACES claims must actually be retired
 * (EI-19971915610840229; sibling of `executable-claims.test.ts`, same P-004 family).
 *
 * The section is an INSTRUCTION — "Don't write tests for it, wire new code to it, or
 * 'revive' it without an explicit ask" — so a wrong entry suppresses real work on
 * shipping code, and does so silently: a doc that wrongly says LIVE self-corrects the
 * first time someone greps, while one that wrongly says RETIRED emits no error ever.
 * `OperatorChatSidebar` sat wrong for ~1 month exactly that way
 * (EI-19485603307368652).
 *
 * The FIXTURE controls below are the positive controls, and they are load-bearing for
 * the same reason the sibling suite states: once the live doc is correct the live
 * assertions go green and stop being evidence that the detector works at all. The
 * headline control is the VERBATIM pre-fix section recovered from `6e44d56a0b^` — not
 * a reconstruction — so it provably reproduces the defect that actually shipped.
 */
import { describe, it, expect } from 'vitest';
import { FLAG_DEFAULTS, FLAGS } from '@papercusp/flags';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractRetiredSurfaceClaims,
  judgeRetiredSurfaceClaims,
  isRetiredPath,
  type SurfaceClaim,
  type SurfaceResolver,
} from './retired-surfaces';

import { CORPUS_FLOORS, CORPUS_PATH, ROOT, SUBJECT_LABEL, readCorpus } from './corpus-subject';

const SOURCE_EXT = /\.(?:tsx?|jsx?|[cm]js|md|json|sql|rs|sh|css)$/;

/**
 * The repo index, from `git ls-files` (one call, ~10ms for ~21k paths).
 *
 * ⚠ KNOWN BOUND, stated rather than papered over: this is the SUPERPROJECT index, so
 * files inside a submodule (`libs/papercusp/**`) are absent. That is why an
 * unresolvable BARE NAME is skipped rather than failed — see the module docstring.
 * Direct path claims fall back to `existsSync`, which is what lets an untracked but
 * present directory (`libs/holepunch-spike`) still resolve.
 */
function buildResolver(): SurfaceResolver {
  let files: string[] = [];
  try {
    files = execFileSync('git', ['ls-files'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    files = []; // no git here — every claim becomes unresolved, i.e. fail-open
  }

  const byName = new Map<string, string[]>();
  for (const f of files) {
    const base = basename(f);
    for (const key of new Set([base, base.replace(SOURCE_EXT, '')])) {
      byName.set(key, [...(byName.get(key) ?? []), f]);
    }
  }

  return {
    exists: (p) => existsSync(join(ROOT, p)),
    byBasename: (n) => byName.get(n) ?? [],
    bySuffix: (fragment) => files.filter((f) => f === fragment || f.endsWith(`/${fragment}`)),
  };
}

const resolver = buildResolver();
const flagRegistry = { flags: FLAGS, defaults: FLAG_DEFAULTS };
// The CORPUS, not CLAUDE.md. This guard locates its subject BY HEADING and the claims
// beneath it are prose, so the client projection yields 0 judged claims (it still emits
// the heading, because one invariant sits under it). See corpus-subject.ts.
const md = readCorpus();
const extraction = extractRetiredSurfaceClaims(md, resolver);

/**
 * How the doc MEANS each span it names. Supplied, never inferred — the section is
 * dense with deliberate LIVE counter-examples, and a detector that guessed intent
 * from prose proximity would fail hardest on the best-documented entries (the
 * inversion the sibling module measured).
 *
 * ⚠ This table is only safe because of the CLOSURE assertion below: it must exactly
 * cover the judged spans, so an entry added to (or removed from) the doc reds this
 * suite until someone classifies it, instead of going silently unjudged. Do not
 * "fix" a red here by deleting a key — that reintroduces the blind spot the closure
 * check exists to prevent.
 */
const CLASSIFICATION: Record<string, SurfaceClaim> = {
  // ── retired BY RELOCATION — must live under `_retired/` ──
  '_retired/papercup/': 'retired',
  '_retired/snapshot-system/': 'retired',
  '_retired/legacy-web-chats/': 'retired',
  '_retired/harness-dashboard/': 'retired',
  '_retired/inbox-pane/': 'retired',
  '_retired/work-item-mail/': 'retired',
  'InboxPane.tsx': 'retired',
  // The Mug/Kettle left-rail tier. Retired by RELOCATION, not by gate: P-068
  // (`retire-mug-kettle-su-only-2026-08-09`) deleted `MUG_KETTLE_SYSTEM` outright, so
  // the doc no longer describes a flippable flag and this directory is where the
  // panels actually live. The unbackticked roster after this span (MugTab,
  // OverwatchTab, MugHeartbeat, ModelTiersOverride, ThrottleSection,
  // AutonomySurfacing, MugWakeEfficiencyPanel) is checked by extractRoster — each
  // resolves to exactly one path, all under `_retired/`.
  '_retired/mug-kettle-deciders/': 'retired',

  // ── retired IN PLACE — deliberately NOT relocated; existence is all that is
  // decidable here (see SurfaceClaim's HONEST BOUND) ──
  'libs/papercusp-db': 'retired-in-place',
  'libs/holepunch-spike': 'retired-in-place',

  // ── LIVE counter-examples the section names on purpose ──
  // Each is named to say "this is NOT retired, match the surface not the substring".
  OperatorChatSidebar: 'live',
  'apps/operator/app/_components/OperatorChatSidebar.tsx': 'live',
  'ChromeShell.tsx': 'live',
  'ChromeShell.test.tsx': 'live',
  'OperatorChatSidebar.component.test.tsx': 'live',
  'production-defaults.test.ts': 'live',
  'apps/operator/app/harness/': 'live',
  'use-inbox-pending.ts': 'live',
  'agent-tools/coordination/messages.ts': 'live',
  // the guards the section names as the real enforcement — a doc claiming a guard
  // that no longer exists is the defect one level up (the `lint:no-retired` case)
  'scripts/affected-tests.mjs': 'live',
  'packages/operator-core/lib/doc-claims/retired-surfaces.test.ts': 'live',
  '_retired/': 'retired',

  // ── TOMBSTONE — named precisely to say it is gone; must NOT resolve ──
  'libs/zero-harness': 'deleted',
};

// ───────────────────────────── fixture controls ─────────────────────────────

describe('extractRetiredSurfaceClaims — fixture controls', () => {
  const heading = '## Retired / preserved-not-active surfaces\n';

  it('POSITIVE CONTROL: fires on the VERBATIM pre-fix text that shipped the bug', () => {
    // Recovered verbatim from `6e44d56a0b^` (the commit that corrected it). Note
    // `OperatorChatSidebar` carries NO backticks here — which is exactly why the
    // roster leg exists: a backtick-only extractor returns a confident all-clear
    // over the one line that motivated this whole guard.
    const fixture =
      heading +
      'tested, not to be extended. Currently: the legacy web chats\n' +
      '(`_retired/legacy-web-chats/` — OracleDock/OperatorChatSidebar; the pui chat\n' +
      'pane is the only chat surface), and more.\n';

    const got = extractRetiredSurfaceClaims(fixture, resolver);
    const sidebar = got.roster.find((r) => r.name === 'OperatorChatSidebar');
    expect(sidebar).toBeDefined();
    expect(sidebar?.location).toBe('_retired/legacy-web-chats');
    // The claim is false on disk: it lives in the LIVE tree.
    expect(sidebar?.retiredOnDisk).toBe(false);
    expect(sidebar?.resolvesTo).toContain('apps/operator/app/_components/OperatorChatSidebar.tsx');

    const verdict = judgeRetiredSurfaceClaims(got, {
      '_retired/legacy-web-chats/': 'retired',
    });
    expect(verdict.violations.map((v) => v.text)).toContain('OperatorChatSidebar');
  });

  it('POSITIVE CONTROL: fires on a path claim that resolves to NOTHING', () => {
    const fixture = heading + 'Currently: `libs/does-not-exist-anywhere` (migrate off).\n';
    const got = extractRetiredSurfaceClaims(fixture, resolver);
    const verdict = judgeRetiredSurfaceClaims(got, {
      'libs/does-not-exist-anywhere': 'retired',
    });
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0].message).toMatch(/resolves to NOTHING/);
  });

  it('POSITIVE CONTROL: fires when a TOMBSTONE comes back', () => {
    // `libs/zero-harness` is named in the live doc precisely to say it was deleted.
    // If it ever returns, that sentence is false — and the assertion inverts to
    // catch it, which a plain "must exist" rule never could.
    const fixture = heading + 'Note: `libs/holepunch-spike` was deleted long ago.\n';
    const got = extractRetiredSurfaceClaims(fixture, resolver);
    const verdict = judgeRetiredSurfaceClaims(got, { 'libs/holepunch-spike': 'deleted' });
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0].message).toMatch(/tombstone is stale — it came back/);
  });

  it('POSITIVE CONTROL: fires when a LIVE counter-example has quietly been retired', () => {
    const fixture = heading + 'the `InboxPane.tsx` data layer stays live.\n';
    const got = extractRetiredSurfaceClaims(fixture, resolver);
    const verdict = judgeRetiredSurfaceClaims(got, { 'InboxPane.tsx': 'live' });
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0].message).toMatch(/named as a LIVE counter-example/);
  });

  it('POSITIVE CONTROL: fires when a GATED claim names an unregistered flag', () => {
    const fixture =
      heading +
      'The `apps/operator-vite/src/components/left-sidebar/LeftSidebar.tsx` surface is GATED by `MISSING_FLAG`, default OFF.\n';
    const got = extractRetiredSurfaceClaims(fixture, resolver);
    const verdict = judgeRetiredSurfaceClaims(
      got,
      {
        'apps/operator-vite/src/components/left-sidebar/LeftSidebar.tsx': {
          kind: 'gated',
          flagKey: 'MISSING_FLAG',
          defaultValue: false,
        },
      },
      flagRegistry,
    );
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0].message).toMatch(/absent from FLAGS/);
  });

  it('POSITIVE CONTROL: fires when a GATED claim states the wrong default', () => {
    const fixture =
      heading +
      'The `apps/operator-vite/src/components/left-sidebar/LeftSidebar.tsx` surface is GATED by `CONVERSATIONS_RAIL_TAB`, default ON.\n';
    const got = extractRetiredSurfaceClaims(fixture, resolver);
    const verdict = judgeRetiredSurfaceClaims(
      got,
      {
        'apps/operator-vite/src/components/left-sidebar/LeftSidebar.tsx': {
          kind: 'gated',
          flagKey: 'CONVERSATIONS_RAIL_TAB',
          defaultValue: true,
        },
      },
      flagRegistry,
    );
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0].message).toMatch(/FLAG_DEFAULTS resolves it to OFF/);
  });

  it('NEGATIVE CONTROL: accepts a GATED claim when the flag key and default agree', () => {
    const fixture =
      heading +
      'The `apps/operator-vite/src/components/left-sidebar/LeftSidebar.tsx` surface is GATED by `CONVERSATIONS_RAIL_TAB`, default OFF.\n';
    const got = extractRetiredSurfaceClaims(fixture, resolver);
    const verdict = judgeRetiredSurfaceClaims(
      got,
      {
        'apps/operator-vite/src/components/left-sidebar/LeftSidebar.tsx': {
          kind: 'gated',
          flagKey: 'CONVERSATIONS_RAIL_TAB',
          defaultValue: false,
        },
      },
      flagRegistry,
    );
    expect(verdict.violations).toEqual([]);
  });

  it('NEGATIVE CONTROL: stays silent on the section\'s deliberate non-path spans', () => {
    // Every one of these is a real span from the live section that a
    // "judge every backticked thing" detector would have mis-classified.
    const fixture =
      heading +
      'the `coord:*` plane — `coord_event_log`, `coord-inbox-bus` — is fully LIVE;\n' +
      '`messages:send`/`dismiss`/`inbox`/`outbox` + `cross_harness:` analogs;\n' +
      '`FLAGS.OPERATOR_CHAT_SIDEBAR` absent from `KNOWN_DARK_FLAGS`;\n' +
      '`hud-consolidation-2026-07-26` D-001; `/adv`+`/workbench`; `/harness/$slug`;\n' +
      '`libs/papercusp-shared/**/*View.tsx`; `libs/papercusp/_retired/…`\n';
    const got = extractRetiredSurfaceClaims(fixture, resolver);
    expect(got.judged).toEqual([]);
    expect(got.roster).toEqual([]);
    // …and each skip names WHY, so a future reader can tell a deliberate skip from
    // a silent miss.
    expect(new Set(got.skipped.map((s) => s.reason))).toEqual(
      new Set(['not-file-shaped', 'url-route', 'glob', 'placeholder']),
    );
  });

  it('NEGATIVE CONTROL: a roster does not run past its clause boundary', () => {
    // The live `_retired/legacy-web-chats/` entry is followed, one sentence later,
    // by the correction naming OperatorChatSidebar as LIVE. A roster that ran past
    // the period would read that correction as a retirement claim — i.e. fail on
    // the text that FIXED the bug.
    const fixture =
      heading +
      '(`_retired/legacy-web-chats/` — OracleDock + TutorialButton **only**. ⚠ This\n' +
      'entry used to also name `OperatorChatSidebar`, which is LIVE.)\n';
    const got = extractRetiredSurfaceClaims(fixture, resolver);
    expect(got.roster.map((r) => r.name).sort()).toEqual(['OracleDock', 'TutorialButton']);
    expect(got.roster.every((r) => r.retiredOnDisk)).toBe(true);
  });

  it('reports sectionFound:false rather than passing vacuously when the heading is gone', () => {
    const got = extractRetiredSurfaceClaims('## Something Else\n`_retired/papercup/`\n', resolver);
    expect(got.sectionFound).toBe(false);
    expect(got.judged).toEqual([]);
    expect(got.roster).toEqual([]);
  });

  it('isRetiredPath keys on a path SEGMENT, never a substring', () => {
    expect(isRetiredPath('_retired/papercup/app/page.tsx')).toBe(true);
    expect(isRetiredPath('libs/papercusp/_retired/apps-web/x.ts')).toBe(true);
    // the trap this repo names explicitly: match the surface, not the substring
    expect(isRetiredPath('apps/operator/app/_retirement-notice.tsx')).toBe(false);
    expect(isRetiredPath('apps/operator/app/_components/ChromeShell.tsx')).toBe(false);
  });
});

// ─────────────────────── live assertions over CLAUDE.md ──────────────────────

describe('the doc corpus — retired-surface claims hold', () => {
  it('has a retired-surfaces section with claims to check', () => {
    expect(existsSync(CORPUS_PATH)).toBe(true);
    // `sectionFound` alone is NOT non-vacuity, and this is the trap worth naming: the
    // projected client file still reports sectionFound TRUE (one invariant sits under
    // the heading, so the heading is emitted) while judging ZERO claims — the most
    // reassuring possible shape for a guard measuring nothing. The count is the check.
    expect(extraction.sectionFound).toBe(true);
    expect(extraction.judged.length).toBeGreaterThanOrEqual(CORPUS_FLOORS.retiredSurfacesJudged);
    expect(extraction.roster.length).toBeGreaterThan(0);
  });

  it('every surface it lists as RETIRED is actually retired on disk', () => {
    const verdict = judgeRetiredSurfaceClaims(extraction, CLASSIFICATION, flagRegistry);
    expect(verdict.violations.map((v) => `${SUBJECT_LABEL}:${v.line} — ${v.message}`)).toEqual([]);
  });

  it('CLOSURE: every judged span is classified, and every classification is still used', () => {
    const verdict = judgeRetiredSurfaceClaims(extraction, CLASSIFICATION, flagRegistry);
    expect(
      verdict.unclassified.map(
        (s) =>
          `${SUBJECT_LABEL}:${s.line} — \`${s.text}\` is named in the retired-surfaces section ` +
          `but CLASSIFICATION does not say whether the doc means it as 'retired' or ` +
          `'live'. Add it (resolves to: ${s.resolvesTo.join(', ') || 'NOTHING'}).`,
      ),
    ).toEqual([]);
    expect(
      verdict.stale.map(
        (k) => `CLASSIFICATION has \`${k}\`, which the doc no longer names — drop the key.`,
      ),
    ).toEqual([]);
  });
});
