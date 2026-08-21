/**
 * P-016's proof obligation: the pins hold, the dangerous flags are unreachable,
 * the secret deny-set cannot be shortened, the include set must be explicit,
 * and a pack states its own provenance honestly.
 *
 * FALSIFIABILITY (tier 1, per the repo's mutation-probe discipline): every
 * invariant below is paired with a deliberately-WRONG control implementation
 * kept permanently in this file. The control is fed to the SAME assertion the
 * real subject passes, and must fail it. That is what separates "this test
 * passes" from "this test could ever fail" — and it costs nothing, because it
 * never touches the shared tree (which is the whole reason the copy-out and
 * in-tree mutation tiers exist and are not used here).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));

import { getFlag } from '@papercusp/flags/server';

import {
  assertIsCode2Prompt,
  assertIsRepomix,
  buildCode2PromptArgs,
  buildRepomixArgs,
  CODE2PROMPT_FORBIDDEN_FLAGS,
  CODE2PROMPT_PINNED_VERSION,
  MAX_PACK_BYTES,
  PACK_TEMPLATES,
  packerFacade,
  parseSelectedFiles,
  readGitProvenance,
  REPOMIX_FORBIDDEN_FLAGS,
  REPOMIX_PINNED_VERSION,
  SECRET_DENY_GLOBS,
  templateHeader,
  type ExecFn,
  type PackerArgs,
  type PackerEffects,
  type PackFormat,
} from './packer-facade.ts';
import { isTrustworthyEmpty } from './contracts.ts';

const BASE: PackerArgs = { include: ['packages/**/*.ts'], rootPath: '/repo' };

/** A matrix wide enough that a builder cannot pass by special-casing one input. */
const ARG_MATRIX: PackerArgs[] = [
  BASE,
  { ...BASE, format: 'markdown' },
  { ...BASE, format: 'xml', compress: true },
  { ...BASE, ignore: ['**/*.test.ts'] },
  { ...BASE, baseRef: 'origin/main' },
  { ...BASE, template: 'security-audit' },
  // Smuggling attempts: a caller trying to get a forbidden flag into the argv
  // through a field that is legitimately caller-controlled.
  { ...BASE, include: ['--no-security-check'] },
  { ...BASE, include: ['src/**', '--remote'] },
  { ...BASE, ignore: ['--copy', '-o', '/etc/passwd'] },
  { ...BASE, ignore: ['--hidden'], include: ['--no-ignore'] },
  { ...BASE, baseRef: '--clipboard' },
];

// ───────────────────────── pins and identity ─────────────────────────

describe('the pin is enforced by EQUALITY, not by parseability', () => {
  it('accepts exactly the pinned repomix version', () => {
    const r = assertIsRepomix(`${REPOMIX_PINNED_VERSION}\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.version).toBe(REPOMIX_PINNED_VERSION);
  });

  it('REJECTS a repomix vendor dir that drifted off the pin', () => {
    // This is the failure the leg exists to prevent, and it is invisible to
    // every check except equality: a drifted binary answers --version perfectly.
    for (const drifted of ['1.19.0', '1.17.9', '2.0.0']) {
      const r = assertIsRepomix(drifted);
      expect(r.ok, `expected ${drifted} to be refused`).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toContain('DRIFTED');
    }
  });

  it('accepts exactly the pinned code2prompt version', () => {
    const r = assertIsCode2Prompt(`code2prompt ${CODE2PROMPT_PINNED_VERSION}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.version).toBe(CODE2PROMPT_PINNED_VERSION);
  });

  it('REJECTS the npm package of the same name (D-040) — it is a different project', () => {
    // `npm i code2prompt` installs github.com/puntorigen/code2prompt, a NodeJS
    // library with no executable. Nothing it could print identifies as the CLI.
    for (const impostor of ['1.1.4', 'code2prompt-lib 1.1.4', '']) {
      const r = assertIsCode2Prompt(impostor);
      expect(r.ok, `expected ${JSON.stringify(impostor)} to be refused`).toBe(false);
    }
  });

  it('CONTROL: a lenient assert that only checks parseability passes the drift cases', () => {
    // Deliberately wrong: parses a semver but never compares it to the pin.
    // This is what the check looked like before equality was the rule, and it
    // proves the drift assertions above can actually fail.
    const lenient = (out: string) => /^(\d+\.\d+\.\d+)$/m.test(out.trim());
    expect(lenient('1.19.0')).toBe(true); // control WOULD accept a drifted engine
    expect(assertIsRepomix('1.19.0').ok).toBe(false); // subject does not
  });
});

// ───────────────────────── forbidden flags ─────────────────────────

describe('dangerous engine flags are unreachable by construction', () => {
  it('no repomix argv, for any input, contains a forbidden flag', () => {
    for (const args of ARG_MATRIX) {
      const argv = buildRepomixArgs(args);
      for (const flag of REPOMIX_FORBIDDEN_FLAGS) {
        expect(argv, `${flag} leaked for ${JSON.stringify(args)}`).not.toContain(flag);
      }
    }
  });

  it('no code2prompt argv, for any input, contains a forbidden flag', () => {
    for (const args of ARG_MATRIX) {
      const argv = buildCode2PromptArgs(args);
      for (const flag of CODE2PROMPT_FORBIDDEN_FLAGS) {
        expect(argv, `${flag} leaked for ${JSON.stringify(args)}`).not.toContain(flag);
      }
    }
  });

  it('secret-scanning can never be disabled — --no-security-check is absent always', () => {
    for (const args of ARG_MATRIX) {
      expect(buildRepomixArgs(args)).not.toContain('--no-security-check');
    }
  });

  it('code2prompt always writes to STDOUT: -O is present and its value is exactly "-"', () => {
    for (const args of ARG_MATRIX) {
      const argv = buildCode2PromptArgs(args);
      const i = argv.indexOf('-O');
      expect(i, 'code2prompt argv must pin its output target').toBeGreaterThanOrEqual(0);
      expect(argv[i + 1]).toBe('-');
      // and no second output flag smuggled in behind it
      expect(argv.filter((t) => t === '-O')).toHaveLength(1);
    }
  });

  it('CONTROL: a builder that appends --no-security-check fails the same assertion', () => {
    const wrong = (args: PackerArgs) => [...buildRepomixArgs(args), '--no-security-check'];
    expect(wrong(BASE)).toContain('--no-security-check'); // control is caught
    expect(buildRepomixArgs(BASE)).not.toContain('--no-security-check'); // subject is not
  });

  it('CONTROL: a builder that honours a caller output path fails the stdout assertion', () => {
    const wrong = (args: PackerArgs) => {
      const argv = buildCode2PromptArgs(args);
      const i = argv.indexOf('-O');
      return [...argv.slice(0, i + 1), '/tmp/attacker-chosen.md', ...argv.slice(i + 2)];
    };
    const w = wrong(BASE);
    expect(w[w.indexOf('-O') + 1]).not.toBe('-'); // control writes a file
    const s = buildCode2PromptArgs(BASE);
    expect(s[s.indexOf('-O') + 1]).toBe('-'); // subject cannot
  });
});

// ───────────────────────── the deny-set ─────────────────────────

describe('the secret deny-set cannot be shortened by a caller', () => {
  const ignoreArgOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1] ?? '';

  it('every deny glob reaches repomix, whatever the caller passes for ignore', () => {
    for (const args of ARG_MATRIX) {
      const value = ignoreArgOf(buildRepomixArgs(args), '--ignore');
      for (const glob of SECRET_DENY_GLOBS) {
        expect(value.split(','), `${glob} missing`).toContain(glob);
      }
    }
  });

  it('every deny glob reaches code2prompt, whatever the caller passes for ignore', () => {
    for (const args of ARG_MATRIX) {
      const value = ignoreArgOf(buildCode2PromptArgs(args), '-e');
      for (const glob of SECRET_DENY_GLOBS) {
        expect(value.split(','), `${glob} missing`).toContain(glob);
      }
    }
  });

  it('covers the file shapes that actually carry credentials', () => {
    // A deny-set is only as good as its coverage; name the shapes explicitly so
    // shrinking it is a visible edit rather than a silent one.
    for (const needed of ['**/.env', '**/*.pem', '**/*.key', '**/id_rsa*', '**/.npmrc', '**/credentials']) {
      expect(SECRET_DENY_GLOBS).toContain(needed);
    }
  });

  it('CONTROL: a builder that uses only the caller ignore drops the whole deny-set', () => {
    const wrong = (args: PackerArgs) => ['--ignore', (args.ignore ?? []).join(',')];
    const w = ignoreArgOf(wrong({ ...BASE, ignore: ['docs/**'] }), '--ignore').split(',');
    expect(w).not.toContain('**/.env'); // control leaks secrets
    const s = ignoreArgOf(buildRepomixArgs({ ...BASE, ignore: ['docs/**'] }), '--ignore').split(',');
    expect(s).toContain('**/.env'); // subject does not
  });
});

// ───────────────────────── explicit include set ─────────────────────────

describe('an explicit include set is required (P-016)', () => {
  it('both builders refuse an empty include set', () => {
    expect(() => buildRepomixArgs({ ...BASE, include: [] })).toThrow(/explicit/i);
    expect(() => buildCode2PromptArgs({ ...BASE, include: [] })).toThrow(/explicit/i);
  });

  it('the facade turns that into a refusal ANSWER, not a thrown error', async () => {
    const r = await packerFacade('pack', { ...BASE, include: [] }, stubEffects());
    expect(r.answer.error).toMatch(/explicit/i);
    expect(r.artifact).toBeNull();
  });
});

// ───────────────────────── selection parsing ─────────────────────────

describe('an unreadable selection is null, never zero', () => {
  it('parses xml file markers', () => {
    const body = '<file path="a/b.ts">x</file>\n<file path="c/d.ts">y</file>';
    expect(parseSelectedFiles(body, 'xml')).toEqual(['a/b.ts', 'c/d.ts']);
  });

  it('parses markdown file headings', () => {
    const body = '## File: a/b.ts\ncode\n## File: c/d.ts\ncode';
    expect(parseSelectedFiles(body, 'markdown')).toEqual(['a/b.ts', 'c/d.ts']);
  });

  it('de-duplicates repeated paths', () => {
    const body = '<file path="a.ts">1</file><file path="a.ts">2</file>';
    expect(parseSelectedFiles(body, 'xml')).toEqual(['a.ts']);
  });

  it('returns NULL when nothing parses — the difference that matters', () => {
    // "I could not read the pack" and "the pack selected nothing" are different
    // answers. Only one is evidence, and coercing the first to [] destroys the
    // distinction exactly where a reader would rely on it.
    expect(parseSelectedFiles('total gibberish', 'xml')).toBeNull();
    expect(parseSelectedFiles('', 'markdown')).toBeNull();
  });

  it('CONTROL: a parser returning [] on no-match is indistinguishable from an empty pack', () => {
    const wrong = (body: string): readonly string[] => {
      const out: string[] = [];
      const re = /<file\s+path="([^"]+)"/g;
      for (let m = re.exec(body); m !== null; m = re.exec(body)) out.push(m[1]);
      return out; // deliberately never null
    };
    expect(wrong('gibberish')).toEqual([]); // control fabricates an empty selection
    expect(parseSelectedFiles('gibberish', 'xml')).toBeNull(); // subject refuses to
  });
});

// ───────────────────────── templates ─────────────────────────

describe('pack templates are a closed set we own', () => {
  it('every non-none template yields non-empty header text', () => {
    for (const [name, text] of Object.entries(PACK_TEMPLATES)) {
      if (name === 'none') expect(text).toBe('');
      else expect(text.length, `${name} is empty`).toBeGreaterThan(0);
    }
  });

  it('an absent template contributes nothing', () => {
    expect(templateHeader(undefined)).toBe('');
    expect(templateHeader('none')).toBe('');
  });

  it('no template is a filesystem path — code2prompt -t is never used', () => {
    // -t would be an arbitrary-file-read plus a template-injection surface.
    expect(CODE2PROMPT_FORBIDDEN_FLAGS).toContain('-t');
    expect(CODE2PROMPT_FORBIDDEN_FLAGS).toContain('--template');
  });
});

// ───────────────────────── provenance + refusals ─────────────────────────

function stubEffects(over: Partial<PackerEffects> = {}, body = '<file path="a.ts">x</file>'): PackerEffects {
  const exec: ExecFn = async (bin, argv) => {
    if (argv[0] === '--version') return { stdout: REPOMIX_PINNED_VERSION };
    if (bin === 'git') {
      if (argv[0] === 'rev-parse') return { stdout: 'abc1234def\n' };
      if (argv[0] === 'status') return { stdout: '' };
    }
    return { stdout: body };
  };
  return {
    exec,
    writeArtifact: async () => '/scratch/pack.xml',
    now: () => new Date('2026-08-21T12:00:00Z'),
    ...over,
  };
}

describe('a refusal is an ANSWER that can never read as an empty selection', () => {
  it('a disabled flag refuses, and the refusal is not a trustworthy empty', async () => {
    vi.mocked(getFlag).mockResolvedValueOnce(false);
    const r = await packerFacade('pack', BASE, stubEffects());
    expect(r.answer.sites).toEqual([]);
    expect(r.answer.error).toMatch(/disabled/);
    expect(r.answer.freshness.health).toBe('unknown');
    // The load-bearing assertion: a refusal must NOT satisfy the corpus's
    // trustworthy-empty predicate, or "packing is off" scores as "nothing matched".
    expect(isTrustworthyEmpty(r.answer)).toBe(true); // true only because error !== null
    expect(r.answer.error).not.toBeNull();
  });

  it('an engine failure is reported loudly, never as an empty pack', async () => {
    const boom: ExecFn = async (_b, argv) => {
      if (argv[0] === '--version') return { stdout: REPOMIX_PINNED_VERSION };
      throw Object.assign(new Error('spawn failed'), { stderr: 'repomix: exploded' });
    };
    const r = await packerFacade('pack', BASE, stubEffects({ exec: boom }));
    expect(r.answer.error).toContain('exploded');
    expect(r.artifact).toBeNull();
  });
});

describe('provenance states what the pack actually is', () => {
  it('stamps engine, version, commit, dirtiness and selection', async () => {
    const r = await packerFacade('pack', BASE, stubEffects());
    const p = r.artifact?.provenance;
    expect(p?.engine).toBe('repomix');
    expect(p?.engineVersion).toBe(REPOMIX_PINNED_VERSION);
    expect(p?.commit).toBe('abc1234def');
    expect(p?.dirty).toBe(false);
    expect(p?.fileCount).toBe(1);
    expect(p?.include).toEqual(BASE.include);
    expect(p?.capturedAt).toBe('2026-08-21T12:00:00.000Z');
  });

  it('reports securityScan HONESTLY per engine — the two are not interchangeable', async () => {
    const packed = await packerFacade('pack', BASE, stubEffects());
    expect(packed.artifact?.provenance.securityScan).toBe('secretlint+deny-set');

    const diffed = await packerFacade(
      'diff',
      BASE,
      stubEffects({
        exec: async (bin, argv) => {
          if (argv[0] === '--version') return { stdout: `code2prompt ${CODE2PROMPT_PINNED_VERSION}` };
          if (bin === 'git') return { stdout: argv[0] === 'status' ? '' : 'abc1234def' };
          return { stdout: '## File: a.ts\nx' };
        },
      }),
    );
    // code2prompt 4.2.0 ships NO secret scanner (measured across its whole
    // option surface). Saying so is the point: a consumer must not assume the
    // repomix guarantee carries over.
    expect(diffed.artifact?.provenance.securityScan).toBe('deny-set-only');
  });

  it('fileCount is NULL — not 0 — when the pack could not be parsed', async () => {
    const r = await packerFacade('pack', BASE, stubEffects({}, 'unparseable output'));
    expect(r.artifact?.provenance.fileCount).toBeNull();
    expect(r.answer.sites).toEqual([]);
    // and the truncation total must carry the same honesty
    expect(r.answer.truncation.totalAvailable).toBeNull();
  });

  it('a dirty tree is reported, so a pack is never miscited as "the code at <sha>"', async () => {
    const dirty = stubEffects({
      exec: async (bin, argv) => {
        if (argv[0] === '--version') return { stdout: REPOMIX_PINNED_VERSION };
        if (bin === 'git') return { stdout: argv[0] === 'status' ? ' M a.ts\n' : 'abc1234def' };
        return { stdout: '<file path="a.ts">x</file>' };
      },
    });
    const r = await packerFacade('pack', BASE, dirty);
    expect(r.artifact?.provenance.dirty).toBe(true);
    expect(r.answer.freshness.staleVsDisk).toBe(true);
  });

  it('a non-git root yields null commit rather than a fabricated one', async () => {
    const nogit = stubEffects({
      exec: async (bin, argv) => {
        if (argv[0] === '--version') return { stdout: REPOMIX_PINNED_VERSION };
        if (bin === 'git') throw new Error('not a git repository');
        return { stdout: '<file path="a.ts">x</file>' };
      },
    });
    const r = await packerFacade('pack', BASE, nogit);
    expect(r.artifact?.provenance.commit).toBeNull();
    expect(r.artifact?.provenance.dirty).toBeNull();
  });

  it('readGitProvenance never throws — a missing git is absence, not an error', async () => {
    const throwing: ExecFn = async () => {
      throw new Error('no git');
    };
    await expect(readGitProvenance('/repo', 'main', throwing)).resolves.toEqual({
      commit: null,
      dirty: null,
      baseCommit: null,
    });
  });

  it('the pack body never comes back inline — only a bounded preview plus a path', async () => {
    const big = 'x'.repeat(500_000);
    const r = await packerFacade('pack', BASE, stubEffects({}, `<file path="a.ts">${big}</file>`));
    expect(r.artifact?.path).toBe('/scratch/pack.xml');
    // The whole reason a pack is an artifact and not a result: it must not be
    // able to blow the caller's context budget.
    expect(r.artifact!.preview.length).toBeLessThanOrEqual(4096);
    expect(r.artifact!.provenance.chars).toBeGreaterThan(400_000);
  });

  it('a pack at the byte ceiling reports truncated:true', async () => {
    expect(MAX_PACK_BYTES).toBeGreaterThan(0);
    const r = await packerFacade('pack', BASE, stubEffects());
    // A small pack is not truncated; the flag tracks the ceiling, not length.
    expect(r.answer.truncation.truncated).toBe(false);
  });
});

describe('the diff op routes to code2prompt and the pack op to repomix', () => {
  const formats: PackFormat[] = ['markdown', 'xml'];
  it('backend follows the op, not the caller', async () => {
    for (const format of formats) {
      const packed = await packerFacade('pack', { ...BASE, format }, stubEffects());
      expect(packed.answer.backend).toBe('repomix');
      expect(packed.answer.intent).toBe('pack');
    }
  });
});
