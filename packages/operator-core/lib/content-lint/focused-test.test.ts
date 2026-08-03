import { describe, expect, it } from 'vitest';

import { findFocusedTest } from './focused-test';

const scan = (src: string) => findFocusedTest('fixture.test.ts', src);

describe('findFocusedTest', () => {
  describe('flags a focus that would silently disable the rest of the file', () => {
    it('flags the canonical it.only', () => {
      const hit = scan("it.only('does the thing', () => {\n  expect(1).toBe(1);\n});\n");
      expect(hit).not.toBeNull();
      expect(hit?.root).toBe('it');
      expect(hit?.line).toBe(1);
      expect(hit?.col).toBe(1);
    });

    it('flags describe.only', () => {
      expect(scan("describe.only('suite', () => {});")?.root).toBe('describe');
    });

    it('flags test.only', () => {
      expect(scan("test.only('case', () => {});")?.root).toBe('test');
    });

    it('flags a MID-FILE focus and reports its real line', () => {
      const hit = scan(
        "describe('suite', () => {\n" +
          "  it('first', () => {});\n" +
          "  it.only('second — this silently disables first', () => {});\n" +
          '});\n',
      );
      expect(hit?.root).toBe('it');
      expect(hit?.line).toBe(3);
    });

    it('flags a focus reached through a CALL in the chain: describe.each([…]).only', () => {
      // Parses as ((describe.each)([…])).only — the root is not `.expression`.
      const hit = scan('describe.each([1, 2]).only("parameterised", () => {});');
      expect(hit?.root).toBe('describe');
    });

    it('flags a focus reached through a MODIFIER: test.concurrent.only', () => {
      expect(scan('test.concurrent.only("c", () => {});')?.root).toBe('test');
    });

    it("flags Playwright's test.describe.only", () => {
      expect(scan('test.describe.only("group", () => {});')?.root).toBe('test');
    });

    it('reports the FIRST focus when a file has several', () => {
      const hit = scan("it.only('a', () => {});\ndescribe.only('b', () => {});\n");
      expect(hit?.line).toBe(1);
      expect(hit?.root).toBe('it');
    });
  });

  describe('stays clean on the idioms it must never fight', () => {
    // The measured decision this detector rests on: 50 tracked test files use
    // `.skip`. Flagging it would fire 50 false positives on day one.
    it('does NOT flag .skip — the repo\'s established quarantine idiom', () => {
      expect(scan("it.skip('quarantined', () => {});")).toBeNull();
      expect(scan("describe.skip('quarantined', () => {});")).toBeNull();
      expect(scan("test.skip('quarantined', () => {});")).toBeNull();
    });

    it('does NOT flag an ordinary test file', () => {
      expect(
        scan("describe('suite', () => {\n  it('works', () => {\n    expect(1).toBe(1);\n  });\n});\n"),
      ).toBeNull();
    });

    it('does NOT flag `.only` on an UNRELATED object', () => {
      expect(scan('const x = options.only;')).toBeNull();
      expect(scan('if (parsed.only) { run(); }')).toBeNull();
      expect(scan('const v = config.filters.only;')).toBeNull();
    });

    it('does NOT flag `.only` inside a COMMENT (AST, not regex)', () => {
      expect(scan("// remember to remove it.only before committing\nit('real', () => {});")).toBeNull();
      expect(scan("/* it.only('x', () => {}); */\nit('real', () => {});")).toBeNull();
    });

    it('does NOT flag `.only` inside a STRING literal (AST, not regex)', () => {
      expect(scan("it('rejects it.only in user input', () => {});")).toBeNull();
      expect(scan('const msg = "use it.only to focus";')).toBeNull();
    });

    it('reports clean on a file that does not parse (ts-parse owns that break)', () => {
      expect(scan('it.only(((( unterminated')).not.toThrow;
      expect(() => scan('function ( { [ unclosed')).not.toThrow();
    });
  });

  describe('scope + reporting', () => {
    it('handles .tsx', () => {
      const hit = findFocusedTest('fixture.test.tsx', 'it.only("renders", () => { render(<A />); });');
      expect(hit?.root).toBe('it');
    });

    it('bounds the reported text for a one-line message', () => {
      const hit = scan(`it.only(${'"'}${'x'.repeat(300)}${'"'}, () => {});`);
      expect(hit?.text.length).toBeLessThanOrEqual(101);
    });
  });
});
