/**
 * host-benign-errors.test.ts — the EI-714 / EI-12 host-survival classification.
 *
 * These predicates decide whether the hono-host process-level guards SWALLOW an
 * error (log, keep serving) or FAIL FAST (exit). Getting them wrong either way
 * is severe: too narrow → one malformed frame downs :3070 for the whole fleet
 * (EI-714); too broad → a real host bug is silently swallowed. So the boundary
 * is pinned here.
 */

import { describe, expect, it } from 'vitest';
import {
  isBenignFileWatcherError,
  isBenignHostError,
  isBenignRequestParse,
  isBenignStreamClose,
  isTransientPgConnectionError,
} from './host-benign-errors';

/** The inotify watch-exhaustion error Node throws from chokidar/fs.watch when the
 *  kernel file-watcher budget is full (EI-3385 — crash-looped :3070 at 32 workers).
 *  `via` picks how it's recognizable: 'syscall' sets syscall='watch' (no message
 *  match needed), 'message' relies on the message text only. */
function watcherEnospc(via: 'syscall' | 'message' = 'syscall'): Error {
  const e = Object.assign(
    new Error("ENOSPC: System limit for number of file watchers reached, watch '/home/x/.papercusp/.../.claude.json.lock'"),
    { code: 'ENOSPC', errno: -28 },
  );
  if (via === 'syscall') (e as { syscall?: string }).syscall = 'watch';
  return e;
}

/** A genuine DISK-FULL ENOSPC — same code, but syscall 'write' + "no space left on
 *  device". This is a real fatal condition and must NOT be swallowed. */
function diskFullEnospc(): Error {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), {
    code: 'ENOSPC',
    errno: -28,
    syscall: 'write',
  });
}

/** Build the exact postgres-js null-socket-write TypeError that crash-looped
 *  :3070 (2026-06-18): the message Node throws + a stack inside postgres-js's
 *  connection module. `variant` selects the module path: 'esm' →
 *  `postgres/src/connection.js`, 'cjs' → `postgres/cjs/src/connection.js`.
 *  The REAL incident stack (EI-1405) was the CJS path under papercup-release;
 *  both must classify benign or the green-operator crash path regresses. */
function pgNullWriteError(variant: 'esm' | 'cjs' = 'esm'): TypeError {
  const e = new TypeError("Cannot read properties of null (reading 'write')");
  const modulePath =
    variant === 'cjs'
      ? 'file:///home/x/papercup-release/node_modules/postgres/cjs/src/connection.js:255:22'
      : 'file:///home/x/papercup-release/node_modules/postgres/src/connection.js:255:22';
  e.stack = [
    "TypeError: Cannot read properties of null (reading 'write')",
    `    at Immediate.nextWrite (${modulePath})`,
    '    at process.processImmediate (node:internal/timers:504:21)',
  ].join('\n');
  return e;
}

/** Produce a REAL JSON.parse SyntaxError (not a hand-built one) so the message
 *  matched is exactly what Node throws on the wire. */
function realJsonParseError(bad: string): unknown {
  try {
    JSON.parse(bad);
  } catch (e) {
    return e;
  }
  throw new Error('expected JSON.parse to throw');
}

describe('isBenignRequestParse (EI-714 — malformed JSON-RPC body must not crash the host)', () => {
  it('classifies the exact EI-714 repro body (stray trailing brace) as benign', () => {
    // The body from the issue: a valid object followed by an extra `}`.
    const e = realJsonParseError(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"papercusp:list_workspaces","arguments":{}}}}',
    );
    expect(e).toBeInstanceOf(SyntaxError);
    expect(isBenignRequestParse(e)).toBe(true);
  });

  it('classifies every common JSON.parse failure shape as benign', () => {
    for (const bad of ['{bad', '', '{"a":}', '[1,2,', 'not json at all', '{"a":1}trailing']) {
      expect(isBenignRequestParse(realJsonParseError(bad)), `for input ${JSON.stringify(bad)}`).toBe(true);
    }
  });

  it('does NOT classify a non-SyntaxError as a benign parse error', () => {
    expect(isBenignRequestParse(new TypeError('cannot read x of undefined'))).toBe(false);
    expect(isBenignRequestParse(new Error('boom'))).toBe(false);
    expect(isBenignRequestParse(new RangeError('out of range'))).toBe(false);
    expect(isBenignRequestParse(null)).toBe(false);
    expect(isBenignRequestParse('a string')).toBe(false);
  });

  it('does NOT classify a non-JSON SyntaxError as benign (real code bugs still surface)', () => {
    // A SyntaxError whose message is unrelated to JSON parsing — e.g. a bad
    // regex/dynamic eval — must stay fatal so a genuine bug isn't masked.
    expect(isBenignRequestParse(new SyntaxError('Invalid regular expression: missing /'))).toBe(false);
  });
});

describe('isBenignStreamClose (EI-12 — mid-stream client disconnect must not crash the host)', () => {
  it('classifies the already-closed-controller class as benign', () => {
    const byCode = Object.assign(new Error('whatever'), { code: 'ERR_INVALID_STATE' });
    expect(isBenignStreamClose(byCode)).toBe(true);
    expect(isBenignStreamClose(new Error('Controller is already closed'))).toBe(true);
  });

  it('does NOT classify unrelated errors as a stream close', () => {
    expect(isBenignStreamClose(new Error('database connection lost'))).toBe(false);
    expect(isBenignStreamClose(null)).toBe(false);
  });
});

describe('isTransientPgConnectionError (2026-06-18 — torn-down PG connection must not crash-loop the host)', () => {
  it('classifies the exact postgres-js null-socket-write crash as transient', () => {
    expect(isTransientPgConnectionError(pgNullWriteError())).toBe(true);
  });

  it('classifies the REAL EI-1405 incident stack (CJS path: postgres/cjs/src/connection.js) as transient', () => {
    // The actual :3070 crash-loop stack was the bundled CJS path, NOT the ESM
    // one — `papercup-release/node_modules/postgres/cjs/src/connection.js:255`.
    // The classifier's regex tolerates the optional `cjs/` segment; pin it here
    // so a future regex "simplification" that drops `cjs` support can't silently
    // re-open the green-operator crash path.
    expect(isTransientPgConnectionError(pgNullWriteError('cjs'))).toBe(true);
  });

  it('classifies postgres-js CONNECTION_CLOSED (code or message) as transient', () => {
    expect(isTransientPgConnectionError(Object.assign(new Error('x'), { code: 'CONNECTION_CLOSED' }))).toBe(true);
    expect(isTransientPgConnectionError(new Error('write CONNECTION_CLOSED localhost:5432'))).toBe(true);
  });

  it('does NOT swallow a null-`write` TypeError from OUTSIDE postgres-js (real bugs still fail fast)', () => {
    // Same message, but the stack is in our own code — must stay fatal so a genuine
    // null-deref isn't masked.
    const e = new TypeError("Cannot read properties of null (reading 'write')");
    e.stack = "TypeError: ...\n    at writeThing (file:///app/packages/operator-core/lib/foo.ts:10:5)";
    expect(isTransientPgConnectionError(e)).toBe(false);
  });

  it('does NOT swallow unrelated errors', () => {
    expect(isTransientPgConnectionError(new TypeError("Cannot read properties of undefined (reading 'foo')"))).toBe(false);
    expect(isTransientPgConnectionError(new Error('boom'))).toBe(false);
    expect(isTransientPgConnectionError(null)).toBe(false);
  });
});

describe('isBenignFileWatcherError (EI-3385 — inotify exhaustion must not crash-loop the host)', () => {
  it('classifies inotify watch-ENOSPC as benign (by syscall and by message)', () => {
    expect(isBenignFileWatcherError(watcherEnospc('syscall'))).toBe(true);
    expect(isBenignFileWatcherError(watcherEnospc('message'))).toBe(true);
  });

  it('does NOT swallow a genuine disk-full ENOSPC (real fatal condition stays fatal)', () => {
    // Same ENOSPC code, but syscall 'write' + "no space left on device" — must fail fast.
    expect(isBenignFileWatcherError(diskFullEnospc())).toBe(false);
  });

  it('does NOT swallow unrelated errors', () => {
    expect(isBenignFileWatcherError(Object.assign(new Error('x'), { code: 'EACCES', syscall: 'watch' }))).toBe(false);
    expect(isBenignFileWatcherError(new Error('boom'))).toBe(false);
    expect(isBenignFileWatcherError(null)).toBe(false);
  });
});

describe('isBenignHostError (the combined fail-fast boundary)', () => {
  it('is true for every benign class', () => {
    expect(isBenignHostError(realJsonParseError('{bad'))).toBe(true);
    expect(isBenignHostError(Object.assign(new Error('x'), { code: 'ERR_INVALID_STATE' }))).toBe(true);
    expect(isBenignHostError(pgNullWriteError('cjs'))).toBe(true); // the 2026-06-18 (EI-1405) crash-loop fix — real incident CJS stack
    expect(isBenignHostError(watcherEnospc())).toBe(true); // EI-3385 — inotify exhaustion
  });

  it('is FALSE for a real host bug — the guard must still exit on these', () => {
    expect(isBenignHostError(new TypeError("Cannot read properties of undefined (reading 'foo')"))).toBe(false);
    expect(isBenignHostError(new Error('PG pool exhausted'))).toBe(false);
    expect(isBenignHostError(new RangeError('Maximum call stack size exceeded'))).toBe(false);
    expect(isBenignHostError(diskFullEnospc())).toBe(false); // disk-full is real — must still exit
  });
});
