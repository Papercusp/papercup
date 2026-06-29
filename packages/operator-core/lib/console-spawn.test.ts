/**
 * Coverage for console-spawn.buildConsoleOneliner — the one-liner that the
 * spawned terminal runs as its first command. This is the mechanism behind
 * capability:terminal: the `greeting` is the caller's arbitrary command, and it
 * must (a) run in a subshell, (b) survive shell-quoting verbatim, then (c) hand
 * off to an interactive login shell so the window stays open.
 */
import { describe, expect, it } from 'vitest';
import { buildConsoleOneliner, advSessionTitleTag, type AppearanceOpts } from './console-spawn';

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
