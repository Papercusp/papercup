/**
 * Tests for the command atomizer (plan `bash-substitution-reachable-ceiling-2026-08-01`, P-001).
 *
 * WHY THIS FILE DID NOT EXIST BEFORE, AND WHY THAT WAS THE BUG: `atomize` is the
 * single definition of what a "bash atom" IS — every registry match, every
 * equivalence verdict and every percentage the substitution programme has ever
 * published is denominated in its output. It shipped untested, and its
 * newline-splitting silently counted heredoc bodies and embedded scripts as
 * commands. Measured over the 14d corpus that inflated the denominator by 34%
 * (214,400 atoms → 141,696), which is why the predecessor plan's headline number
 * could not be moved by any amount of real substitution: a third of it was never
 * substitutable because it was never a command.
 *
 * The cases below are therefore not hypotheticals — each one is a shape drawn
 * from the real corpus that produced a spurious atom.
 */

import { describe, expect, it } from 'vitest';
import { atomHead, atomize, atomizePipeline, isShellSyntaxAtom, normalizeAtom } from './atomize';

/** Convenience: the command verb of every atom, which is what bucketing uses. */
const heads = (command: string): Array<string | null> => atomize(command).map(atomHead);

describe('atomize — separators at shell depth 0', () => {
  it('splits a compound line on &&, | and ;', () => {
    expect(atomize("cd /repo && sed -n '1,40p' a.ts | head -5")).toEqual([
      'cd /repo',
      "sed -n '1,40p' a.ts",
      'head -5',
    ]);
  });

  it('splits on || and on a bare newline between commands', () => {
    expect(atomize('git fetch || echo failed\ngit status')).toEqual([
      'git fetch',
      'echo failed',
      'git status',
    ]);
  });

  it('strips runner wrappers and env assignments so the verb is at position 0', () => {
    expect(normalizeAtom('sudo -n PGPASSWORD=x psql -c "select 1"')).toBe('psql -c "select 1"');
    expect(atomHead('/usr/bin/psql -c "select 1"')).toBe('psql');
  });
});

describe('atomize — quoting (a separator inside a quote is not a separator)', () => {
  it('does not split on a | inside a quoted regex', () => {
    // The D-038 case. It was previously patched DOWNSTREAM, in the equivalence
    // harness, by re-closing the quote the splitter had broken; fixing it here
    // removes the need for that repair rather than duplicating it.
    expect(atomize("grep -E 'error|warn' app.log")).toEqual(["grep -E 'error|warn' app.log"]);
  });

  it('does not split on a ; inside a quoted SQL string', () => {
    expect(atomize(`psql -c "select 1; select 2"`)).toEqual([`psql -c "select 1; select 2"`]);
  });

  it('does not split on a newline inside a quoted inline script', () => {
    expect(heads('node -e "const a = 1;\nconsole.log(a)"')).toEqual(['node']);
  });

  it('treats an escaped quote as data, not as a quote boundary', () => {
    expect(atomize(`echo "a \\" b | c"`)).toEqual([`echo "a \\" b | c"`]);
  });

  it('keeps an UNTERMINATED quote as one atom rather than splitting inside it', () => {
    // Fail-open: the worst outcome of over-joining is a missing advisory; the
    // worst outcome of splitting inside a quote is a fabricated atom.
    expect(atomize(`echo 'oops | still open`)).toEqual([`echo 'oops | still open`]);
  });
});

describe('atomize — heredocs (the body is data, not commands)', () => {
  it('absorbs a heredoc body instead of atomizing it', () => {
    const command = [
      "cat > /tmp/probe.ts <<'EOF'",
      "import { readFileSync } from 'node:fs';",
      'const raw = readFileSync(p);',
      'return raw.length;',
      'EOF',
      'npx tsx /tmp/probe.ts',
    ].join('\n');
    // `import`, `const` and `return` are the exact spurious heads this fixes.
    expect(heads(command)).toEqual(['cat', 'npx']);
  });

  it('honours <<- with a tab-indented terminator', () => {
    const command = ['run <<-END', '\tconst x = 1;', '\tEND', 'echo done'].join('\n');
    expect(heads(command)).toEqual(['run', 'echo']);
  });

  it.each([
    ['<<', ' END'],
    ['<<', 'END '],
    ['<<', '\tEND'],
    ['<<', 'END\t'],
    ['<<', ' END '],
    ['<<', 'END\r'],
    ['<<', '\u00a0END'],
    ['<<-', ' END'],
    ['<<-', 'END '],
    ['<<-', 'END\t'],
    ['<<-', '\t END'],
    ['<<-', '\tEND '],
    ['<<-', '\tEND\t'],
    ['<<-', '\tEND\r'],
  ])('%s keeps the padded delimiter %j and following text in the body', (operator, padded) => {
    const command = [
      `cat ${operator}END`,
      padded,
      'printf body | wc -c',
      'END',
      'printf after | wc -c',
    ].join('\n');

    expect(atomize(command)).toEqual([`cat ${operator}END`, 'printf after', 'wc -c']);
  });

  it.each(['<<', '<<-'])('%s absorbs the body when only padded delimiters occur', (operator) => {
    const command = [
      `cat ${operator}END`,
      'END ',
      'printf body | wc -c',
      '\t END',
      'printf still-body',
    ].join('\n');

    expect(atomize(command)).toEqual([`cat ${operator}END`]);
  });

  it.each(['<<END', "<<'END'", '<<"END"', '<<-END', "<<-'END'", '<<-"END"'])(
    'accepts an exact %s delimiter at end of input',
    (introducer) => {
      expect(atomize([`cat ${introducer}`, 'printf body', 'END'].join('\n'))).toEqual([
        `cat ${introducer}`,
      ]);
    },
  );

  it('strips multiple leading tabs for <<- while preserving the following pipeline', () => {
    const command = [
      "cat <<-'END'",
      '\tEND ',
      'printf body | wc -c',
      '\t\tEND',
      'printf after | wc -c',
    ].join('\n');

    expect(atomizePipeline(command).map(({ atom, pipedInto, upstream }) => ({
      atom, pipedInto, upstream,
    }))).toEqual([
      { atom: "cat <<-'END'", pipedInto: false, upstream: null },
      { atom: 'printf after', pipedInto: false, upstream: null },
      { atom: 'wc -c', pipedInto: true, upstream: 'printf after' },
    ]);
  });

  it('consumes queued heredocs through their true delimiters', () => {
    const command = [
      'cat <<FIRST <<-SECOND',
      ' FIRST',
      'printf first-body',
      'FIRST',
      '\t SECOND',
      'printf second-body',
      '\tSECOND',
      'printf after',
    ].join('\n');

    expect(atomize(command)).toEqual(['cat <<FIRST <<-SECOND', 'printf after']);
  });

  it('does not treat a here-STRING (<<<) as a heredoc', () => {
    expect(atomize('grep -c x <<< "$payload"')).toEqual(['grep -c x <<< "$payload"']);
  });

  it('absorbs an unterminated heredoc rather than atomizing its body', () => {
    // A truncated transcript entry: the terminator never arrives. Everything
    // after the introducer is still body, so it must not become atoms.
    expect(heads(['cat <<EOF', 'const a = 1;', 'const b = 2;'].join('\n'))).toEqual(['cat']);
  });
});

describe('atomize — line continuations', () => {
  it('joins a backslash-newline instead of emitting a bare \\ atom', () => {
    expect(heads('npm run test:file -- a.test.ts \\\n  --reporter=verbose')).toEqual(['npm']);
  });
});

describe('atomize — shell syntax is not a command', () => {
  it('drops loop and conditional scaffolding, keeping only the commands', () => {
    expect(heads('for f in a b; do echo $f; done')).toEqual(['echo']);
    expect(heads('if grep -q x f; then echo yes; else echo no; fi')).toEqual([
      'grep',
      'echo',
      'echo',
    ]);
    expect(heads('while read -r l; do printf "%s" "$l"; done')).toEqual(['read', 'printf']);
  });

  it('strips a leading ! and a brace group so the real verb is the head', () => {
    expect(heads('! pgrep -f worker')).toEqual(['pgrep']);
    expect(heads('{ echo a; echo b; }')).toEqual(['echo', 'echo']);
  });

  it('classifies reserved words directly', () => {
    for (const word of ['done', 'fi', 'esac', '}', 'for i in 1 2 3', 'case $x in']) {
      expect(isShellSyntaxAtom(word)).toBe(true);
    }
    for (const word of ['echo hi', 'grep -q x f', 'test -f a', '[ -f a ]']) {
      expect(isShellSyntaxAtom(word)).toBe(false);
    }
  });
});

describe('atomize — the regression this plan exists to prevent', () => {
  /**
   * The guard, stated as the property rather than as examples: no atom the
   * matcher ever sees may be a language keyword from an embedded script or a
   * shell reserved word. If a future change re-introduces naive newline
   * splitting, this fails here instead of silently re-inflating the denominator
   * and reappearing months later as "the number will not move".
   */
  const NEVER_A_COMMAND = new Set([
    'const', 'let', 'import', 'export default', 'return', 'function', 'class',
    'await', 'async', 'def', 'print', 'elif',
    'do', 'done', 'then', 'fi', 'esac', 'for', 'while', 'until', 'case', 'in', '}', '{', '\\',
  ]);

  it('emits no keyword atoms for a realistic mixed command', () => {
    const command = [
      'cd /repo && cat > /tmp/t.mjs <<\'EOF\'',
      "import fs from 'node:fs';",
      'const rows = JSON.parse(fs.readFileSync(p, "utf8"));',
      'for (const r of rows) { console.log(r.id); }',
      'export default rows;',
      'EOF',
      'for f in a b; do node /tmp/t.mjs "$f" | head -3; done',
    ].join('\n');

    const got = heads(command).filter((h): h is string => h !== null);
    expect(got.filter((h) => NEVER_A_COMMAND.has(h))).toEqual([]);
    expect(got).toEqual(['cd', 'cat', 'node', 'head']);
  });
});
