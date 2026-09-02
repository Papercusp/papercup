// WI-2140943 lane 2 (2026-09-02): the WI-38292 host-code handoff carried a hand-kept
// allowlist of child env keys that predated the context-trimming trio, so every headless
// fleet member that adopted updated host code re-booted with the whole ~581-tool catalog
// inline — 756k tokens on turn 1 (measured on su-d7f0f / su-038a7 / su-7b1db925 /
// su-02edb29f), respawned by the compaction watchdog every ~10 min. Two rails now:
//   1. the launcher's handoff successor re-derives the trio when absent (heal);
//   2. the pty-host allowlist is PINNED ⊇ the helper's keys, so the next key the fresh
//      path adds cannot silently fall out of the handoff again.
import { describe, expect, it } from 'vitest';
import { contextTrimmingEnv, healContextTrimmingEnv } from '../scripts/psu-launcher.mjs';
import { HOST_HANDOFF_ENV_KEYS } from '../scripts/psu-pty-host.mjs';

describe('host-code handoff × context-trimming env (WI-2140943 lane 2)', () => {
  it('contextTrimmingEnv: claude gets the full trio, every other agent only the payload tier', () => {
    const claude = contextTrimmingEnv('claude');
    expect(claude.ENABLE_TOOL_SEARCH).toBe('true');
    expect(claude.PAPERCUSP_CONTEXT_TIER).toBe('trimmed');
    expect(typeof claude.PAPERCUSP_TOOLS).toBe('string');
    expect(String(claude.PAPERCUSP_TOOLS ?? '').split(',').length).toBeGreaterThan(5);
    expect(Object.keys(contextTrimmingEnv('codex'))).toEqual(['PAPERCUSP_CONTEXT_TIER']);
    expect(Object.keys(contextTrimmingEnv('omp'))).toEqual(['PAPERCUSP_CONTEXT_TIER']);
  });

  it('HOST_HANDOFF_ENV_KEYS ⊇ every key contextTrimmingEnv sets (allowlist pinned to the helper)', () => {
    const trio = Object.keys(contextTrimmingEnv('claude'));
    expect(trio.sort()).toEqual(['ENABLE_TOOL_SEARCH', 'PAPERCUSP_CONTEXT_TIER', 'PAPERCUSP_TOOLS']);
    for (const key of trio) expect(HOST_HANDOFF_ENV_KEYS).toContain(key);
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
    expect(healContextTrimmingEnv(env).sort()).toEqual(['ENABLE_TOOL_SEARCH', 'PAPERCUSP_TOOLS']);
    expect(env.PAPERCUSP_CONTEXT_TIER).toBe('full');
    expect(env.ENABLE_TOOL_SEARCH).toBe('true');
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
    expect(filled.sort()).toEqual(['ENABLE_TOOL_SEARCH', 'PAPERCUSP_CONTEXT_TIER', 'PAPERCUSP_TOOLS']);
    expect(env).toMatchObject(contextTrimmingEnv('claude'));
    // A non-claude successor gets only the tier — never a claude-only key.
    const codex: Record<string, string | undefined> = { PAPERCUSP_AGENT: 'codex' };
    expect(healContextTrimmingEnv(codex)).toEqual(['PAPERCUSP_CONTEXT_TIER']);
    expect(codex.ENABLE_TOOL_SEARCH).toBeUndefined();
  });
});
