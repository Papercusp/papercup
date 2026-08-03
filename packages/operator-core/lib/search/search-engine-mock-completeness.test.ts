/**
 * RECURRENCE GUARD — an inline `vi.mock` of an engine this repo CONFIGURES AT
 * MODULE LOAD must stay LOAD-COMPLETE (EI-19466189284256419).
 *
 * WHY THIS EXISTS. Three modules here install a policy into a `@papercusp/*`
 * engine by CALLING it at module load (the P-017 self-install idiom), and each
 * is reached by a side-effect import rather than a boot hook:
 *
 *   lib/search/configure-search-defaults.ts -> configureSearchDefaults
 *   lib/lexicon/configure.ts                -> configureLexicon
 *   lib/memory/configure.ts                 -> configureMemory
 *
 * That design is deliberate and good — coverage is structural instead of
 * something every entry point must remember. But it has one sharp edge in
 * tests: an INLINE `vi.mock` factory replaces the engine WHOLESALE, so a mock
 * omitting the installed export does not fail an assertion — it fails
 * COLLECTION, before a single test runs. And a collection crash fails the whole
 * workspace task, taking unrelated sibling files down with it.
 *
 * That is precisely what red-pinned the fleet gate on 2026-08-03: verdict
 * 20:33:50Z (candidate 8564677998c4) reported THREE failing files, of which
 * only `lib/agent-tools/sessions/search.test.ts` was genuinely broken — the
 * other two passed in isolation. The class is disproportionate twice over: a
 * one-word omission stops the fleet, and the failing-file list it produces
 * points mostly at innocent files, so triage starts in the wrong place.
 *
 * THE INVARIANT. An inline-factory mock of one of these engines must declare
 * the export its policy module installs. A factory that spreads
 * `importOriginal()` is EXEMPT — it carries every export by construction, which
 * is why `agent-tools/__tests__/search-tools.test.ts` survived the incident
 * untouched and is the idiom to prefer for a partial mock.
 *
 * CALIBRATION over derivation. The installed export is declared in the table
 * below rather than inferred, because the real call is often INDIRECT (search
 * calls a local `installSearchDefaults()` at top level, which calls the engine
 * inside) and any inference cheap enough to trust here would either miss that
 * or over-constrain future mocks with every unrelated import. Instead each row
 * is CALIBRATED against its policy module: the guard fails loudly if the
 * binding stops being a value import, or the module-load-time call disappears.
 * A silently-vacuous guard is the failure mode this replaces.
 *
 * FALSIFIABILITY. The scanned root is env-overridable
 * (`PROBE_SEARCH_MOCK_LIB_ROOT`) so this guard can be proven to fail against a
 * crafted offender in a COPY outside the tree — never by mutating the shared
 * checkout, which git-sync would happily commit.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const LIB_ROOT = process.env.PROBE_SEARCH_MOCK_LIB_ROOT ?? path.resolve(HERE, '..');

interface PolicyBinding {
  /** Policy module, relative to lib/, that self-installs at module load. */
  policy: string;
  /** The engine package it configures. */
  engine: string;
  /** The export it installs — what an inline mock of `engine` must declare. */
  installs: string;
}

/**
 * Adding a new module-load-time self-install? Add a row here. The calibration
 * test below will tell you immediately if the row does not describe reality.
 */
const POLICY_BINDINGS: PolicyBinding[] = [
  {
    policy: 'search/configure-search-defaults.ts',
    engine: '@papercusp/search',
    installs: 'configureSearchDefaults',
  },
  { policy: 'lexicon/configure.ts', engine: '@papercusp/lexicon', installs: 'configureLexicon' },
  { policy: 'memory/configure.ts', engine: '@papercusp/memory', installs: 'configureMemory' },
];

/**
 * Comments are stripped BEFORE scanning, not just inside a matched factory.
 *
 * Both directions matter, and the second is the one that bit: a MENTION of an
 * export must never satisfy the check, and a `vi.mock(...)` written in PROSE —
 * this file's own docblock, or a commented-out mock — must never be scanned as
 * if it were code. Omitting the second made this guard fail on its own
 * documentation the first time it ran.
 *
 * The `[^:]` guard keeps a `https://` inside a string literal from being eaten,
 * which would unbalance the paren scan below.
 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Is `name` imported as a VALUE (not `type`) from `engine` in `src`? */
function valueImports(src: string, engine: string, name: string): boolean {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${engine.replace('/', '\\/')}['"]`);
  const m = src.match(re);
  if (!m) return false;
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('type '))
    .map((s) => s.split(/\s+as\s+/)[0].trim())
    .includes(name);
}

/** A call expression at column 0 — i.e. executed on import, not inside a fn. */
function hasModuleLoadCall(src: string): boolean {
  return /^[A-Za-z_$][\w$]*\s*\(/m.test(src);
}

function walkTests(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTests(p, out);
    else if (/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Slice the balanced `(...)` of the vi.mock call starting at `openIdx`. */
function callArgs(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return src.slice(openIdx);
}

function declaresKey(factory: string, name: string): boolean {
  return new RegExp(`(^|[{,\\s])${name}\\s*(:|,|\\})`).test(factory);
}

interface Offender {
  file: string;
  engine: string;
  missing: string;
}

function scan(): Offender[] {
  const offenders: Offender[] = [];
  const byEngine = new Map(POLICY_BINDINGS.map((b) => [b.engine, b.installs]));

  for (const file of walkTests(LIB_ROOT)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const re = /vi\.(?:do)?mock\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const openIdx = src.indexOf('(', m.index);
      if (openIdx < 0) continue;
      const args = callArgs(src, openIdx);
      const target = args.match(/^\s*['"]([^'"]+)['"]\s*,/);
      if (!target) continue; // no factory supplied — nothing to be incomplete
      const installs = byEngine.get(target[1]);
      if (!installs) continue;
      // A spread of the real module carries every export by construction.
      if (args.includes('importOriginal')) continue;
      if (!declaresKey(args, installs)) {
        offenders.push({ file: path.relative(LIB_ROOT, file), engine: target[1], missing: installs });
      }
    }
  }
  return offenders;
}

describe('inline mocks of self-installed engines stay load-complete', () => {
  // CALIBRATION: each row must still describe a real module-load-time install.
  // Without this, a renamed export or a policy module that stopped
  // self-installing would leave the scan below passing vacuously.
  it.each(POLICY_BINDINGS)('$policy still installs $installs at module load', (binding) => {
    const src = stripComments(readFileSync(path.join(LIB_ROOT, binding.policy), 'utf8'));
    expect(
      valueImports(src, binding.engine, binding.installs),
      `${binding.policy} no longer value-imports ${binding.installs} from ${binding.engine} — ` +
        `update POLICY_BINDINGS, or this guard silently stops covering that engine.`,
    ).toBe(true);
    expect(
      hasModuleLoadCall(src),
      `${binding.policy} has no module-load-time call — if the self-install was ` +
        `removed, drop its row from POLICY_BINDINGS.`,
    ).toBe(true);
  });

  it('every inline-factory mock declares the installed export', () => {
    const offenders = scan();
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `These mocks replace an engine wholesale but omit the export its policy ` +
          `module calls at module load, so the file fails COLLECTION (and takes its ` +
          `whole workspace task down with it):\n` +
          offenders
            .map((o) => `  ${o.file} — mocking ${o.engine}, missing: ${o.missing}`)
            .join('\n') +
          `\nFix: add \`<name>: vi.fn()\` to the factory, or spread ` +
          `\`importOriginal()\` to carry every export by construction.`,
    ).toEqual([]);
  });
});
