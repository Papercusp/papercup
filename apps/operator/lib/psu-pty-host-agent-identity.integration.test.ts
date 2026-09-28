/**
 * D-421/D-424 (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, P-326, spec
 * CUSTOMER-IDENTITY-P326): the integration seam a hosted New Session crosses, end to end with
 * real processes.
 *
 *   operator-core `installHostedCustomerAgentIdentity` (the production spec builder)
 *     → `hostedAgentIdentityPsuEnv()` (exactly the env launch-su merges into a psu launch)
 *     → psu's PTY host `resolveAgentPtyTarget` (the real resolver, no injected stage)
 *     → the loopback stage hop (a real child process) → the exec hop (a real child process)
 *     → the agent CLI.
 *
 * The unit tests pin each piece with a hand-written spec. What only this test proves is that
 * the POLICY the production builder emits — which operator secret files are forbidden, which
 * state roots may ship, which env prefixes cross, where the agent's HOME and PATH point — is the
 * policy psu's stager actually enforces.
 *
 * The rig stands in for sshd and the customer OS account: the transport becomes `/bin/sh -c` and
 * the customer home a temp dir, so this runs anywhere. Every other field stays exactly as the
 * production builder produced it, and the first test asserts what was rebound. The OS-permission
 * half of the boundary (the customer uid cannot read operator files) cannot be shown with one
 * uid; it is proven live on a hosted host by
 * docs/evidence/p326-customer-identity-boundary-live-2026-09-28.json.
 *
 * Fixture "secrets" below are inert marker strings, deliberately not credential-shaped.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureAgentSpawnTransform } from '@papercusp/papercusp-shared/agent';
import {
  AGENT_IDENTITY_SPEC_ENV,
  AgentIdentityTtyRefusedError,
  type AgentIdentitySpec,
} from '../../../libs/papercusp-shared/src/agent/loopback-identity-tty.mjs';
import { installHostedCustomerAgentIdentity } from '@papercusp/operator-core/lib/workspace-host/hosted-agent-identity';
import {
  hostedAgentIdentityPsuEnv,
  setHostedAgentIdentityPsuSpec,
} from '@papercusp/operator-core/lib/workspace-host/hosted-agent-identity-psu-env';
import { resolveAgentPtyTarget } from '../scripts/psu-pty-host.mjs';

// The customer's "agent CLI": reports what it can see, so assertions are about identity facts.
const PROBE = `
const fs = require('fs');
const args = process.argv.slice(2);
const promptIdx = args.indexOf('--system-prompt-file');
process.stdout.write(JSON.stringify({
  cwd: process.cwd(),
  env: process.env,
  promptPath: promptIdx >= 0 ? args[promptIdx + 1] : null,
  prompt: promptIdx >= 0 ? fs.readFileSync(args[promptIdx + 1], 'utf8') : null,
}));
`;

// Each operator secret file the production spec forbids gets a distinct inert marker.
const SUPERUSER_TOKEN_MARKER = 'fixture-superuser-token-marker-0001';
const EMBEDDED_PG_ADMIN_MARKER = 'fixture-embedded-pg-admin-marker-0002';
const EMBEDDED_PG_ROLES_MARKER = 'fixture-embedded-pg-roles-marker-0003';
const OPERATOR_MODEL_KEY_MARKER = 'fixture-operator-model-key-marker-0004';

let root: string;
let localHome: string;
let serviceState: string;
let customerHome: string;
let toolchainBin: string;
let promptFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-agent-identity-int-'));
  localHome = join(root, 'operator');
  serviceState = join(root, 'service-state');
  customerHome = join(root, 'customer');
  toolchainBin = join(root, 'toolchain', 'bin');
  const localState = join(localHome, '.papercusp');
  mkdirSync(join(localState, 'launch-context'), { recursive: true });
  mkdirSync(serviceState, { recursive: true });
  mkdirSync(customerHome, { recursive: true });
  mkdirSync(toolchainBin, { recursive: true });

  // The customer toolchain: its own Node and the agent CLI (D-423).
  symlinkSync(process.execPath, join(toolchainBin, 'node'));
  writeFileSync(join(root, 'probe.js'), PROBE);
  writeFileSync(join(toolchainBin, 'claude'), `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'probe.js')}' "$@"\n`);
  chmodSync(join(toolchainBin, 'claude'), 0o755);

  // Operator state the production spec names as forbidden (D-417, WI-10003627).
  writeFileSync(join(localState, 'superuser-token'), `${SUPERUSER_TOKEN_MARKER}\n`);
  writeFileSync(join(localState, 'embedded-pg.json'), EMBEDDED_PG_ADMIN_MARKER);
  writeFileSync(join(serviceState, 'embedded-pg-credentials.json'), EMBEDDED_PG_ROLES_MARKER);

  promptFile = join(localState, 'launch-context', 'session-1.md');
  writeFileSync(promptFile, '# rendered su playbook\n');

  installHostedCustomerAgentIdentity({
    localHome,
    toolchainBin,
    baseEnv: { PAPERCUSP_HOME: serviceState },
  });
});

afterEach(() => {
  setHostedAgentIdentityPsuSpec(undefined);
  configureAgentSpawnTransform(undefined);
  rmSync(root, { recursive: true, force: true });
});

/** The spec exactly as a psu launch receives it from launch-su. */
function productionSpec(): AgentIdentitySpec {
  const raw = hostedAgentIdentityPsuEnv()[AGENT_IDENTITY_SPEC_ENV];
  expect(raw, 'installing the hosted identity must put the spec on every psu launch').toBeTypeOf('string');
  return JSON.parse(raw as string) as AgentIdentitySpec;
}

/** Rebind ONLY what needs a real sshd and customer account; every policy field is untouched. */
function rigSpec(spec: AgentIdentitySpec): AgentIdentitySpec {
  return {
    ...spec,
    stageTransport: { command: '/bin/sh', args: ['-c'] },
    execTransport: { command: '/bin/sh', args: ['-c'] },
    remoteHome: customerHome,
    spawnRoot: join(customerHome, '.papercusp', 'agent-spawns'),
  };
}

/** What psu asks its pty to run for a New Session, carrying the operator's own environment. */
function newSessionTarget(spec: AgentIdentitySpec, overrides: { args?: string[] } = {}) {
  return {
    command: 'claude',
    args: overrides.args ?? ['--dangerously-skip-permissions', '--system-prompt-file', promptFile, '--session-id', 's-1'],
    env: {
      PATH: '/opt/papercusp/current/bin:/usr/bin:/bin',
      HOME: localHome,
      TERM: 'xterm-256color',
      PAPERCUSP_SID: 'su-operator-session',
      PAPERCUSP_HOME: serviceState,
      DATABASE_URL: EMBEDDED_PG_ADMIN_MARKER,
      ANTHROPIC_API_KEY: OPERATOR_MODEL_KEY_MARKER,
      CLAUDE_CODE_OAUTH_TOKEN: OPERATOR_MODEL_KEY_MARKER,
      CLAUDE_CODE_ENTRYPOINT: 'psu',
      DISABLE_AUTOUPDATER: '1',
      [AGENT_IDENTITY_SPEC_ENV]: JSON.stringify(spec),
    } as Record<string, string | undefined>,
    cwd: '/var/lib/papercusp/workspace',
  };
}

function refusalCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentIdentityTtyRefusedError);
    return (error as AgentIdentityTtyRefusedError).code;
  }
  return undefined;
}

function stagedSpawns(): string[] {
  const dir = join(customerHome, '.papercusp', 'agent-spawns');
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe('hosted New Session agent identity, production spec through psu (D-421/D-424)', () => {
  it('the production spec targets the customer workspace account over the loopback vector', () => {
    const spec = productionSpec();
    expect(spec.identity).toBe('papercusp-workspace@127.0.0.1');
    expect(spec.remoteHome).toBe('/home/papercusp-workspace');
    expect(spec.stageTransport.command).toBe('/usr/bin/ssh');
    expect(spec.execTransport.command).toBe('/usr/bin/ssh');
    for (const transport of [spec.stageTransport, spec.execTransport]) {
      const at = transport.args.indexOf('-l');
      expect(transport.args.slice(at, at + 3)).toEqual(['-l', 'papercusp-workspace', '127.0.0.1']);
    }
    expect(spec.execTransport.args).toContain('-tt');
    expect(spec.stageTransport.args).not.toContain('-tt');
    // The agent runs on the customer's toolchain, never the operator's release Node.
    expect(spec.nodePath).toBe(join(toolchainBin, 'node'));
    expect(spec.remotePath[0]).toBe(toolchainBin);
    // Both operator state roots are forbidden-secret sources, not just the service home.
    expect(spec.forbiddenSecretFiles).toEqual(
      expect.arrayContaining([
        join(localHome, '.papercusp', 'superuser-token'),
        join(localHome, '.papercusp', 'embedded-pg.json'),
        join(localHome, '.papercusp', 'embedded-pg-credentials.json'),
        join(serviceState, 'embedded-pg.json'),
        join(serviceState, 'embedded-pg-credentials.json'),
      ]),
    );
  });

  it('runs the agent with the customer home, PATH and cwd and none of the operator secrets or state', () => {
    const spec = rigSpec(productionSpec());
    const resolved = resolveAgentPtyTarget(newSessionTarget(spec));
    // The pty runs the identity transport, never the agent directly as the service user.
    expect(resolved.command).toBe('/bin/sh');
    expect(resolved.env).not.toHaveProperty(AGENT_IDENTITY_SPEC_ENV);
    expect(resolved.env).not.toHaveProperty('DATABASE_URL');
    expect(resolved.env).not.toHaveProperty('PAPERCUSP_SID');

    const run = spawnSync(resolved.command, resolved.args, { env: resolved.env, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const seen = JSON.parse(run.stdout) as { cwd: string; env: Record<string, string>; promptPath: string; prompt: string };

    expect(seen.env.HOME).toBe(customerHome);
    expect(seen.cwd).toBe(customerHome);
    expect(seen.env.PATH).toBe(spec.remotePath.join(':'));
    expect(seen.env.PATH).not.toContain('/opt/papercusp');
    // Only allowlisted behaviour env crosses; every credential and operator handle stays behind.
    expect(seen.env.CLAUDE_CODE_ENTRYPOINT).toBe('psu');
    expect(seen.env.DISABLE_AUTOUPDATER).toBe('1');
    for (const name of [
      'DATABASE_URL',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'PAPERCUSP_SID',
      'PAPERCUSP_HOME',
      AGENT_IDENTITY_SPEC_ENV,
    ]) {
      expect(seen.env, name).not.toHaveProperty(name);
    }
    const everything = JSON.stringify(seen);
    for (const marker of [SUPERUSER_TOKEN_MARKER, EMBEDDED_PG_ADMIN_MARKER, EMBEDDED_PG_ROLES_MARKER, OPERATOR_MODEL_KEY_MARKER]) {
      expect(everything).not.toContain(marker);
    }
    // The rendered playbook reaches the agent as a copy under the customer's spawn root.
    expect(seen.prompt).toBe('# rendered su playbook\n');
    expect(seen.promptPath.startsWith(spec.spawnRoot)).toBe(true);
    // The per-spawn dir is removed once the agent exits.
    expect(stagedSpawns()).toEqual([]);
  });

  it.each([
    ['the superuser token in argv', () => ['--append-system-prompt', `token ${SUPERUSER_TOKEN_MARKER}`]],
    ['the embedded-PG admin credential in argv', () => ['--append-system-prompt', EMBEDDED_PG_ADMIN_MARKER]],
    ['the embedded-PG role passwords in argv', () => ['--append-system-prompt', EMBEDDED_PG_ROLES_MARKER]],
    ['the superuser token file itself', () => ['--system-prompt-file', join(localHome, '.papercusp', 'superuser-token')]],
    ['the embedded-PG admin file itself', () => ['--system-prompt-file', join(localHome, '.papercusp', 'embedded-pg.json')]],
  ])('refuses before anything is staged when %s would cross', (_label, args) => {
    const spec = rigSpec(productionSpec());
    expect(refusalCode(() => resolveAgentPtyTarget(newSessionTarget(spec, { args: args() })))).toBe(
      'agent_spawn_forbidden_secret',
    );
    expect(stagedSpawns()).toEqual([]);
  });

  it('refuses a shipped prompt that embeds an operator secret', () => {
    const spec = rigSpec(productionSpec());
    const leaking = join(localHome, '.papercusp', 'launch-context', 'leaking.md');
    writeFileSync(leaking, `# playbook\nsee ${SUPERUSER_TOKEN_MARKER}\n`);
    expect(
      refusalCode(() => resolveAgentPtyTarget(newSessionTarget(spec, { args: ['--system-prompt-file', leaking] }))),
    ).toBe('agent_spawn_forbidden_secret');
    expect(stagedSpawns()).toEqual([]);
  });
});
