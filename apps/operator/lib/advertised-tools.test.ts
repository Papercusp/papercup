/**
 * The advertised-tools probe spawns a real `claude -p` whose global hooks fire. With an
 * inherited PAPERCUSP_SID that nested CLI's SessionEnd was reported AS the su running the
 * test and fleet:kill'ed it (WI-10003957). These pin the probe's env contract without
 * spawning anything.
 */
import { describe, expect, it } from 'vitest';
import { advertisedToolsProbeEnv } from './advertised-tools';

const AGENT_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  PAPERCUSP_SID: 'su-running-the-test',
  PAPERCUSP_ADV_SESSION_ID: '31412',
  PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070',
  PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'task-1',
  ANTHROPIC_AUTH_TOKEN: 'gateway-bearer',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788',
  CLAUDE_CODE_USE_BEDROCK: '1',
};

describe('advertisedToolsProbeEnv', () => {
  it('drops every PAPERCUSP_* var so the probe can never act as the calling agent', () => {
    const env = advertisedToolsProbeEnv(AGENT_ENV, 4321);
    expect(Object.keys(env).filter((k) => k.startsWith('PAPERCUSP_'))).toEqual([]);
    // Calibration: the input really carried them, and ordinary vars survive.
    expect(Object.keys(AGENT_ENV).filter((k) => k.startsWith('PAPERCUSP_'))).toHaveLength(4);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
  });

  it('routes to the local capture endpoint and strips competing auth routes', () => {
    const env = advertisedToolsProbeEnv(AGENT_ENV, 4321);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4321');
    expect(env.ANTHROPIC_API_KEY).toBe('probe-local-endpoint-no-auth');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it('applies caller overrides last, with undefined clearing a key', () => {
    const env = advertisedToolsProbeEnv(AGENT_ENV, 4321, {
      ENABLE_TOOL_SEARCH: 'true',
      HOME: undefined,
    });
    expect(env.ENABLE_TOOL_SEARCH).toBe('true');
    expect('HOME' in env).toBe(false);
  });

  it('does not mutate the environment it was given', () => {
    const before = { ...AGENT_ENV };
    advertisedToolsProbeEnv(AGENT_ENV, 4321, { PAPERCUSP_SID: undefined });
    expect(AGENT_ENV).toEqual(before);
  });
});
