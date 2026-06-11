/**
 * GET /api/desktop/setup-status — auto-detected status for every Setup
 * Wizard step. Each probe is wrapped so a single failure degrades to
 * 'unknown' without taking the rest down.
 *
 * Ported from app/api/desktop/setup-status/route.ts. `auth: {}`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';

import { readOperatorState } from '../../../operator-state-pg';
import { readCredentials } from '../../../credentials';
import { listDevices } from '../../../device-store';
import { activeWorkspaceId, readRegistry } from '../../../workspace-registry';
import { workspaceBackupFor } from '../../../backup';
import { anyAgentSignedIn } from '../../../agent-auth-detect';
import { detectClaude, detectCodex, detectOmp, detectMeridianInstalled } from '../../../preflight-binaries';
import { defineTool } from '@papercusp/agent-mcp';

type StepStatus = 'ok' | 'needs-attention' | 'unknown';
type StepId =
  | 'os-permissions'
  | 'embedded-pg'
  | 'workspace'
  | 'agents'
  | 'logins'
  | 'keys'
  | 'git'
  | 'mobile-pairing'
  | 'backups'
  | 'auto-update'
  | 'telemetry';

const exec = promisify(execFile);

async function probePostgres(): Promise<boolean> {
  const useEmbedded = process.env.PAPERCUSP_USE_EMBEDDED_PG === '1';
  let result: boolean;
  let reason: string;
  if (useEmbedded) {
    const port = Number(process.env.PAPERCUSP_PG_PORT);
    if (!Number.isFinite(port) || port <= 0) {
      console.warn('[setup-status] probePostgres: PAPERCUSP_USE_EMBEDDED_PG=1 but PAPERCUSP_PG_PORT invalid');
      return false;
    }
    result = await tcpReachable('127.0.0.1', port);
    reason = `embedded port=${port}`;
  } else {
    result = await tcpReachable('127.0.0.1', 5432);
    reason = 'native :5432';
  }
  if (!result) console.warn(`[setup-status] probePostgres: ${reason} → not reachable`);
  return result;
}

function tcpReachable(host: string, port: number, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const start = Date.now();
    const done = (ok: boolean, why: string) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      if (!ok) console.warn(`[setup-status] tcpReachable ${host}:${port} → ${why} (${Date.now() - start}ms)`);
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true, 'connect'));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (e) => done(false, `error: ${e.message}`));
    socket.connect(port, host);
  });
}

async function gitIdentityConfigured(): Promise<boolean> {
  try {
    const [name, email] = await Promise.all([
      exec('git', ['config', '--global', '--get', 'user.name'], { timeout: 2000 })
        .then((r) => r.stdout.trim())
        .catch(() => ''),
      exec('git', ['config', '--global', '--get', 'user.email'], { timeout: 2000 })
        .then((r) => r.stdout.trim())
        .catch(() => ''),
    ]);
    return name.length > 0 && email.length > 0;
  } catch {
    return false;
  }
}

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
}

function boolToStatus(ok: boolean): StepStatus {
  return ok ? 'ok' : 'needs-attention';
}

export default defineTool({
  method: 'GET',
  path: '/desktop/setup-status',
  auth: {},
  async handler() {
    const ws = activeWorkspaceId();

    const [
      pgOk,
      claudeOk,
      codexOk,
      ompOk,
      meridianOk,
      creds,
      wizardState,
      devices,
      backupSettings,
      gitOk,
    ] = await Promise.all([
      safe(probePostgres(), false),
      safe(detectClaude(), false),
      safe(detectCodex(), false),
      safe(detectOmp(), false),
      safe(Promise.resolve(detectMeridianInstalled()), false),
      safe(readCredentials(), {} as Awaited<ReturnType<typeof readCredentials>>),
      safe(
        readOperatorState<{
          update_channel?: string;
          telemetry_enabled?: boolean | null;
          os_permissions_ok?: boolean;
        }>('setup_wizard_state'),
        null,
      ),
      safe(listDevices(ws), [] as Awaited<ReturnType<typeof listDevices>>),
      safe(workspaceBackupFor(ws).getSettings(), null as Awaited<ReturnType<ReturnType<typeof workspaceBackupFor>['getSettings']>> | null),
      safe(gitIdentityConfigured(), false),
    ]);

    // os-permissions: Linux/Windows aren't install-gated → 'ok'. macOS
    // has system-level grants the Node server can't read, so we trust
    // the client-side StepOsPermissions probes that PATCH
    // os_permissions_ok back into operator state.
    const osPermissionsStatus: StepStatus =
      process.platform === 'darwin'
        ? wizardState?.os_permissions_ok === true
          ? 'ok'
          : 'needs-attention'
        : 'ok';

    // workspace: registry has at least one entry.
    const workspaceOk = readRegistry().workspaces.length > 0;

    // agents: a complete backend is EITHER a standalone CLI agent
    // (Claude Code or Codex — the orchestrator drives the CLI directly)
    // OR oh-my-pi + Meridian (the multi-provider path). Any one
    // satisfies the step.
    const agentsOk = claudeOk || codexOk || (ompOk && meridianOk);

    // keys: any of openai/anthropic/github saved.
    const keysOk = Boolean(
      creds.openai_api_key || creds.anthropic_api_key || creds.github_pat,
    );

    const statuses: Record<StepId, StepStatus> = {
      'os-permissions': osPermissionsStatus,
      'embedded-pg': boolToStatus(pgOk),
      workspace: boolToStatus(workspaceOk),
      agents: boolToStatus(agentsOk),
      logins: boolToStatus(anyAgentSignedIn()),
      keys: boolToStatus(keysOk),
      git: boolToStatus(gitOk),
      'mobile-pairing': boolToStatus(devices.length > 0),
      backups: boolToStatus(Boolean(backupSettings?.enabled)),
      'auto-update': boolToStatus(
        wizardState?.update_channel === 'alpha' ||
          wizardState?.update_channel === 'beta' ||
          wizardState?.update_channel === 'stable',
      ),
      telemetry: boolToStatus(
        wizardState?.telemetry_enabled === true ||
          wizardState?.telemetry_enabled === false,
      ),
    };

    // Per-component breakdown for the Agent Runtime step.
    const agentRuntime = { claude: claudeOk, codex: codexOk, omp: ompOk, meridian: meridianOk };

    return Response.json({ statuses, agentRuntime });
  },
});
