/**
 * GET /api/desktop/setup-status
 *
 * Single endpoint that returns auto-detected status for every Setup
 * Wizard step. The wizard renders sidebar badges and the "Finish
 * setup" gate from this — no per-step user toggle.
 *
 * Loopback-only. Each probe is wrapped so a single failure degrades
 * to 'unknown' without taking the rest down.
 */
import { NextRequest, NextResponse } from 'next/server';
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';

import { readOperatorState } from '@/lib/operator-state-pg';
import { readCredentials } from '@/lib/credentials';
import { readElevenLabsKey } from '@/lib/voice-credentials';
import { listDevices } from '@/lib/mobile-device-store';
import { activeWorkspaceId, readRegistry } from '@/lib/workspace-registry';
import { workspaceBackupFor } from '@/lib/backup';
import { anyAgentSignedIn } from '@/lib/agent-auth-detect';
import { detectClaude, detectOmp, detectMeridianInstalled } from '@/lib/preflight-binaries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type StepStatus = 'ok' | 'needs-attention' | 'unknown';
type StepId =
  | 'os-permissions'
  | 'embedded-pg'
  | 'workspace'
  | 'agents'
  | 'logins'
  | 'keys'
  | 'git'
  | 'voice-devices'
  | 'mobile-pairing'
  | 'backups'
  | 'auto-update'
  | 'telemetry';

const exec = promisify(execFile);

async function probePostgres(): Promise<boolean> {
  const useEmbedded = process.env.PAPERCUSP_USE_EMBEDDED_PG === '1';
  const usePglite = process.env.PAPERCUSP_USE_PGLITE === '1';
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
  } else if (usePglite) {
    const socketDir = process.env.PAPERCUSP_PGLITE_SOCKET_DIR;
    result = Boolean(socketDir && existsSync(`${socketDir}/.s.PGSQL.5432`));
    reason = `pglite dir=${socketDir ?? '<unset>'}`;
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

export async function GET(req: NextRequest) {
  try {
    await requirePrincipal(req.headers);
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return NextResponse.json({ error: err.reason }, { status: err.status });
    }
    throw err;
  }

  const ws = activeWorkspaceId();

  const [
    pgOk,
    claudeOk,
    ompOk,
    meridianOk,
    creds,
    elevenKey,
    wizardState,
    devices,
    backupSettings,
    gitOk,
  ] = await Promise.all([
    safe(probePostgres(), false),
    safe(detectClaude(), false),
    safe(detectOmp(), false),
    safe(Promise.resolve(detectMeridianInstalled()), false),
    safe(readCredentials(), {} as Awaited<ReturnType<typeof readCredentials>>),
    safe(readElevenLabsKey(), null),
    safe(
      readOperatorState<{
        voice_intent?: boolean;
        update_channel?: string;
        telemetry_enabled?: boolean | null;
      }>('setup_wizard_state'),
      null,
    ),
    safe(listDevices(ws), [] as Awaited<ReturnType<typeof listDevices>>),
    safe(workspaceBackupFor(ws).getSettings(), null as Awaited<ReturnType<ReturnType<typeof workspaceBackupFor>['getSettings']>> | null),
    safe(gitIdentityConfigured(), false),
  ]);

  // os-permissions: macOS has system-level grants we can't probe from
  // the server (mic/notif/accessibility). On Linux/Windows the step is
  // not gated by anything install-side, so mark 'ok'. The client-side
  // probes in StepOsPermissions still surface the real grants.
  const osPermissionsStatus: StepStatus =
    process.platform === 'darwin' ? 'unknown' : 'ok';

  // workspace: registry has at least one entry (Tauri always writes
  // the default). Anything past zero counts.
  const workspaceOk = readRegistry().workspaces.length > 0;

  // agents: need claude + omp + meridian all installed. omp drives the
  // agent loop, Claude Code is the model, Meridian routes Claude
  // traffic through the user's subscription. Meridian is checked by
  // package presence (not port) — the desktop app spawns the daemon
  // on boot, so a just-installed runtime is "ready" before a restart.
  const agentsOk = claudeOk && ompOk && meridianOk;

  // keys: any of openai/anthropic/github saved.
  const keysOk = Boolean(
    creds.openai_api_key || creds.anthropic_api_key || creds.github_pat,
  );

  // voice-devices: configured if key is set OR user opted out by not
  // ticking voice_intent (step is then intentionally skipped).
  const voiceOk = Boolean(elevenKey) || wizardState?.voice_intent === false;

  const statuses: Record<StepId, StepStatus> = {
    'os-permissions': osPermissionsStatus,
    'embedded-pg': boolToStatus(pgOk),
    workspace: boolToStatus(workspaceOk),
    agents: boolToStatus(agentsOk),
    logins: boolToStatus(anyAgentSignedIn()),
    keys: boolToStatus(keysOk),
    git: boolToStatus(gitOk),
    'voice-devices': voiceOk ? 'ok' : 'needs-attention',
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

  // Per-component breakdown for the Agent Runtime step — lets
  // StepAgents show exactly which of the three is missing, using the
  // same detection as the aggregate `agents` status above (no drift).
  const agentRuntime = { claude: claudeOk, omp: ompOk, meridian: meridianOk };

  return NextResponse.json({ statuses, agentRuntime });
}
