import { describe, expect, it } from 'vitest';

import { findConstantConditional } from './constant-conditional';

const scan = (src: string) => findConstantConditional('fixture.ts', src);

describe('findConstantConditional', () => {
  describe('flags a branch that a literal has forced dead', () => {
    it('flags the exact EI-19446174755157221 regression', () => {
      // The real committed line, verbatim (stalled-loops-guard.ts:273).
      const hit = scan(
        'const wall = compute();\n' +
          'if (false && wall && wall.resumesInMs != null && wall.resumesInMs > 0) {\n' +
          '  use(wall);\n' +
          '}\n',
      );
      expect(hit).not.toBeNull();
      expect(hit?.constant).toBe('false');
      expect(hit?.operator).toBe('&&');
      expect(hit?.line).toBe(2);
    });

    it('flags a bare if (false)', () => {
      const hit = scan('if (false) {\n  dead();\n}\n');
      expect(hit?.constant).toBe('false');
      expect(hit?.operator).toBeNull();
    });

    it('flags a force-ENABLED branch: true || …', () => {
      const hit = scan('if (true || realCondition()) {\n  always();\n}\n');
      expect(hit?.constant).toBe('true');
      expect(hit?.operator).toBe('||');
    });

    it('flags a bare if (true)', () => {
      expect(scan('if (true) { always(); }')?.constant).toBe('true');
    });

    it('finds the literal at the head of a LONG chain (left-spine descent)', () => {
      // Parses as (((false && a) && b) && c) — the literal is not `.left` of the root.
      const hit = scan('if (false && a && b && c) { dead(); }');
      expect(hit?.constant).toBe('false');
      expect(hit?.operator).toBe('&&');
    });

    it('flags a nested if inside a function body', () => {
      const hit = scan('export function f() {\n  if (false && x.y) {\n    dead();\n  }\n}\n');
      expect(hit?.constant).toBe('false');
      expect(hit?.line).toBe(2);
    });

    it('reports a 1-based line and column', () => {
      const hit = scan('const a = 1;\nif (false) { dead(); }\n');
      expect(hit?.line).toBe(2);
      expect(hit?.col).toBe(5); // `if (` is 4 chars, condition starts at col 5
    });

    it('is immune to formatting — a multi-line condition still reports', () => {
      const hit = scan('if (\n  false &&\n  wall\n) {\n  dead();\n}\n');
      expect(hit?.constant).toBe('false');
      expect(hit?.text).toContain('false &&');
    });
  });

  describe('does NOT flag legitimate code (the false-positive discipline)', () => {
    it('does not flag a named constant gate — the RECOMMENDED disable', () => {
      // su-3a5df's own advice after the incident: gate on a named const, never a
      // raw literal. That must stay clean or the guard fights the fix it wants.
      expect(scan('const ENABLED = false;\nif (ENABLED && wall) {\n  x();\n}\n')).toBeNull();
    });

    it('does not flag while (true) / for (;;) — real idioms in this repo', () => {
      expect(scan('while (true) {\n  await pump();\n}\n')).toBeNull();
      expect(scan('for (;;) {\n  tick();\n}\n')).toBeNull();
      expect(scan('do {\n  x();\n} while (true);\n')).toBeNull();
    });

    it('does not flag a literal in a NON-leading position', () => {
      // `a && false` still depends on `a`; it is odd, not a disabled branch, and
      // critically it does NOT suppress narrowing the way a leading literal does.
      expect(scan('if (wall && wall.x != null && false) { x(); }')).toBeNull();
    });

    it('does not flag the redundant-but-live combinations', () => {
      // `true && cond` and `false || cond` both still depend on `cond`.
      expect(scan('if (true && cond) { x(); }')).toBeNull();
      expect(scan('if (false || cond) { x(); }')).toBeNull();
    });

    it('does not flag the words true/false in comments or strings', () => {
      // The whole reason this is AST-based rather than a regex.
      expect(scan('// if (false && x) — documenting the trap\nif (real) { x(); }\n')).toBeNull();
      expect(scan('const s = "if (false && x)";\nif (real) { x(); }\n')).toBeNull();
      expect(scan('/** if (false) is bad */\nif (real) { x(); }\n')).toBeNull();
    });

    it('does not flag ordinary conditions', () => {
      expect(scan('if (a && b.c != null && b.c > 0) {\n  ok();\n}\n')).toBeNull();
      expect(scan('if (!x) { y(); }')).toBeNull();
      expect(scan('if (x === false) { y(); }')).toBeNull(); // comparison, not a forced branch
    });

    it('does not flag a ternary or a boolean assignment', () => {
      expect(scan('const v = false ? a : b;')).toBeNull();
      expect(scan('const enabled = false;')).toBeNull();
    });

    it('reports clean on a file that does not parse (ts-parse owns that)', () => {
      // Two quarantine reasons for one cause is noise — the parse detector reports it.
      expect(scan('export function broken( {{{ ')).toBeNull();
    });
  });

  describe('scope', () => {
    it('handles .tsx via the TSX script kind', () => {
      const hit = findConstantConditional(
        'fixture.tsx',
        'export const C = () => {\n  if (false && ok) return <div />;\n  return null;\n};\n',
      );
      expect(hit?.constant).toBe('false');
    });

    it('returns the FIRST hit only, keeping the message single-cause', () => {
      const hit = scan('if (false) { a(); }\nif (true) { b(); }\n');
      expect(hit?.line).toBe(1);
    });
  });
});
