/**
 * Live runner for the J5 outage drill (outage-drill.ts; plan aws-byoc-gcp-parity-2026-10-01
 * P-017). Runs the drill against a real GCP workspace host and prints the evidence + verdict.
 *
 *   tsx packages/operator-core/lib/workspace-host/outage-drill-cli.ts \
 *     --project <p> --zone <z> --instance <name> --instance-id <id> --network <net> \
 *     --host-id <host-…> --workspace-dir <dir> [--agent <cli>] [--nonce <n>] [--out <evidence.json>]
 *
 * --agent is the agent CLI on the host, invoked as `<cli> -p <prompt> --allowedTools Bash,Write`. A
 * hosted host ships only the local-inference agent (D-250); the customer connects their own model
 * account, so point --agent at a wrapper that runs claude with that account's credential.
 *
 * Needs HARNESS_ADMIN_DATABASE_URL (the hosted connector heartbeat lives in
 * papercusp_auth.hosted_workspace_connectors) and the controller's IAP SSH key + known_hosts
 * under ~/.local/state/papercusp/controller, exactly as the controller reaches the host. It only
 * ever blocks egress on the named host network; it never touches shared Papercusp services.
 * Exit code: 0 = drill passed, 1 = drill failed, 2 = usage.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { isCliEntry } from '../util/cli-entry';
import { gcpIapHostKeyAlias } from './gcp-iap-initialization-operations';
import {
  evaluateOutageDrill,
  runOutageDrill,
  type HostCommandResult,
  type OutageDrillConfig,
} from './outage-drill';

const WORKSPACE_ACCOUNT = 'papercusp-workspace';
const DEFAULT_AGENT = '/usr/local/lib/papercusp-agent-toolchain/bin/claude';

function run(file: string, args: readonly string[], timeoutMs: number): Promise<HostCommandResult> {
  return new Promise((resolvePromise) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`bad argument near ${key ?? '<end>'}`);
    args.set(key.slice(2), value);
  }
  return args;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: Map<string, string>;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(String(error));
    return 2;
  }
  const need = (key: string) => {
    const value = args.get(key);
    if (!value) throw new Error(`--${key} is required`);
    return value;
  };
  let config: OutageDrillConfig;
  let ssh: { alias: string; instance: string; project: string; zone: string };
  let hostId: string;
  try {
    const project = need('project');
    const zone = need('zone');
    const instance = need('instance');
    hostId = need('host-id');
    const nonce = args.get('nonce') ?? `j5${randomBytes(6).toString('hex')}`;
    ssh = { alias: gcpIapHostKeyAlias({ projectId: project, zone, instanceName: instance, instanceId: need('instance-id') }), instance, project, zone };
    config = {
      project,
      network: need('network'),
      ruleName: `pc-j5-outage-drill-${nonce}`.toLowerCase().slice(0, 63),
      papercuspOrigin: args.get('papercusp-origin') ?? 'https://app.papercusp.com',
      modelProviderOrigin: args.get('model-origin') ?? 'https://api.anthropic.com',
      serviceUnit: args.get('service') ?? 'papercusp-workspace.service',
      agentCommand: args.get('agent') ?? DEFAULT_AGENT,
      workspaceDir: need('workspace-dir'),
      nonce,
      secret: randomBytes(16).toString('hex'),
    };
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    return 2;
  }
  const databaseUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
  if (!databaseUrl) {
    console.error('HARNESS_ADMIN_DATABASE_URL is required');
    return 2;
  }
  const sql = postgres(databaseUrl, { max: 1 });
  const controller = join(homedir(), '.local/state/papercusp/controller');
  try {
    const evidence = await runOutageDrill(config, {
      hostExec: (command) =>
        run('ssh', [
          '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
          '-o', `UserKnownHostsFile=${join(controller, 'known_hosts')}`, '-o', `HostKeyAlias=${ssh.alias}`,
          '-o', 'IdentitiesOnly=yes', '-i', join(controller, 'id_ed25519'), '-o', 'ConnectTimeout=30',
          '-o', `ProxyCommand=gcloud compute start-iap-tunnel %h %p --listen-on-stdin --project=${ssh.project} --zone=${ssh.zone} --verbosity=error`,
          `${WORKSPACE_ACCOUNT}@${ssh.instance}`, command,
        ], 90_000),
      cloudExec: (cloudArgs) => run('gcloud', cloudArgs, 120_000),
      resolveAddresses: (hostname) => resolve4(hostname),
      readConnectorLastSeenAt: async () => {
        const rows = await sql<{ seen: Date | null }[]>`
          SELECT max(heartbeat_at) AS seen FROM papercusp_auth.hosted_workspace_connectors
           WHERE host_id = ${hostId} AND revoked_at IS NULL`;
        return rows[0]?.seen ?? null;
      },
      sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
      now: () => new Date(),
      log: (line) => console.error(`[j5] ${new Date().toISOString()} ${line}`),
    });
    const verdict = evaluateOutageDrill(evidence);
    const report = JSON.stringify({ hostId, config, evidence, verdict }, null, 2);
    const out = args.get('out');
    if (out) writeFileSync(out, `${report}\n`);
    console.log(report);
    return verdict.passed ? 0 : 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (isCliEntry(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
