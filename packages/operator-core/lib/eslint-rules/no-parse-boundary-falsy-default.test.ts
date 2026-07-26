/**
 * Unit test for the `papercusp/no-parse-boundary-falsy-default` ESLint rule
 * (WI-5977). Uses ESLint's built-in `RuleTester`.
 *
 * See `no-bare-jsonb-cast.test.ts` in this directory for why these tests
 * live here rather than under `tools/eslint-rules/__tests__/` (no vitest
 * config owns that directory, so a guard placed there never runs).
 */
import { createRequire } from 'node:module';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { RuleTester } = require('eslint');

const rule = require('../../../../tools/eslint-rules/no-parse-boundary-falsy-default.js');

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

describe('papercusp/no-parse-boundary-falsy-default', () => {
  it('passes RuleTester valid/invalid cases', () => {
    tester.run('no-parse-boundary-falsy-default', rule, {
      valid: [
        // Defaulting to null/undefined IS the explicit-absence idiom — not flagged.
        { code: 'const x = JSON.parse(s).foo ?? null;' },
        { code: 'const x = JSON.parse(s).foo ?? undefined;' },
        // A non-falsy default is a plain optionality default, not an absence collapse.
        { code: 'const x = JSON.parse(s).foo ?? "default";' },
        { code: 'const x = JSON.parse(s).foo ?? 42;' },
        // Not sourced from JSON.parse at all.
        { code: 'const x = config.foo ?? false;' },
        { code: 'const x = getThing().foo ?? 0;' },
        // JSON.stringify (a different call) must not be mistaken for JSON.parse.
        { code: 'const x = JSON.stringify(s).length ?? 0;' },
        // An explicit presence check ahead of the read — not this rule's shape.
        { code: 'const parsed = JSON.parse(s); const x = "foo" in parsed ? parsed.foo : false;' },
      ],
      invalid: [
        {
          code: 'const relayed = JSON.parse(line).relayed ?? false;',
          errors: [{ messageId: 'collapsed' }],
        },
        {
          code: 'const bytesReceived = JSON.parse(line).wire.bytesReceived ?? 0;',
          errors: [{ messageId: 'collapsed' }],
        },
        {
          code: "const name = JSON.parse(line).name || '';",
          errors: [{ messageId: 'collapsed' }],
        },
        {
          // Optional chaining on the parsed side is still caught.
          code: 'const relayed = JSON.parse(line)?.path?.relayed ?? false;',
          errors: [{ messageId: 'collapsed' }],
        },
      ],
    });
  });
});
