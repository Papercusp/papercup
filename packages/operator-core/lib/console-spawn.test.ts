/**
 * Coverage for console-spawn.buildConsoleOneliner — the one-liner that the
 * spawned terminal runs as its first command. This is the mechanism behind
 * capability:terminal: the `greeting` is the caller's arbitrary command, and it
 * must (a) run in a subshell, (b) survive shell-quoting verbatim, then (c) hand
 * off to an interactive login shell so the window stays open.
 */
import { describe, expect, it } from 'vitest';
import {
  buildConsoleOneliner,
  advSessionTitleTag,
  macConsoleInvocation,
  type AppearanceOpts,
} from './console-spawn';

const APPEARANCE: AppearanceOpts = { mode: 'console', planSlug: null, label: null };

describe('buildConsoleOneliner', () => {
  it('cds, runs the greeting in a subshell, then execs an interactive login shell', () => {
    const out = buildConsoleOneliner('/proj', {}, 'npm run dev', APPEARANCE);
    expect(out).toContain("cd '/proj'");
    expect(out).toContain('(npm run dev)');
    expect(out).toContain('exec "${SHELL:-/bin/bash}" -l');
  });

  it('always drops to the shell after the greeting (`;` not `&&`) so a failing command keeps the window open', () => {
    const out = buildConsoleOneliner('/x', {}, 'false', APPEARANCE);
    // `) ; exec` — the post-greeting separator must be ';' so exit-non-zero
    // does not short-circuit the interactive shell (matches native_console.rs).
    expect(out).toContain(') ; exec "${SHELL:-/bin/bash}" -l');
    expect(out).not.toContain(') && exec');
  });

  it('drops the sentinel + EXIT trap so the desktop side can detect shell exit', () => {
    const out = buildConsoleOneliner('/x', {}, 'true', APPEARANCE);
    expect(out).toContain('touch .papercup-console-active.$');
    expect(out).toContain("trap 'rm -f .papercup-console-active.$' EXIT");
  });

  it('single-quote-escapes a command containing quotes (no breakout)', () => {
    const out = buildConsoleOneliner('/x', {}, "echo 'hi there'", APPEARANCE);
    // each embedded ' becomes '\'' so the whole command survives bash -lc '…'
    expect(out).toContain("(echo '\\''hi there'\\'')");
  });

  it('preserves pipes / redirects / && in the arbitrary command', () => {
    const cmd = 'grep -r foo . | tee out.log && echo done';
    const out = buildConsoleOneliner('/x', {}, cmd, APPEARANCE);
    expect(out).toContain(`(${cmd})`);
  });

  it('exports env vars with valid bash names and skips invalid ones', () => {
    const out = buildConsoleOneliner('/x', { GOOD_NAME: 'v', '1BAD': 'nope', 'BAD-DASH': 'nope' }, 'true', APPEARANCE);
    expect(out).toContain("export GOOD_NAME='v'");
    expect(out).not.toContain('1BAD');
    expect(out).not.toContain('BAD-DASH');
  });

  it('prepends PAPERCUSP_BIN_DIR ahead of PAPERCUSP_SCRIPTS_DIR on PATH', () => {
    const out = buildConsoleOneliner(
      '/x',
      { PAPERCUSP_BIN_DIR: '/home/u/.papercusp/bin', PAPERCUSP_SCRIPTS_DIR: '/bundle/scripts' },
      'true',
      APPEARANCE,
    );
    expect(out).toContain("export PATH='/home/u/.papercusp/bin':'/bundle/scripts':${PATH}");
  });

  it('emits the OSC window-title prelude', () => {
    const out = buildConsoleOneliner('/x', {}, 'true', { mode: 'console', planSlug: null, label: 'my run' });
    expect(out).toContain('printf');
    expect(out).toContain('my run');
  });
});

describe('advSessionTitleTag', () => {
  it('formats a present id and elides a missing one', () => {
    expect(advSessionTitleTag(42)).toBe('[adv:42]');
    expect(advSessionTitleTag(null)).toBe('');
    expect(advSessionTitleTag(undefined)).toBe('');
  });
});

describe('fleet color scheme (AppearanceOpts.scheme)', () => {
  const SCHEME = { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' };

  it('a bound scheme drives fg (OSC 10), bg (OSC 11) and cursor (OSC 12) — overriding the plan hash', () => {
    const out = buildConsoleOneliner('/x', {}, 'true', {
      mode: 'console',
      planSlug: 'some-plan',
      label: null,
      scheme: SCHEME,
    });
    expect(out).toContain("printf '\\033]10;#f5e8ff\\007'");
    expect(out).toContain("printf '\\033]11;#581c87\\007'");
    expect(out).toContain("printf '\\033]12;#d8b4fe\\007'");
  });

  it('without a scheme: no cursor OSC, and bg falls back to the per-plan hash', () => {
    const out = buildConsoleOneliner('/x', {}, 'true', { mode: 'console', planSlug: null, label: null });
    expect(out).not.toContain('\\033]12;'); // no cursor sequence
    expect(out).toContain("printf '\\033]11;#1e1b4b\\007'"); // console null-slug fallback
  });
});

describe('macConsoleInvocation (operator-direct macOS spawn — approach C)', () => {
  const baseOpts = { tmpDir: '/tmp', nowMs: 1234, pid: 999, hasITerm: false };

  it('writes a one-shot .command that self-deletes then execs the login-shell one-liner', () => {
    const oneliner = buildConsoleOneliner('/proj', {}, 'npm run dev', APPEARANCE);
    const inv = macConsoleInvocation(oneliner, baseOpts);
    expect(inv.content).toMatch(/^#!\/bin\/bash\n/);
    expect(inv.content).toContain('rm -f "$0"'); // self-delete so /tmp doesn't accrete one-shots
    expect(inv.content).toContain('exec bash -lc');
    expect(inv.content).toContain('(npm run dev)'); // the full one-liner is carried verbatim
  });

  it('names a fresh .command per pid+timestamp under tmpDir', () => {
    const inv = macConsoleInvocation('true', { ...baseOpts, tmpDir: '/var/folders/x', nowMs: 42, pid: 7 });
    expect(inv.file).toBe('/var/folders/x/papercup-console-7-42.command');
  });

  it('opens a FRESH instance (open -na) so every call is a new window', () => {
    const inv = macConsoleInvocation('true', baseOpts);
    expect(inv.openArgs).toEqual(['-na', 'Terminal.app', inv.file]);
  });

  it('prefers iTerm when installed, else Terminal.app', () => {
    expect(macConsoleInvocation('true', { ...baseOpts, hasITerm: true }).term).toBe('iTerm.app');
    expect(macConsoleInvocation('true', { ...baseOpts, hasITerm: false }).term).toBe('Terminal.app');
  });

  it('carries the OSC color prelude into the .command (fleet colors work on Mac, no Rust port)', () => {
    const SCHEME = { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' };
    const oneliner = buildConsoleOneliner('/x', {}, 'true', {
      mode: 'console',
      planSlug: 'p',
      label: null,
      scheme: SCHEME,
    });
    const inv = macConsoleInvocation(oneliner, baseOpts);
    expect(inv.content).toContain('#581c87'); // bg (OSC 11) survives into the .command
    expect(inv.content).toContain('#d8b4fe'); // cursor (OSC 12) survives
  });
});
