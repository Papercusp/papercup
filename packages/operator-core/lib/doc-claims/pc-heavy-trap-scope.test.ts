/**
 * EI-21348799817176368 recurrence guard: pc-heavy.sh's trap-reachable cleanup
 * handlers must not read an enclosing-function `local` undefended.
 *
 * pc-heavy.sh runs `set -uo pipefail`, and registers EXIT/TERM/INT/HUP traps whose
 * handlers are nested functions reading `local`s of `_pc_heavy_internal_preempt_run`.
 * Bash locals are DYNAMICALLY scoped, so a trap that fires outside that function's
 * extent finds them unset — and `set -u` then kills the CLEANUP HANDLER itself,
 * leaking the very workload process group the handler exists to reap. Observed
 * live at load1=109: `pc-heavy.sh: line 277: _preempt_child_pid: unbound variable`.
 *
 * `"${x:-}"` is byte-identical to `"$x"` whenever x is set, so defaulting is inert
 * on the normal path — which is exactly why it is easy to "clean up" later by
 * someone who reads the `:-` as noise. Hence this guard.
 *
 * SCOPE IS DELIBERATE: only the three handlers reachable from a trap are judged.
 * `_preempt_notify` and `_preempt_leader_alive` run solely from the main loop,
 * where the locals are always in scope, and their bare expansions are correct.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PC_HEAVY = join(ROOT, 'scripts/pc-heavy.sh');

/** Handlers named by `trap '<handler> …' EXIT|TERM|INT|HUP`, plus what they call. */
const TRAP_REACHABLE = ['_preempt_group_alive', '_preempt_reap_group', '_preempt_forward_signal'];

/** Extract a shell function body by brace matching from `name() {`. */
export function shellFunctionBody(source: string, name: string): string | null {
  const start = source.search(new RegExp(`^\\s*${name}\\s*\\(\\)\\s*\\{`, 'm'));
  if (start < 0) return null;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/** Every `$_preempt_x` / `${_preempt_x}` expansion lacking a `:-` default. */
export function undefendedExpansions(body: string): string[] {
  const stripped = body.replace(/^\s*#.*$/gm, '');
  const found: string[] = [];
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const braced = m[1];
    const bare = m[3];
    if (braced && braced.startsWith('_preempt_') && !m[2]) found.push(m[0]);
    if (bare && bare.startsWith('_preempt_')) found.push(m[0]);
  }
  return found;
}

describe('pc-heavy trap-scope guard — fixture controls (the detector must be able to FAIL)', () => {
  it('catches a bare braced expansion', () => {
    expect(undefendedExpansions('kill -TERM -- "-${_preempt_child_pid}"')).toEqual([
      '${_preempt_child_pid}',
    ]);
  });

  it('catches a bare unbraced expansion — the exact shape that crashed', () => {
    expect(undefendedExpansions('[ -n "$_preempt_child_pid" ]')).toEqual(['$_preempt_child_pid']);
  });

  it('accepts a defaulted expansion', () => {
    expect(undefendedExpansions('kill -0 -- "-${_preempt_child_pid:-}"')).toEqual([]);
    expect(undefendedExpansions('sleep "${_preempt_poll:-0.1}"')).toEqual([]);
  });

  it('ignores commented-out code', () => {
    expect(undefendedExpansions('  # kill -- "-${_preempt_child_pid}"')).toEqual([]);
  });

  it('brace-matches a function body without swallowing the rest of the file', () => {
    const src = 'a() {\n  if x; then y; fi\n}\nb() {\n  ZZZ\n}\n';
    expect(shellFunctionBody(src, 'a')).toContain('if x');
    expect(shellFunctionBody(src, 'a')).not.toContain('ZZZ');
  });
});

describe('pc-heavy trap-scope guard — live source', () => {
  const source = readFileSync(PC_HEAVY, 'utf8');

  it('still runs under set -u (the precondition that makes this fatal)', () => {
    expect(source).toMatch(/^set -u[a-z]*o? ?[a-z]*$/m);
  });

  it.each(TRAP_REACHABLE)('%s defends every _preempt_ expansion', (name) => {
    const body = shellFunctionBody(source, name);
    // A null body means the function was renamed or removed — that is a real
    // finding about this guard's subject, not a reason to silently pass.
    expect(body, `${name} not found in pc-heavy.sh — guard subject moved`).not.toBeNull();
    expect(undefendedExpansions(body as string)).toEqual([]);
  });

  it('those handlers are still the ones the traps actually register', () => {
    // If a new handler is trapped, TRAP_REACHABLE above must grow with it.
    // The quoted body must be LINE-BOUNDED: `[^']+` spanning newlines lets the
    // `trap '' PIPE` on line 221 pair its quote with a later trap's, yielding a
    // phantom empty handler. (Caught by this guard's own first run.)
    const trapped = [...source.matchAll(/^\s*trap\s+'([^'\n]*)'\s+(EXIT|TERM|INT|HUP)/gm)]
      .map((m) => m[1].trim().split(/\s+/)[0])
      // `trap '' SIG` is "ignore this signal" — no handler body to judge.
      .filter((h) => h !== '');
    expect(trapped.length).toBeGreaterThan(0);
    for (const handler of new Set(trapped)) expect(TRAP_REACHABLE).toContain(handler);
  });
});
