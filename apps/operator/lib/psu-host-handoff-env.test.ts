// WI-2140943 lane 2 (2026-09-02): the WI-38292 host-code handoff carried a hand-kept
// allowlist of child env keys that predated the context-trimming trio, so every headless
// fleet member that adopted updated host code re-booted with the whole ~581-tool catalog
// inline — 756k tokens on turn 1 (measured on su-d7f0f / su-038a7 / su-7b1db925 /
// su-02edb29f), respawned by the compaction watchdog every ~10 min. Two rails now:
//   1. the launcher's handoff successor re-derives the trio when absent (heal);
//   2. the pty-host allowlist is PINNED ⊇ the helper's keys, so the next key the fresh
//      path adds cannot silently fall out of the handoff again.
import { describe, expect, it } from 'vitest';
import {
  contextTrimmingEnv,
  healContextTrimmingEnv,
  healTerminalRenderEnv,
  nativeDeferralReachable,
  terminalRenderEnv,
} from '../scripts/psu-launcher.mjs';
import { HOST_HANDOFF_ENV_KEYS } from '../scripts/psu-pty-host.mjs';

// P-007: ENABLE_TOOL_SEARCH is now DERIVED from whether the ToolSearch deny leaves claude's
// native schema deferral reachable, so the claude key set is a duo while the 2026-09-11 lockout
// stands and a trio if it is ever lifted. Computing the expectation from the predicate here
// keeps these assertions honest either way: it cross-checks two independent code paths (the env
// builder against the predicate) rather than restating the env builder's own output.
const CLAUDE_TRIMMING_KEYS = nativeDeferralReachable()
  ? ['ENABLE_TOOL_SEARCH', 'PAPERCUSP_CONTEXT_TIER', 'PAPERCUSP_TOOLS']
  : ['PAPERCUSP_CONTEXT_TIER', 'PAPERCUSP_TOOLS'];

describe('host-code handoff × context-trimming env (WI-2140943 lane 2)', () => {
  it('contextTrimmingEnv: claude gets the deferral-derived key set, every other agent only the payload tier', () => {
    const claude = contextTrimmingEnv('claude');
    // P-007: present IFF native deferral is actually reachable. Emitting it under the
    // ToolSearch deny turns on nothing and injects a DeferredToolPlaceholder into every request.
    expect(claude.ENABLE_TOOL_SEARCH).toBe(
      nativeDeferralReachable() ? 'true' : undefined,
    );
    expect(claude.PAPERCUSP_CONTEXT_TIER).toBe('trimmed');
    expect(typeof claude.PAPERCUSP_TOOLS).toBe('string');
    expect(String(claude.PAPERCUSP_TOOLS ?? '').split(',').length).toBeGreaterThan(5);
    expect(Object.keys(contextTrimmingEnv('codex'))).toEqual(['PAPERCUSP_CONTEXT_TIER']);
    expect(Object.keys(contextTrimmingEnv('omp'))).toEqual(['PAPERCUSP_CONTEXT_TIER']);
  });

  it('HOST_HANDOFF_ENV_KEYS ⊇ every key contextTrimmingEnv sets (allowlist pinned to the helper)', () => {
    const trio = Object.keys(contextTrimmingEnv('claude'));
    expect(trio.sort()).toEqual([...CLAUDE_TRIMMING_KEYS].sort());
    for (const key of trio) expect(HOST_HANDOFF_ENV_KEYS).toContain(key);
    // The allowlist must stay a SUPERSET even of the key P-007 stopped emitting: lifting the
    // ToolSearch lockout would restore ENABLE_TOOL_SEARCH, and it must not then fall out of the
    // handoff the way the original trio did (WI-2140943).
    expect(HOST_HANDOFF_ENV_KEYS).toContain('ENABLE_TOOL_SEARCH');
    // Falsifiability control: the pre-fix allowlist (the same list minus the trio) MUST fail
    // this pin — otherwise the assertion above is not measuring anything.
    const preFix = HOST_HANDOFF_ENV_KEYS.filter((k) => !trio.includes(k));
    expect(trio.some((k) => preFix.includes(k))).toBe(false);
  });

  it('healContextTrimmingEnv fills ONLY absent keys, keeps explicit values, is idempotent', () => {
    const env: Record<string, string | undefined> = {
      PAPERCUSP_AGENT: 'claude',
      PAPERCUSP_CONTEXT_TIER: 'full',
    };
    expect(healContextTrimmingEnv(env).sort()).toEqual(
      CLAUDE_TRIMMING_KEYS.filter((k) => k !== 'PAPERCUSP_CONTEXT_TIER').sort(),
    );
    expect(env.PAPERCUSP_CONTEXT_TIER).toBe('full');
    expect(env.ENABLE_TOOL_SEARCH).toBe(
      nativeDeferralReachable() ? 'true' : undefined,
    );
    expect(healContextTrimmingEnv(env)).toEqual([]);
  });

  it('a pre-fix handoff childEnv (identity keys, no trio) heals to the fresh-path env', () => {
    const env: Record<string, string | undefined> = {
      PAPERCUSP_SID: 'su-d7f0f017-4921-44e8-adb7-a663415ff93e',
      PAPERCUSP_AGENT: 'claude',
      PAPERCUSP_FLEET_ROLE: 'member',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788',
      DISABLE_AUTO_COMPACT: '1',
      DISABLE_COMPACT: '1',
    };
    const filled = healContextTrimmingEnv(env, env.PAPERCUSP_AGENT);
    expect(filled.sort()).toEqual([...CLAUDE_TRIMMING_KEYS].sort());
    expect(env).toMatchObject(contextTrimmingEnv('claude'));
    // P-007: healing must also CONVERGE a successor that inherited the pre-fix contradiction.
    // Fill-only cannot do it — the key arrives already present from the predecessor's old code.
    const carried: Record<string, string | undefined> = {
      PAPERCUSP_AGENT: 'claude',
      ENABLE_TOOL_SEARCH: 'true',
    };
    healContextTrimmingEnv(carried, 'claude');
    expect(carried.ENABLE_TOOL_SEARCH).toBe(
      nativeDeferralReachable() ? 'true' : undefined,
    );
    // A non-claude successor gets only the tier — never a claude-only key.
    const codex: Record<string, string | undefined> = { PAPERCUSP_AGENT: 'codex' };
    expect(healContextTrimmingEnv(codex)).toEqual(['PAPERCUSP_CONTEXT_TIER']);
    expect(codex.ENABLE_TOOL_SEARCH).toBeUndefined();
  });
});

// Console-history preservation (owner terminal 2026-09-06 00:10Z): Claude Code 2.1.259's
// fullscreen TUI paints on the terminal's alternate screen, so a carry-respawn discarded two
// whole epochs of su-8ef2d from the owner's console — only their "Resume this session with"
// exit lines reached primary scrollback. The launcher now stamps
// CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN on every Claude spawn path, the handoff successor
// heals it, and the pty-host allowlist is pinned ⊇ the helper's keys, exactly like the trio.
describe('host-code handoff × alternate-screen env (console-history preservation)', () => {
  it('terminalRenderEnv: claude is kept off the alternate screen, other agents untouched', () => {
    expect(terminalRenderEnv('claude', {})).toEqual({ CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' });
    expect(terminalRenderEnv('codex', {})).toEqual({});
    expect(terminalRenderEnv('omp', {})).toEqual({});
    expect(terminalRenderEnv(undefined, {})).toEqual({});
  });

  it('an explicit value in the launch env wins (an owner who wants fullscreen sets 0)', () => {
    expect(terminalRenderEnv('claude', { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '0' })).toEqual({});
    expect(terminalRenderEnv('claude', { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' })).toEqual({});
    // An EMPTY string is not an explicit choice — the default applies.
    expect(terminalRenderEnv('claude', { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '' })).toEqual({
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
    });
  });

  it('HOST_HANDOFF_ENV_KEYS ⊇ every key terminalRenderEnv sets (allowlist pinned to the helper)', () => {
    const keys = Object.keys(terminalRenderEnv('claude', {}));
    expect(keys).toEqual(['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN']);
    for (const key of keys) expect(HOST_HANDOFF_ENV_KEYS).toContain(key);
    // Falsifiability control: the pre-fix allowlist (this list minus the key) MUST fail the pin.
    const preFix = HOST_HANDOFF_ENV_KEYS.filter((k) => !keys.includes(k));
    expect(keys.some((k) => preFix.includes(k))).toBe(false);
  });

  it('healTerminalRenderEnv fills ONLY an absent key, keeps an explicit value, is idempotent', () => {
    const env: Record<string, string | undefined> = {
      PAPERCUSP_AGENT: 'claude',
      DISABLE_AUTO_COMPACT: '1',
      DISABLE_COMPACT: '1',
    };
    expect(healTerminalRenderEnv(env)).toEqual(['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN']);
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1');
    expect(healTerminalRenderEnv(env)).toEqual([]);
    const fullscreen: Record<string, string | undefined> = {
      PAPERCUSP_AGENT: 'claude',
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '0',
    };
    expect(healTerminalRenderEnv(fullscreen)).toEqual([]);
    expect(fullscreen.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('0');
    const codex: Record<string, string | undefined> = { PAPERCUSP_AGENT: 'codex' };
    expect(healTerminalRenderEnv(codex)).toEqual([]);
    expect(codex.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined();
  });
});
