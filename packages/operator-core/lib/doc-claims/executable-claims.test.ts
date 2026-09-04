/**
 * CLAUDE.md's executable claims must actually be executable
 * (false-premise-in-prescriptive-artifacts-2026-08-02 P-004).
 *
 * Two assertions over the real repo-root CLAUDE.md:
 *   (a) every `npm run X` it names resolves to a script that EXISTS;
 *   (b) every command it PRESCRIBES is admitted by the heavy-command admission
 *       gate — i.e. the doc never mandates a command the system refuses.
 *
 * (b) consults the REAL hook as an oracle rather than reimplementing its
 * predicate. That is the point: a second copy of the gate's regex in TypeScript
 * would drift from the gate itself, and a doc-check that is wrong about the gate
 * is exactly the false-premise class this plan exists to remove. `PC_HEAVY_
 * LOAD1_OVERRIDE` makes the answer deterministic — without it this suite would
 * pass on an idle box and fail under load, which is the same defect wearing a
 * different hat.
 *
 * The FIXTURE tests below are the positive controls, and they are load-bearing:
 * once CLAUDE.md is fixed the live assertions go green and stop being evidence
 * that the detector works at all. The fixtures keep proving it fires — and, just
 * as importantly, that it stays silent on the doc's deliberate counter-examples.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractExecutableClaims } from './executable-claims';
import { CORPUS_FLOORS, CORPUS_PATH, ROOT, SUBJECT_LABEL, readCorpus } from './corpus-subject';

const HOOK = join(ROOT, 'apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh');

// The CORPUS, not CLAUDE.md: the client projection carries only the projected minority,
// so it names ~half the `npm run` scripts and prescribes fewer commands. A claim that
// moved into prose is still a claim agents are told to run. See corpus-subject.ts.
const md = readCorpus();
const claims = extractExecutableClaims(md);

// ───────────────────────── the admission-gate oracle ─────────────────────────

type Verdict = 'allow' | 'deny' | 'unavailable';

/** Every script name declared by any package.json in the tree. */
function allScriptNames(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === '_retired') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'package.json') {
        try {
          const pkg = JSON.parse(readFileSync(p, 'utf8')) as { scripts?: Record<string, string> };
          for (const s of Object.keys(pkg.scripts ?? {})) {
            out.set(s, [...(out.get(s) ?? []), p]);
          }
        } catch {
          /* an unparseable package.json is not this suite's business */
        }
      }
    }
  };
  walk(ROOT, 0);
  return out;
}

let gateHome = '';
function ensureGateHome(): string {
  if (gateHome) return gateHome;
  gateHome = mkdtempSync(join(tmpdir(), 'p004-gate-home-'));
  mkdirSync(join(gateHome, '.papercusp'), { recursive: true });
  writeFileSync(join(gateHome, '.papercusp', 'superuser-token'), 'test-token\n');
  writeFileSync(join(gateHome, '.papercusp', 'su-agent-id'), 'test-agent\n');
  return gateHome;
}

let sidSeq = 0;

/**
 * Ask the real PreToolUse hook whether it would admit `command` under load.
 *
 * Returns 'unavailable' — never a failure — when the hook cannot be consulted.
 * A missing hook must not manufacture a doc verdict it has no evidence for
 * (D-001 constraint 2).
 */
function askAdmissionGate(command: string): Verdict {
  if (!existsSync(HOOK)) return 'unavailable';
  const payload = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    // Advisories are say-once per session key; a fresh id per probe keeps each
    // verdict independent of probe order.
    session_id: `p004-${process.pid}-${++sidSeq}`,
  });
  const res = spawnSync('bash', [HOOK], {
    input: payload,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: ensureGateHome(),
      // Only agent / shared-tree sessions are throttled at all.
      PAPERCUSP_AGENT_SESSION: '1',
      // Determinism: assert the LOADED-BOX behaviour regardless of this box's load.
      PC_HEAVY_LOAD1_OVERRIDE: '9999',
      // A dead port: any accidental resource-gate round-trip fails open fast
      // instead of touching the live operator.
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9',
      PAPERCUSP_ADVISORY_LEDGER: '0',
    },
  });
  if (res.error || res.status !== 0) return 'unavailable';
  const raw = (res.stdout ?? '').trim();
  if (!raw) return 'allow'; // silence IS allow
  try {
    const decision = (JSON.parse(raw) as {
      hookSpecificOutput?: { permissionDecision?: string };
    }).hookSpecificOutput?.permissionDecision;
    return decision === 'deny' ? 'deny' : 'allow';
  } catch {
    return 'allow'; // an unparseable payload is not a deny
  }
}

/** The remedies the gate itself accepts, quoted so a failure names the real key. */
const REMEDY =
  'Rewrite it as one of the forms the gate admits: a root entrypoint ' +
  '(`npm run test:file -- <paths>`, `npm run test:affected`, `npm run lint:tsc -- --files=…`), ' +
  'or wrap it: `bash scripts/pc-heavy.sh -- <your command>`.';

// ───────────────────────────── fixture controls ─────────────────────────────

describe('extractExecutableClaims — prescription detection', () => {
  it('POSITIVE CONTROL: fires on the known-bad mandated command (EI-19364889235428417)', () => {
    // Verbatim shape of the CLAUDE.md line that motivated this suite. Kept as a
    // fixture so this stays proven after the live doc is corrected.
    const fixture =
      '5. **Run** `cd packages/operator-core && npx vitest run tools-md-sync` — green\n' +
      '   before commit.\n';
    const got = extractExecutableClaims(fixture);
    expect(got.prescribed).toHaveLength(1);
    expect(got.prescribed[0].site).toBe('imperative:run');
    expect(got.prescribed[0].command).toBe('cd packages/operator-core && npx vitest run tools-md-sync');
    // and the oracle must actually refuse it, or this suite proves nothing
    expect(askAdmissionGate(got.prescribed[0].command)).toBe('deny');
  });

  it('NEGATIVE CONTROL: stays silent on the doc\'s deliberate counter-examples', () => {
    // Every line here is a real shape from CLAUDE.md that a negation-cue
    // detector mis-classified as PRESCRIBED during development.
    const fixture = [
      '| you want | use | not |',
      '| --- | --- | --- |',
      '| run exact tests | `npm run test:file -- <paths>` | `npx vitest run <path>` |',
      '',
      'on 2026-06-21 a `git reset --hard HEAD` (an agent "cleaning the tree") discarded work.',
      '',
      'read `git.pipelinePosition` and `git.mainBehindStaging` from the cell registry.',
      '',
      'a bare `npm install` rewrites `node_modules/.bin` under every other agent.',
      '',
      'the first symptom is `vitest: not found`, which names no cause.',
      '',
      '```',
      "git log --oneline -1 -S backingTables -- \"$F\"        -> bd5ba29a9b : NOT-IN  <- FALSE NEGATIVE",
      '```',
    ].join('\n');
    const got = extractExecutableClaims(fixture);
    expect(got.prescribed.map((p) => p.command)).toEqual([]);
  });

  it('reads the prescribed column of a `| use | not |` table, never the "not" column', () => {
    const fixture = [
      '| you want | use | not |',
      '| --- | --- | --- |',
      '| install deps | `npm run install:safe` | `npm ci --force` |',
    ].join('\n');
    const got = extractExecutableClaims(fixture);
    expect(got.prescribed.map((p) => p.command)).toEqual(['npm run install:safe']);
  });

  it('skips a command carrying a metavariable rather than judging it', () => {
    const got = extractExecutableClaims('```bash\nnpm run lint:tsc -- --files=<the files you edited>\n```');
    expect(got.prescribed).toEqual([]);
    expect(got.skipped.map((s) => s.reason)).toEqual(['placeholder']);
  });

  it('POSITIVE CONTROL: catches the su prompt\'s historical declarative known-bad line (WI-7300)', () => {
    // Verbatim shape from apps/operator/prompts/pot-instances/papercup-pot.su.md
    // BEFORE EI-19389924161930888 was fixed. It is a REAL instance of this defect
    // (`npm run build` is refused by the same gate) that the original three sites
    // could not see: no imperative precedes the span, no fence, no table — the
    // bolded bullet lead-in IS the imperative, and the command follows
    // declaratively. This test is the acceptance criterion for the declarative
    // sites: the extended extractor must catch the line that motivated them.
    const fixture =
      "- **Write/update docs:** docs don't hot-reload — `cd apps/operator-docs && npm run build` regenerates the served mirror.\n";
    const got = extractExecutableClaims(fixture);
    expect(got.prescribed).toHaveLength(1);
    expect(got.prescribed[0].site).toBe('bullet:lead');
    expect(got.prescribed[0].command).toBe('cd apps/operator-docs && npm run build');
    expect(got.npmRun.map((n) => n.script)).toEqual(['build']);
    // and the oracle must actually refuse it, or the catch proves nothing: this
    // guard would have gone RED on the line, which is the whole point.
    expect(askAdmissionGate(got.prescribed[0].command)).toBe('deny');
  });

  it('a bullet prescribes its FIRST invocation only — the form it steers you AWAY from is not a claim', () => {
    // The su prompt's line as it reads AFTER the fix. One bullet carries both the
    // prescription and the proscription, so a bullet site that took every span
    // would prescribe `npm run build` — the exact command the fix removed — and
    // red the fleet gate on a corrected doc. Measured on the live file: 1
    // prescription, and it is the right one.
    const fixture =
      '- **Write/update docs:** docs don\'t hot-reload — **`npm run docs:rebuild`** (root entrypoint) ' +
      'regenerates the served mirror. Use this, never a raw `cd apps/operator-docs && npm run build` — ' +
      'the heavy-command admission gate DENIES a bare `npm run build` under fleet load.\n';
    const got = extractExecutableClaims(fixture);
    expect(got.prescribed).toHaveLength(1);
    expect(got.prescribed[0].command).toBe('npm run docs:rebuild');
    // the bold-wrapped span reports the emphasis site; either declarative site
    // would have been correct here, and only the FIRST span is claimed at all.
    expect(got.prescribed[0].site).toBe('emphasis:bold');
    // the gate admits the prescribed form, and still refuses the proscribed one —
    // so the single claim is also the CORRECT one to have made.
    expect(askAdmissionGate('npm run docs:rebuild')).toBe('allow');
    expect(askAdmissionGate('cd apps/operator-docs && npm run build')).toBe('deny');
  });

  it('a PROSCRIPTIVE bullet lead-in prescribes nothing', () => {
    // The one place a negation cue carries real signal: the bold lead-in is the
    // bullet's declared subject, not an incidental "not" in dense prose.
    const fixture = [
      "- **Never kill by name or pattern:** `pkill -f papercusp-desktop` has twice killed the owner's window.",
      "- **⛔ Do not run this:** `git reset --hard HEAD` discards every peer's uncommitted work.",
    ].join('\n');
    expect(extractExecutableClaims(fixture).prescribed).toEqual([]);
  });

  it('the declarative sites decline inside a routing table — the "not" column stays unprescribed', () => {
    // Emphasis is used on both sides of a `| use | not |` row, so without the
    // table guard the emphasis leg would reach in and prescribe the wrong column.
    const fixture = [
      '| you want | use | not |',
      '| --- | --- | --- |',
      '| install deps | **`npm run install:safe`** | **`npm ci --force`** |',
    ].join('\n');
    const got = extractExecutableClaims(fixture);
    expect(got.prescribed.map((p) => `${p.site}:${p.command}`)).toEqual([
      'table:use:npm run install:safe',
    ]);
  });

  it('REJECTED CANDIDATE: an effect verb after a span is NOT a prescription site', () => {
    // Measured on the corpus during WI-7300: keying on a third-person effect verb
    // ("`cmd` regenerates/prints/…") DOES catch the known-bad line, but at roughly
    // half precision — it fires on these two anti-pattern EXHIBITS, which is the
    // inversion the site whitelist exists to prevent. Pinned so the verb leg
    // cannot be re-added without a measurement that contradicts this one.
    const fixture = [
      "`pgrep -qf X && echo ALIVE || echo gone` prints **`gone`** on the usage error.",
      '',
      'a bare `npm install` prints "up to date" while rewriting `node_modules/.bin`.',
      '',
      '`git status --porcelain papercusp-desktop/src` prints NOTHING whether the file is committed or not.',
    ].join('\n');
    expect(extractExecutableClaims(fixture).prescribed).toEqual([]);
  });

  it('KNOWN LIMIT: a bare declarative span with no lead-in, emphasis, fence or table is still unsupported', () => {
    // The declarative sites cover the voice as this repo's prompt artifacts
    // actually write it. An un-emphasised command in running prose remains
    // invisible, and a `prescribed.length === 0` result on a non-trivial doc
    // still means "the voice is unsupported", never "the doc is clean".
    const fixture =
      "Docs don't hot-reload; `cd apps/operator-docs && npm run build` regenerates the served mirror.\n";
    const got = extractExecutableClaims(fixture);
    expect(got.prescribed).toEqual([]);
    // …while the npm-run leg, which keys on command text alone, travels fine.
    expect(got.npmRun.map((n) => n.script)).toEqual(['build']);
  });

  it('collects npm-run mentions from BOTH columns — a missing script is a defect either way', () => {
    const fixture = [
      '| you want | use | not |',
      '| --- | --- | --- |',
      '| a | `npm run real:one` | `npm run real:two` |',
      '',
      'also `npm --prefix apps/operator run lint:tests` and `cd papercusp-desktop && npm run dev`.',
    ].join('\n');
    const got = extractExecutableClaims(fixture);
    expect(got.npmRun.map((n) => n.script).sort()).toEqual(
      ['dev', 'lint:tests', 'real:one', 'real:two'],
    );
    expect(got.npmRun.find((n) => n.script === 'lint:tests')?.explicitDir).toBe('apps/operator');
    expect(got.npmRun.find((n) => n.script === 'dev')?.explicitDir).toBe('papercusp-desktop');
  });

  it('skips flags between `run` and the script — a flag is never a script name', () => {
    // Held the green gate red (#96) on candidate 43f55c09: the corpus documents
    // `npm --prefix papercusp-desktop run --silent test` — correct npm, and itself the
    // sanctioned invocation for the one app-dir that is deliberately NOT a root workspace
    // (EI-22152426246970496). The old class `[A-Za-z0-9:_-]+` admits a leading `-`, so it
    // bound `--silent` as the script and the guard reported "names no such script" against
    // a true line. A guard whose false positives cost a fleet-wide red trains readers to
    // silence it, which is the failure this whole file exists to prevent.
    const got = extractExecutableClaims(
      'The command field already handles it (`npm --prefix papercusp-desktop run --silent test`).\n',
    );
    expect(got.npmRun.map((n) => n.script)).toEqual(['test']);
    expect(got.npmRun[0]!.explicitDir).toBe('papercusp-desktop');

    // NEGATIVE CONTROL — the un-flagged form must parse identically, so the skip cannot
    // quietly swallow a real script name along with the flags.
    expect(
      extractExecutableClaims('`npm --prefix papercusp-desktop run test`').npmRun.map(
        (n) => n.script,
      ),
    ).toEqual(['test']);

    // Flags npm actually accepts, including digits and `=value`, resolve to the SCRIPT.
    expect(
      extractExecutableClaims('`npm run --loglevel=warn --if-present build`').npmRun.map(
        (n) => n.script,
      ),
    ).toEqual(['build']);

    // THE BACKSTOP, pinned as a deliberate trade rather than left to chance: a flag can
    // never be bound AS a script name (the false-positive direction that reds the fleet).
    // The cost is that an unanticipated flag shape drops the mention entirely — recorded
    // here so a later reader sees the trade instead of rediscovering it as a mystery.
    const exotic = extractExecutableClaims('`npm run --2weird build`').npmRun.map((n) => n.script);
    expect(exotic).not.toContain('--2weird');
    expect(exotic).toEqual([]);
  });
});

// ──────────────────────── live assertions over CLAUDE.md ────────────────────

describe('the doc corpus — executable claims hold', () => {
  it('has a corpus to check, and it is the WHOLE corpus', () => {
    expect(existsSync(CORPUS_PATH)).toBe(true);
    // Floors, not just >0: a subject swapped for the projected client file would still
    // clear >0 (it names 21 scripts and 9 prescriptions) while judging half the corpus.
    // >0 catches an EMPTY read; these catch a SHRUNKEN one, which is the likelier bug.
    expect(claims.npmRun.length).toBeGreaterThanOrEqual(CORPUS_FLOORS.npmRun);
    expect(claims.prescribed.length).toBeGreaterThanOrEqual(CORPUS_FLOORS.prescribed);
  });

  it('(a) every `npm run <script>` it names resolves to a real script', () => {
    const known = allScriptNames();
    const missing = claims.npmRun.filter((m) => {
      if (m.explicitDir) {
        // An explicitly named directory is checkable exactly.
        const pkgPath = join(ROOT, m.explicitDir, 'package.json');
        if (!existsSync(pkgPath)) return false; // not a package dir — not our claim to judge
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
          return !(m.script in (pkg.scripts ?? {}));
        } catch {
          return false;
        }
      }
      // No explicit dir: the owning package is established by surrounding prose,
      // so the honest assertion is only that the script EXISTS SOMEWHERE. Naming
      // the repo root here reports 6 false positives on the current file
      // (`npm run dev` is papercusp-desktop's, not the root's).
      return !known.has(m.script);
    });
    expect(
      missing.map((m) => `${SUBJECT_LABEL}:${m.line} — \`npm run ${m.script}\`${m.explicitDir ? ` in ${m.explicitDir}` : ''} names no such script`),
    ).toEqual([]);
  });

  it('(b) every command it PRESCRIBES is admitted by the heavy-command gate under load', () => {
    if (askAdmissionGate('git status') === 'unavailable') {
      // Hook not installed / not runnable here — assert nothing rather than
      // fabricate a verdict.
      expect(true).toBe(true);
      return;
    }
    const denied = claims.prescribed.filter((p) => askAdmissionGate(p.command) === 'deny');
    expect(
      denied.map((d) => `${SUBJECT_LABEL}:${d.line} [${d.site}] prescribes \`${d.command}\`, which the heavy-command admission gate REFUSES under fleet load. ${REMEDY}`),
    ).toEqual([]);
  }, 120_000);
});
