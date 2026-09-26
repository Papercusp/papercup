/**
 * D-421 (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, WI-10003195): on a hosted
 * workspace host, every customer-driven agent CLI the operator spawns runs as the customer
 * workspace account — never as the operator service account (D-417: its state, embedded
 * Postgres and the hosted PTY key would be readable by a shell-capable agent a customer
 * steers through chat) and never as the platform agent account (D-416).
 *
 * The identity switch reuses the pinned loopback-SSH vector the customer terminal already
 * uses (`hostedWorkspaceSshArgs`), without a TTY. The customer's own agent credential is
 * linked from that account's home into the per-spawn CODEX_HOME, and the operator's
 * superuser token is refused outright if it would cross to the customer account.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import {
  buildLoopbackIdentitySpawn,
  configureAgentSpawnTransform,
  type AgentSpawnTransform,
} from '@papercusp/papercusp-shared/agent';
import { DEFAULT_WORKSPACE_HOST_WORKSPACE_USER } from '@papercusp/deployment-driver';
import { HOSTED_WORKSPACE_ACCOUNT_HOME, hostedWorkspaceSshArgs } from './hosted-session-host';

export interface HostedCustomerAgentIdentityOptions {
  /** Node binary the customer account runs the inline wrapper with. */
  readonly nodePath?: string;
  /** The operator service account's home (its PATH entries are not forwarded). */
  readonly localHome?: string;
  /** Operator environment to diff the spawn env against. */
  readonly baseEnv?: NodeJS.ProcessEnv;
  /** Operator secrets that must never reach the customer account. */
  readonly forbiddenSecrets?: readonly string[];
}

function readOperatorSuperuserToken(localHome: string): string[] {
  try {
    const token = readFileSync(join(localHome, '.papercusp', 'superuser-token'), 'utf8').trim();
    return token.length >= 16 ? [token] : [];
  } catch {
    return [];
  }
}

/** The transform that runs agent CLIs as the customer workspace account. */
export function hostedCustomerAgentSpawnTransform(
  options: HostedCustomerAgentIdentityOptions = {},
): AgentSpawnTransform {
  const localHome = options.localHome ?? homedir();
  // Quiet ssh diagnostics so the agent's stderr stays the agent's own; the option goes before
  // `-l <user> <host>` so the destination stays last and the remote command follows it.
  const ssh = hostedWorkspaceSshArgs({ tty: false });
  const destination = ssh.indexOf('-l');
  return buildLoopbackIdentitySpawn({
    transportCommand: '/usr/bin/ssh',
    transportArgs: [...ssh.slice(0, destination), '-o', 'LogLevel=ERROR', ...ssh.slice(destination)],
    identity: `${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}@127.0.0.1`,
    nodePath: options.nodePath ?? process.execPath,
    remoteHome: HOSTED_WORKSPACE_ACCOUNT_HOME,
    spawnRoot: posix.join(HOSTED_WORKSPACE_ACCOUNT_HOME, '.papercusp', 'agent-spawns'),
    localHome,
    baseEnv: options.baseEnv ?? process.env,
    passthroughEnv: ['LANG', 'LC_ALL', 'TZ'],
    homeLinks: [{ envVar: 'CODEX_HOME', name: 'auth.json', homeRelative: '.codex/auth.json' }],
    forbiddenSecrets: options.forbiddenSecrets ?? readOperatorSuperuserToken(localHome),
  });
}

/** Install the transform process-wide. Called once when the hosted runtime starts. */
export function installHostedCustomerAgentIdentity(options: HostedCustomerAgentIdentityOptions = {}): void {
  configureAgentSpawnTransform(hostedCustomerAgentSpawnTransform(options));
}
