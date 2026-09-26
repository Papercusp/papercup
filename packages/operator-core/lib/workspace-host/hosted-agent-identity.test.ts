import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentSpawnRefusedError,
  agentSpawnTransformConfigured,
  configureAgentSpawnTransform,
  planAgentSpawn,
  type AgentSpawnRequest,
} from '@papercusp/papercusp-shared/agent';
import { DEFAULT_WORKSPACE_HOST_WORKSPACE_USER } from '@papercusp/deployment-driver';
import { hostedCustomerAgentSpawnTransform, installHostedCustomerAgentIdentity } from './hosted-agent-identity';
import { HOSTED_WORKSPACE_ACCOUNT_HOME, hostedWorkspacePtySpawnSpec, hostedWorkspaceSshArgs } from './hosted-session-host';

// D-421 (byoc plan) / WI-10003195: on a hosted host the chat brain's agent CLI must run as the
// customer workspace account, never in-process as the operator service account.

let root: string;
let stagedCodexHome: string;
let serviceHome: string;

function codexRequest(extraEnv: NodeJS.ProcessEnv = {}): AgentSpawnRequest {
  return {
    backend: 'codex',
    command: '/opt/papercusp/current/bin/codex',
    args: ['exec', '--json', '-s', 'danger-full-access', '-'],
    cwd: undefined,
    env: { PATH: `${serviceHome}/.local/bin:/opt/papercusp/current/bin:/usr/bin:/bin`, CODEX_HOME: stagedCodexHome, ...extraEnv },
    stagedDirs: [{ path: stagedCodexHome, persistent: false }],
  };
}

function header(prelude: Buffer | undefined) {
  expect(prelude).toBeInstanceOf(Buffer);
  const text = prelude!.toString('utf8');
  const newline = text.indexOf('\n');
  return JSON.parse(text.slice(newline + 1));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-agent-identity-'));
  serviceHome = join(root, 'var-lib-papercusp');
  stagedCodexHome = join(root, 'codex-chat-abc123');
  mkdirSync(join(serviceHome, '.papercusp'), { recursive: true });
  mkdirSync(stagedCodexHome, { recursive: true });
  writeFileSync(join(stagedCodexHome, 'AGENTS.md'), 'persona');
  writeFileSync(join(stagedCodexHome, 'config.toml'), 'headers = { Authorization = "Bearer customer-principal-token" }\n');
});

afterEach(() => {
  configureAgentSpawnTransform(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('hosted customer agent identity (D-421)', () => {
  it('runs the agent over the pinned loopback SSH vector as the customer account, without a TTY', () => {
    const plan = hostedCustomerAgentSpawnTransform({ localHome: serviceHome, baseEnv: {}, forbiddenSecrets: [] })(codexRequest());
    expect(plan.command).toBe('/usr/bin/ssh');
    const args = [...plan.args];
    expect(args).toContain('-T');
    expect(args).not.toContain('-tt');
    const destination = args.indexOf('-l');
    expect(args.slice(destination, destination + 3)).toEqual(['-l', DEFAULT_WORKSPACE_HOST_WORKSPACE_USER, '127.0.0.1']);
    expect(args.indexOf('LogLevel=ERROR')).toBeLessThan(destination);
    // The remote command is the last argv entry and runs the inline wrapper with node.
    expect(args).toHaveLength(destination + 4);
    expect(args[destination + 3]).toMatch(/^exec '.+' -e '/);
    expect(plan.identity).toBe(`${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}@127.0.0.1`);
  });

  it('materializes CODEX_HOME under the customer home and links the customer credential, not the operator one', () => {
    const plan = hostedCustomerAgentSpawnTransform({ localHome: serviceHome, baseEnv: {}, forbiddenSecrets: [] })(codexRequest());
    const h = header(plan.stdinPrelude);
    expect(h.env.HOME).toBe(HOSTED_WORKSPACE_ACCOUNT_HOME);
    expect(h.env.CODEX_HOME.startsWith(`${HOSTED_WORKSPACE_ACCOUNT_HOME}/.papercusp/agent-spawns/`)).toBe(true);
    expect(h.links).toEqual([{ path: `${h.env.CODEX_HOME}/auth.json`, target: `${HOSTED_WORKSPACE_ACCOUNT_HOME}/.codex/auth.json` }]);
    // The service account's own PATH entries never cross.
    expect(h.env.PATH.split(':')).not.toContain(`${serviceHome}/.local/bin`);
    expect(h.env.PATH.split(':')[0]).toBe(`${HOSTED_WORKSPACE_ACCOUNT_HOME}/.local/bin`);
  });

  it('refuses when the operator superuser token would reach the customer account', () => {
    writeFileSync(join(serviceHome, '.papercusp', 'superuser-token'), 'su-token-0123456789abcdef');
    writeFileSync(join(stagedCodexHome, 'config.toml'), 'headers = { Authorization = "Bearer su-token-0123456789abcdef" }\n');
    const transform = hostedCustomerAgentSpawnTransform({ localHome: serviceHome, baseEnv: {} });
    expect(() => transform(codexRequest())).toThrow(AgentSpawnRefusedError);
  });

  it('once installed, every planned agent spawn is routed away from the service account', () => {
    expect(agentSpawnTransformConfigured()).toBe(false);
    installHostedCustomerAgentIdentity({ localHome: serviceHome, baseEnv: {}, forbiddenSecrets: [] });
    expect(agentSpawnTransformConfigured()).toBe(true);
    const plan = planAgentSpawn(codexRequest());
    expect(plan.command).toBe('/usr/bin/ssh');
    expect(plan.command).not.toBe(codexRequest().command);
  });

  it('keeps the customer terminal on the same pinned vector with a forced TTY', () => {
    if (process.platform !== 'linux') return;
    const spec = hostedWorkspacePtySpawnSpec({ scope: 'workspace', workspaceRoot: '/srv/w', hostedSessionId: 's', cols: 80, rows: 24 } as never);
    const ttyArgs = hostedWorkspaceSshArgs({ tty: true });
    expect(spec.args.slice(0, ttyArgs.length)).toEqual(ttyArgs);
    expect(ttyArgs).toContain('-tt');
  });
});
