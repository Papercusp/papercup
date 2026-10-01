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
  normalizeSuspectedToolFailure,
  toolFailureSignatureKey,
  matchKnownExternalToolFailure,
  KNOWN_EXTERNAL_TOOL_FAILURE_CLASSES,
  type ToolErrorClass,
} from './tool-error-classifier';
import { TOOL_ERROR_CORPUS } from './tool-error-corpus.fixture';
import { metadataToolFailure } from '../../agent-tools/plans/coordination-metadata-fixtures';

describe('P-001 R-7 frozen friction correlation controls', () => {
  it('replays the same report with stable identities but without an authority escalation', () => {
    const first = normalizeSuspectedToolFailure(metadataToolFailure);
    const replay = normalizeSuspectedToolFailure({ ...metadataToolFailure });
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      class: 'caller',
      direct: false,
      contractFingerprint: 'metadata-schema-v1~body',
      deployedRevision: 'metadata-runtime-v1',
    });
    expect(first.correlationFingerprint)
      .toContain('coord:send|invalid_args|metadata-schema-v1|body|metadata-runtime-v1|');
  });

  it.each([
    { schemaRevision: 'metadata-schema-v2' },
    { fieldPath: 'expects' },
    { runtimeVersion: 'metadata-runtime-v2' },
  ])('does not collapse a changed contract/runtime into the same lifecycle identity: %j', (change) => {
    const original = normalizeSuspectedToolFailure(metadataToolFailure);
    const changed = normalizeSuspectedToolFailure({ ...metadataToolFailure, ...change });
    expect(changed.classKey).not.toBe(original.classKey);
    expect(changed.correlationFingerprint).not.toBe(original.correlationFingerprint);
    // The watchdog's tool/class/message key intentionally has a narrower scope.
    expect(changed.watchdogKey).toBe(original.watchdogKey);
  });

  it('keeps missing dimensions explicit instead of claiming the known fixture contract', () => {
    const unknown = normalizeSuspectedToolFailure({
      toolName: metadataToolFailure.toolName,
      message: metadataToolFailure.message,
      errorCode: metadataToolFailure.errorCode,
    });
    expect(unknown.contractFingerprint).toBe('schema-unknown~field-unknown');
    expect(unknown.deployedRevision).toBe('runtime-unknown');
    expect(unknown.classKey).not.toBe(normalizeSuspectedToolFailure(metadataToolFailure).classKey);
  });

  it('does not collapse distinct error codes when contract and runtime metadata are unknown', () => {
    const saturated = normalizeSuspectedToolFailure({
      toolName: 'ptool',
      errorCode: '-32000',
      status: 'request shed',
      message: 'operator MCP admission is saturated — request shed; reason=loop_pressure_critical',
    });
    const malformed = normalizeSuspectedToolFailure({
      toolName: 'ptool',
      errorCode: 'invalid_json',
      status: 'rejected',
      message: 'malformed JSON before dispatch',
    });

    // Both are currently structural, but they are different failure modes. The
    // class-key arbiter must not coalesce the saturation report onto the malformed
    // JSON report merely because neither caller supplied schema/runtime metadata.
    expect(saturated.class).toBe('structural');
    expect(malformed.class).toBe('structural');
    expect(saturated.classKey).not.toBe(malformed.classKey);
    expect(saturated.watchdogKey).not.toBe(malformed.watchdogKey);
  });

  it('D-010: the filing signature ignores schema/runtime churn but keeps tool, family, error code and field', () => {
    const original = normalizeSuspectedToolFailure(metadataToolFailure);
    const signature = toolFailureSignatureKey(metadataToolFailure, original.class);
    expect(signature).toBe('tool-failure-signature:coord:send:caller:invalid_args:body');
    for (const change of [{ schemaRevision: 'metadata-schema-v2' }, { runtimeVersion: 'metadata-runtime-v2' }]) {
      const changed = normalizeSuspectedToolFailure({ ...metadataToolFailure, ...change });
      // The class (corroboration identity) moves; the filing signature does not.
      expect(changed.classKey).not.toBe(original.classKey);
      expect(toolFailureSignatureKey({ ...metadataToolFailure, ...change }, changed.class)).toBe(signature);
    }
    for (const change of [{ errorCode: 'timeout' }, { fieldPath: 'expects' }, { toolName: 'coord:inbox' }]) {
      expect(toolFailureSignatureKey({ ...metadataToolFailure, ...change }, original.class)).not.toBe(signature);
    }
    expect(toolFailureSignatureKey(metadataToolFailure, 'structural')).not.toBe(signature);
    expect(toolFailureSignatureKey({ toolName: 'ptool' }, 'structural'))
      .toBe('tool-failure-signature:ptool:structural:error-code-unknown:field-unknown');
  });

  it('a repeated caller rejection does not become direct evidence through legacy booleans', () => {
    expect(normalizeSuspectedToolFailure({
      ...metadataToolFailure, reproduced: true, clearServerMismatch: true, hardInternal: true,
    })).toMatchObject({ class: 'caller', direct: false });
  });
});

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

  it('classifies a nested tools:invoke invalid_input wrapper as caller, not structural', () => {
    // tools:invoke re-throws target refusals; the wrapper adds `invalid_input:`
    // while outer telemetry can record `handler_error`, so match this exact shape.
    expect(
      classifyToolError('handler_error', 'error', 'invalid_input: invalid_args: Unrecognized key: "workspace"'),
    ).toBe('caller');
    // Keep the prefix rule narrow: unrelated invalid_input messages remain structural.
    expect(classifyToolError('handler_error', 'error', 'invalid_input: database constraint failed')).toBe('structural');
  });

  it('classifies the nested tools:invoke checkpoint replacement safety refusal as caller', () => {
    // Live rows keep the nested { ok:false, error, errorCode } refusal as JSON
    // in error_message, while the wrapper records error_code='handler_error'.
    const nestedRefusal =
      '{"ok":false,"error":"checkpoint_replace_would_drop_rows","errorCode":"checkpoint_replace_would_drop_rows","retryable":true}';
    expect(classifyToolError('handler_error', 'error', nestedRefusal)).toBe('caller');
    expect(classifyToolError('checkpoint_replace_would_drop_rows', 'error', null)).toBe('caller');
    expect(classifyToolError('handler_error', 'error', '{"ok":false,"error":"unrelated_refusal"}')).toBe('structural');
  });

  it('classifies a missing sandbox desktop lease as caller input, not a structural tool bug', () => {
    expect(
      classifyToolError(
        'handler_error',
        'error',
        'capability:computer — no sandbox desktop is leased to this agent. A desktop must be provisioned first',
      ),
    ).toBe('caller');
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

describe('normalizeSuspectedToolFailure — correlated probation identity (P-013)', () => {
  it('shares the watchdog key while retaining schema/field/runtime dimensions in the reporter fingerprint', () => {
    const a = normalizeSuspectedToolFailure({
      toolName: 'coord:send',
      errorCode: 'invalid_args',
      status: 'error',
      message: 'invalid_args: body must be an array',
      schemaRevision: '42',
      fieldPath: 'body',
      runtimeVersion: 'codex-1.2.3',
    });
    const b = normalizeSuspectedToolFailure({
      toolName: 'coord:send',
      errorCode: 'invalid_args',
      status: 'error',
      message: 'invalid_args: body must be an array',
      schemaRevision: '43',
      fieldPath: 'body',
      runtimeVersion: 'codex-1.2.4',
    });
    expect(a.watchdogKey).toBe(b.watchdogKey);
    expect(a.watchdogKey).toMatch(/^repeated-tool-error:coord:send:caller:/);
    expect(a.correlationFingerprint).not.toBe(b.correlationFingerprint);
    expect(a.direct).toBe(false);
  });

  it.each(['reproduced', 'clearServerMismatch', 'hardInternal'] as const)(
    'bypasses probation only on explicit %s evidence',
    (field) => {
      const normalized = normalizeSuspectedToolFailure({
        toolName: 'work_items:complete',
        message: 'terminal writer rejected a valid state',
        [field]: true,
      });
      expect(normalized.direct).toBe(true);
    },
  );

  it.each(['reproduced', 'clearServerMismatch', 'hardInternal'] as const)(
    'keeps a caller-input failure in probation when only legacy %s is supplied (EI-22142216567407511)',
    (field) => {
      const normalized = normalizeSuspectedToolFailure({
        toolName: 'sessions:read',
        errorCode: 'invalid_args',
        message: 'invalid_args: tail too big — 20 over the 200 limit; use 200',
        [field]: true,
      });
      expect(normalized.class).toBe('caller');
      expect(normalized.direct).toBe(false);
    },
  );

  it('lets inspectable expected/actual evidence override a caller classification', () => {
    const normalized = normalizeSuspectedToolFailure({
      toolName: 'sessions:read',
      errorCode: 'invalid_args',
      message: 'invalid_args: documented tail=220 rejected as greater than 200',
      directEvidence: {
        kind: 'server-contract-mismatch',
        expected: 'the active schema documents tail <= 220',
        actual: 'the server rejected tail=220 against a hidden maximum of 200',
      },
    });
    expect(normalized.class).toBe('caller');
    expect(normalized.direct).toBe(true);
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

describe('known-external tool-failure classes — deny the direct bypass for an already-adjudicated class (WI-2143658)', () => {
  // Every string below is REAL reporter prose, taken from the measured
  // population of filed rows (2026-09-03). That matters: the defect being
  // guarded is that these all describe ONE failure while producing different
  // dedup identities, so hand-invented prose would not exercise it.
  const REAL_RACE_REPORTS = [
    'Failed to create unified exec process: No such file or directory (os error 2)',
    'CreateProcess rejected: Failed to create unified exec process: No such file or directory (os error 2) on a second independent loop:checkpoint invocation',
    'exec_command intermittently fails to create the unified shell',
    'unified exec could not create process',
    'unified exec process rejected with no such file',
    'CreateProcess message rejected: failed to create unified exec process',
  ];

  it.each(REAL_RACE_REPORTS)('recognises the documented Codex race: %s', (message) => {
    const matched = matchKnownExternalToolFailure({ toolName: 'exec_command', message });
    expect(matched?.id).toBe('codex-exec-command-parallel-launch-race');
  });

  it.each(REAL_RACE_REPORTS)('denies the direct bypass even when the reporter attests reproduction: %s', (message) => {
    const normalized = normalizeSuspectedToolFailure({
      toolName: 'exec_command',
      errorCode: 'CreateProcess',
      message,
      // The honest attestation that was minting claimable duplicates.
      reproduced: true,
    });
    expect(normalized.direct).toBe(false);
    expect(normalized.knownExternal?.docSlug).toBe('agent-insights/codex-exec-command-parallel-launch-race');
  });

  it.each(['clearServerMismatch', 'hardInternal'] as const)(
    'denies the bypass for the other direct-evidence flag %s too (all three routes, not just reproduced)',
    (field) => {
      const normalized = normalizeSuspectedToolFailure({
        toolName: 'exec_command',
        message: 'Failed to create unified exec process: No such file or directory (os error 2)',
        [field]: true,
      });
      expect(normalized.direct).toBe(false);
    },
  );

  // ── CONTROLS. A false match hides a real defect inside a row triage has been
  // told to ignore, so the over-match guards matter more than the matches.

  it.each([
    'CreateProcess failed because the supplied workdir does not exist',
    'caller misspelled the workspace path as papercuspai-workspace',
    'CreateProcess rejected nonexistent workdir /nonexistent/workspace/path',
    'exec_command rejected the working directory path typo before command execution',
  ])('does NOT match the separate mistyped-workdir class, which has a different fix: %s', (message) => {
    expect(matchKnownExternalToolFailure({ toolName: 'exec_command', message })).toBeNull();
    const normalized = normalizeSuspectedToolFailure({ toolName: 'exec_command', message, reproduced: true });
    // Unchanged behaviour: a real, attested, fixable report stays claimable.
    expect(normalized.direct).toBe(true);
    expect(normalized.knownExternal).toBeNull();
  });

  it('prefers a MISS when a race report also mentions a workdir — the exclude is deliberately conservative', () => {
    // Documented intent, not an accident: this falls back to today's behaviour
    // rather than risk suppressing a report that may be the workdir class.
    const message = 'Failed to create unified exec process, though the workdir was valid';
    expect(matchKnownExternalToolFailure({ toolName: 'exec_command', message })).toBeNull();
  });

  it('is gated on the tool name — identical prose about a PAPERCUSP tool is never suppressed', () => {
    const message = 'Failed to create unified exec process: No such file or directory (os error 2)';
    expect(matchKnownExternalToolFailure({ toolName: 'capability:bash', message })).toBeNull();
    const normalized = normalizeSuspectedToolFailure({ toolName: 'capability:bash', message, reproduced: true });
    expect(normalized.direct).toBe(true);
  });

  it('leaves an unrelated tool failure completely untouched', () => {
    const normalized = normalizeSuspectedToolFailure({
      toolName: 'work_items:complete',
      message: 'terminal writer rejected a valid state',
      reproduced: true,
    });
    expect(normalized.direct).toBe(true);
    expect(normalized.knownExternal).toBeNull();
  });

  it('does not disturb the dedup identity it sits beside (watchdogKey/fingerprint unchanged)', () => {
    const message = 'Failed to create unified exec process: No such file or directory (os error 2)';
    const normalized = normalizeSuspectedToolFailure({ toolName: 'exec_command', errorCode: 'CreateProcess', message });
    expect(normalized.watchdogKey).toBe(
      `repeated-tool-error:${toolErrorSignalKey('exec_command', normalized.class, normalized.messageFingerprint)}`,
    );
  });

  it('fails OPEN on empty input rather than throwing inside a filing', () => {
    expect(matchKnownExternalToolFailure({ toolName: '', message: '' })).toBeNull();
    expect(matchKnownExternalToolFailure({ toolName: 'exec_command', message: '' })).toBeNull();
  });

  it('every registered pattern compiles (this module\'s dual-engine convention)', () => {
    expect(KNOWN_EXTERNAL_TOOL_FAILURE_CLASSES.length).toBeGreaterThan(0);
    for (const klass of KNOWN_EXTERNAL_TOOL_FAILURE_CLASSES) {
      expect(() => new RegExp(klass.match, 'i')).not.toThrow();
      if (klass.exclude) expect(() => new RegExp(klass.exclude as string, 'i')).not.toThrow();
      expect(klass.toolNames.every((name) => name === name.toLowerCase())).toBe(true);
      expect(klass.docSlug).toMatch(/^agent-insights\//);
    }
  });
});
