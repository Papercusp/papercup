/**
 * tool-error-classifier.test.ts — the real-corpus regression guard for the
 * tool-error classifier (watchdog-and-exposed-systems-improvement-2026-06-18
 * P-011). The classifier was brittle and fixed reactively three times
 * (timeout-in-wrong-branch, external-rate-limit missing, the invalid_args drift).
 * This test pins the LIVE high-volume error shapes (tool-error-corpus.fixture.ts)
 * to their correct class so the NEXT misclassification is caught before it floods
 * a lane — and proves the table-driven generators are structurally sound.
 *
 * The SQL-CASE↔TS PARITY (the anti-drift guarantee with teeth) lives in
 * tool-error-classifier.integration.test.ts, which runs the GENERATED SQL over
 * this same corpus in real PG.
 *
 * Bucket query used to capture the fixture (re-run to refresh):
 *   WITH e AS (SELECT coalesce(error_code,'<null>') ec, status,
 *     array_to_string((string_to_array(trim(regexp_replace(regexp_replace(
 *       lower(coalesce(error_message,'')),'[0-9]+','','g'),'[^a-z]+',' ','g')),' '))[1:8],' ') norm,
 *     error_message FROM harness_shared.tool_invocations
 *     WHERE status IN ('error','timeout') AND invoked_at > now() - interval '14 days')
 *   SELECT count(*) n, ec, status, left(norm,80), left(max(error_message),140)
 *   FROM e GROUP BY ec, status, 4 ORDER BY n DESC LIMIT 45;
 */
import { describe, it, expect } from 'vitest';
import {
  classifyToolError,
  toolErrorFingerprint,
  toolErrorSignalKey,
  toolErrorClassSqlCase,
  toolErrorFingerprintSqlCase,
  TOOL_ERROR_RULES,
  FINGERPRINTED_TOOL_ERROR_CLASSES,
  type ToolErrorClass,
} from './tool-error-classifier';
import { TOOL_ERROR_CORPUS } from './tool-error-corpus.fixture';

describe('classifyToolError — real-corpus regression (P-011)', () => {
  it.each(TOOL_ERROR_CORPUS.map((r) => [r.message.slice(0, 60), r] as const))(
    'classifies %s',
    (_label, row) => {
      expect(classifyToolError(row.errorCode, row.status, row.message)).toBe(row.expectedClass);
    },
  );

  it('the corpus exercises every class (so a regression in any branch is visible)', () => {
    const seen = new Set(TOOL_ERROR_CORPUS.map((r) => r.expectedClass));
    for (const c of ['structural', 'transient', 'caller', 'rate-limit'] as ToolErrorClass[]) {
      expect(seen.has(c)).toBe(true);
    }
  });

  it('REGRESSION GUARD: handler_error + an invalid_args: message classifies caller in BOTH paths (the drift that motivated P-011)', () => {
    // Old TS fn: structural (its error_code branch never checked the message
    // prefix). Old SQL: caller (LIKE 'invalid_args:%'). They MUST agree now.
    expect(classifyToolError('handler_error', 'error', 'invalid_args: note: Too big: expected string to have <=400 characters')).toBe('caller');
    expect(classifyToolError(null, 'error', 'invalid_args: note: Too big')).toBe('caller');
  });

  it('high-volume NON-structural buckets never leak into the auto-implement (structural) lane', () => {
    // The "floods a lane" failure mode: a timeout / provider-429 / PG-exhaustion /
    // caller-arg shape mis-filed as a deterministic tool bug.
    const mustNotBeStructural = TOOL_ERROR_CORPUS.filter((r) => r.expectedClass !== 'structural');
    for (const r of mustNotBeStructural) {
      expect(classifyToolError(r.errorCode, r.status, r.message)).not.toBe('structural');
    }
  });
});

describe('classifier rule table integrity', () => {
  it('every rule.messagePattern compiles as a JS RegExp (the cheap half of the dual-engine guarantee)', () => {
    for (const rule of TOOL_ERROR_RULES) {
      if (!rule.messagePattern) continue;
      expect(() => new RegExp(rule.messagePattern as string, 'i')).not.toThrow();
    }
  });

  it('patterns use only dual-engine constructs (no JS-only \\s \\d \\b or lookarounds)', () => {
    // POSIX ERE (Postgres ~*) has none of these; using them would let the two
    // engines disagree — the very drift this module prevents.
    for (const rule of TOOL_ERROR_RULES) {
      if (!rule.messagePattern) continue;
      expect(rule.messagePattern).not.toMatch(/\\[sdwbSDWB]|\(\?[=!<]/);
    }
  });

  it('no rule targets the structural fallback (structural is ELSE, never a WHEN)', () => {
    for (const rule of TOOL_ERROR_RULES) {
      expect(rule.class).not.toBe('structural');
    }
  });
});

describe('toolErrorFingerprint (P-012) — mirrors the SQL skeleton', () => {
  it('takes the first 6 alpha tokens, digit-stripped + punctuation-collapsed, joined with -', () => {
    expect(toolErrorFingerprint('invalid_args: note: Too big: expected string to have <=400 characters'))
      .toBe('invalid-args-note-too-big-expected');
    expect(toolErrorFingerprint('column "initiative" does not exist'))
      .toBe('column-initiative-does-not-exist');
  });

  it('returns null when the message has no alpha content', () => {
    expect(toolErrorFingerprint('')).toBeNull();
    expect(toolErrorFingerprint(null)).toBeNull();
    expect(toolErrorFingerprint('429 — 500 (#3)')).toBeNull();
  });

  it('separates two DISTINCT caller modes under one tool (the P-012 collision the structural-only fp left)', () => {
    const a = toolErrorFingerprint('invalid_args: note: Too big: expected string to have <=400 characters');
    const b = toolErrorFingerprint('invalid_args: status: Invalid option: expected one of "draft"|"ready"');
    expect(a).not.toBe(b);
    // …and the keys they produce differ, so they stop masking each other:
    expect(toolErrorSignalKey('plans:new', 'caller', a)).not.toBe(toolErrorSignalKey('plans:new', 'caller', b));
  });
});

describe('toolErrorSignalKey (P-012) — fingerprint by class', () => {
  it('appends the fingerprint for the fingerprinted classes', () => {
    expect(toolErrorSignalKey('memory:search', 'structural', 'cannot-read-properties-of-undefined'))
      .toBe('memory:search:structural:cannot-read-properties-of-undefined');
    expect(toolErrorSignalKey('plans:new', 'caller', 'invalid-args-note-too-big-expected'))
      .toBe('plans:new:caller:invalid-args-note-too-big-expected');
    expect(toolErrorSignalKey('slow:tool', 'transient', 'too-many-clients-already'))
      .toBe('slow:tool:transient:too-many-clients-already');
  });

  it('keeps rate-limit COARSE (one capacity concern — never fingerprinted)', () => {
    expect(FINGERPRINTED_TOOL_ERROR_CLASSES.has('rate-limit')).toBe(false);
    expect(toolErrorSignalKey('memory:search', 'rate-limit', 'openai-embed-failed-error-message-rate'))
      .toBe('memory:search:rate-limit');
  });

  it('falls back to the bare key when no fingerprint is derivable (legacy / pre-fingerprint ticks)', () => {
    expect(toolErrorSignalKey('docs:get', 'structural', null)).toBe('docs:get:structural');
    expect(toolErrorSignalKey('coord:thread', 'caller', undefined)).toBe('coord:thread:caller');
  });
});

describe('SQL generators are driven by the table (structural check; real-PG parity in the integration test)', () => {
  // A debug `sql` tag that renders the composed fragment to a string so we can
  // assert STRUCTURE without a database. Like postgres.js, a nested fragment
  // (already a rendered string) splices inline; arrays render as {a,b}; other
  // scalars splice inline too (we assert structure, not bind-param escaping).
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]): string =>
    strings.reduce((acc, s, i) => {
      if (i === 0) return s;
      const v = values[i - 1];
      const rendered = Array.isArray(v) ? `{${v.join(',')}}` : String(v);
      return acc + rendered + s;
    }, '');

  it('toolErrorClassSqlCase renders a CASE over every rule, ELSE structural', () => {
    const sqlCase = toolErrorClassSqlCase(fakeSql);
    expect(sqlCase).toMatch(/^CASE /);
    expect(sqlCase).toMatch(/ELSE structural END$/);
    // every non-structural class is a THEN target
    expect(sqlCase).toContain('THEN transient');
    expect(sqlCase).toContain('THEN caller');
    expect(sqlCase).toContain('THEN rate-limit');
    // the load-bearing patterns made it into the CASE
    expect(sqlCase).toContain('error_message ~*');
    expect(sqlCase).toContain('error_code = ANY');
    expect(sqlCase).toContain('exceeded timeout');
    expect(sqlCase).toContain('openai_embed_failed_429');
  });

  it('toolErrorFingerprintSqlCase fingerprints exactly the FINGERPRINTED classes', () => {
    const fpCase = toolErrorFingerprintSqlCase(fakeSql);
    expect(fpCase).toContain('class = ANY');
    expect(fpCase).toContain('structural');
    expect(fpCase).toContain('caller');
    expect(fpCase).toContain('transient');
    expect(fpCase).not.toContain('rate-limit'); // coarse — excluded
    expect(fpCase).toContain('regexp_replace'); // the skeleton arithmetic is present
  });
});
