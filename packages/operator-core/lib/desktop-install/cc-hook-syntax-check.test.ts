/**
 * EI-21974793277035753 — a CC hook must PARSE before it becomes visible fleet-wide.
 *
 * The atomic-rename discipline (EI-18755593630003816) guarantees a concurrent reader sees
 * a WHOLE file rather than a torn prefix. It says nothing about whether that whole file is
 * VALID. `installClaudeHooks` publishes into one machine-wide dir that every agent session
 * on the box executes from, so an unparseable hook fails inside other agents' turns — and
 * `pretooluse-bash-resource-gate.sh` is fail-open by construction, so a broken copy of THAT
 * one does not crash and does not deny: it silently stops gating, with nothing in any log.
 *
 * These tests carry their own positive controls. A checker that answered `ok` to everything
 * would satisfy every "accepts" case here, so each interpreter is also shown REJECTING real
 * broken input — that pairing is what makes the guard falsifiable.
 */
import { describe, it, expect } from 'vitest';
import { checkHookSyntax } from './papercusp-files';

/** The call site hands over the exact bytes it is about to install. So do these tests. */
const src = (body: string) => Buffer.from(body, 'utf8');

describe('checkHookSyntax — bash', () => {
  it('accepts a valid hook', async () => {
    expect(await checkHookSyntax(src('#!/bin/bash\nset -euo pipefail\necho hello\n'), 'ok.sh')).toEqual({
      ok: true,
    });
  });

  it('rejects a TRUNCATED hook — the torn-script class atomicity cannot catch', async () => {
    // Exactly the shape observed live in EI-18755593630003816: a body cut off mid-file, so
    // the parser runs off the end. rename(2) would have published this happily.
    const v = await checkHookSyntax(src('#!/bin/bash\nif true; then\n  echo half\n'), 'torn.sh');
    expect(v.ok).toBe(false);
    // Assert on the parser's own words, not merely on non-zero: this is what distinguishes
    // "bash read it and refused it" from "bash never ran", which would otherwise look alike.
    if (!v.ok) expect(v.detail).toMatch(/unexpected end of file|syntax error/i);
  });

  it('rejects an outright syntax error', async () => {
    expect((await checkHookSyntax(src('#!/bin/bash\nfor ((; do\n'), 'bad.sh')).ok).toBe(false);
  });
});

describe('checkHookSyntax — mjs', () => {
  /**
   * REGRESSION (caught by inject-hooks-provenance.test.ts, not by this file's first draft).
   *
   * The checker originally took a PATH and ran `node --check <path>`. At the call site that
   * path is the staged copy, named `<hook>.psu-install.<pid>.tmp` — and node infers module
   * format from the extension, so it threw ERR_UNKNOWN_FILE_EXTENSION on every `.mjs` hook
   * regardless of content. That would have refused all 24 `.mjs` hooks on every install,
   * silently freezing them at their installed versions: precisely the "hooks stop updating
   * fleet-wide" failure this work exists to prevent, introduced by the fix for it.
   *
   * The first draft of this file missed it by passing a correctly-named `foo.mjs`, i.e. by
   * testing something the call site never does. Taking bytes instead of a path removes the
   * discrepancy structurally — there is no longer a filename for the test and the call site
   * to disagree about.
   */
  it('accepts a valid ESM hook regardless of how the staged file is named', async () => {
    const body = src('export const run = () => 1;\nawait Promise.resolve();\n');
    expect(await checkHookSyntax(body, 'posttooluse-guard.mjs')).toEqual({ ok: true });
  });

  it('rejects an unparseable ESM hook', async () => {
    expect((await checkHookSyntax(src('export const run = (=> {\n'), 'bad.mjs')).ok).toBe(false);
  });

  it('accepts top-level await, which is only legal when parsed as a module', async () => {
    // Guards the --input-type=module flag: dropped, this parses as CommonJS and fails,
    // so the flag cannot silently rot.
    expect(await checkHookSyntax(src('await Promise.resolve(1);\n'), 'tla.mjs')).toEqual({ ok: true });
  });
});

describe('checkHookSyntax — python', () => {
  it('accepts a valid module', async () => {
    expect(await checkHookSyntax(src('def handle(x):\n    return x + 1\n'), 'mcp_response.py')).toEqual(
      { ok: true },
    );
  });

  it('rejects an unparseable module', async () => {
    expect((await checkHookSyntax(src('def handle(:\n'), 'pc_tty.py')).ok).toBe(false);
  });
});

describe('checkHookSyntax — what is deliberately NOT validated', () => {
  it('passes a .d.mts declaration through unchecked (node --check cannot parse TS)', async () => {
    // Validating these with a JS parser would reject perfectly good declarations and block
    // the install — worse than not checking. Better unvalidated than validated wrongly.
    expect(await checkHookSyntax(src('export declare const x: number;\n'), 'guard.d.mts')).toEqual({
      ok: true,
    });
  });

  it('passes an unrecognized extension through unchecked', async () => {
    expect(await checkHookSyntax(src('this is not a program at all\n'), 'notes.txt')).toEqual({
      ok: true,
    });
  });
});

describe('checkHookSyntax — fail-safe posture', () => {
  it('does NOT condemn a hook when the interpreter cannot be spawned', async () => {
    // The verdict must mean "this definitely does not parse", never "I could not tell".
    // A missing interpreter read as a syntax error would refuse to install working hooks
    // and turn a diagnostic into an outage. Simulated by emptying PATH for the call.
    const realPath = process.env.PATH;
    process.env.PATH = '/nonexistent-bin-dir-for-this-test';
    try {
      expect(await checkHookSyntax(src('#!/bin/bash\necho hello\n'), 'ok.sh')).toEqual({ ok: true });
    } finally {
      process.env.PATH = realPath;
    }
  });

  it('still condemns genuinely broken input once the interpreter IS available', async () => {
    // The calibration for the case above: without this, a checker that always answered
    // "ok" would pass the fail-safe test and look correct.
    expect((await checkHookSyntax(src('#!/bin/bash\nif true; then\n'), 'torn.sh')).ok).toBe(false);
  });
});
