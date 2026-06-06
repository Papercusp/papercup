/**
 * Production wiring for the deploy mechanics — plan
 * release-gate-ready-branch-2026-06-04 (D-005/D-006/D-007/D-008).
 *
 * Each DeployDep maps to a real subsystem:
 *   withDrain        → guardResource(dev-server, exclusive) — the SAME drain
 *                      `dev:restart` uses, so it quiesces the same peers (D-006).
 *   snapshot/restore → the Kopia backup substrate (workspace files + PG dump, D-008).
 *   runSetup         → setup-release-checkout.sh (FF release tree + submodules + nm).
 *   migrate          → applyStagedMigrations, fail-loud (D-007).
 *   restart          → systemctl restart of the operator unit (gated, shared-box safe).
 *   health/verify    → probeHealth + verify-release-paths (D-011d + Phase-0 isolation).
 *   broadcast        → coord:send "deployed <sha>".
 *
 * Kept separate from deploy.ts so the orchestration stays light + stub-testable;
 * this file pulls the heavy operator-core deps only on the real path.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { guardResource } from '@papercusp/operator-core/lib/agent-tools/locks/resource-lock-guard';
import { lockCoordinationDomain } from '@papercusp/operator-core/lib/agent-tools/locks/coordination-domain';
import { sendMessage } from '@papercusp/operator-core/lib/agent-tools/coordination/messages';
import type { AgentIdentity } from '@papercusp/operator-core/lib/agent-tools/coordination/identity';
import { activeWorkspaceId } from '@papercusp/operator-core/lib/workspace-registry';
// Side-effect: wires the operator host binding (getSql / workspacesRoot /
// admin-URL) into @papercusp/backup. The standalone deploy doesn't go through
// the operator boot path that normally triggers this, so without it the
// snapshot step throws "configureBackup() must be called before using the
// backup API" and aborts the deploy → rollback (observed 2026-06-05).
import '@papercusp/operator-core/lib/backup/configure';
import { workspaceBackupFor } from '@papercusp/backup';
import type { ReleaseConfig } from './release-config';
import { VERIFY_RESULT_MARKER } from './verify-release-paths';
import type { DeployDeps, SnapshotInfo } from './deploy';
import { applyStagedMigrations } from './migrate';
import { probeHealth } from './health-probe';

const DEPLOY_OWNER = 'release-deploy';
const DEFAULT_DRAIN_SEC = 120;

function deployIdentity(): AgentIdentity {
  return {
    ownerId: DEPLOY_OWNER,
    ownerLabel: 'release-deploy',
    source: 'static-client',
    workspaceId: safeWorkspaceId(),
    userId: null,
  };
}

function safeWorkspaceId(): string | null {
  try {
    return activeWorkspaceId();
  } catch {
    return null;
  }
}

/** Run a shell command, capturing stdout/stderr; reject on non-zero exit. */
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        // Include BOTH streams: a failing verify-paths prints its human text to
        // stderr but the machine-readable marker line to stdout — the caller
        // parses the marker out of this message on the failure path.
        : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}:\n${stderr}\n${stdout}`)),
    );
  });
}

export interface RealDepsOpts {
  drainSec?: number;
  /** Skip the drain (testing / explicit). */
  noDrain?: boolean;
  log?: (s: string) => void;
}

export function realDeps(cfg: ReleaseConfig, opts: RealDepsOpts = {}): DeployDeps {
  const log = opts.log ?? ((s: string) => console.log(`[deploy] ${s}`));
  const allowRestart = process.env.PAPERCUSP_ALLOW_DEV_RESTART === '1';

  return {
    async withDrain<T>(fn: () => Promise<T>): Promise<T> {
      if (opts.noDrain) return fn();
      const id = deployIdentity();
      const outcome = await guardResource(
        {
          coordinationDomain: lockCoordinationDomain(),
          ownerId: id.ownerId,
          ownerLabel: id.ownerLabel,
          coordIdentity: id,
          resource: 'dev-server',
          mode: 'exclusive',
          maxDrainSec: opts.drainSec ?? DEFAULT_DRAIN_SEC,
          reason: 'release deploy (drain before swap)',
        },
        fn,
      );
      if (!outcome.acquired) {
        throw new Error(
          `could not acquire exclusive(dev-server) to deploy: ${outcome.reason} ` +
            `(holders: ${outcome.holders.map((h) => h.owner_label ?? h.owner).join(', ') || 'none'})`,
        );
      }
      return outcome.result;
    },

    async snapshot(reason: string): Promise<SnapshotInfo | null> {
      const ws = safeWorkspaceId();
      if (!ws) {
        log('no active workspace — snapshot skipped (rollback will be code-only)');
        return null;
      }
      const r = await workspaceBackupFor(ws).snapshot('pre-deploy', { op: 'release-deploy', reason });
      log(`snapshot ${r.kopiaSnapshotId.slice(0, 12)} (#${r.snapshotId}, ${r.bytesAdded}B)`);
      return { snapshotId: r.snapshotId, kopiaSnapshotId: r.kopiaSnapshotId };
    },

    async runSetup(targetSha, { lockfileChanged }): Promise<void> {
      const script = path.join(cfg.integrationRoot, 'apps/operator/bin/release/setup-release-checkout.sh');
      await run('bash', [
        script,
        '--ref', targetSha,
        '--integration', cfg.integrationRoot,
        '--release', cfg.releaseRoot,
        '--node-modules', lockfileChanged ? 'force' : 'skip',
        // operator-vite/dist is UNTRACKED — without this the swap serves a STALE
        // SPA (server code moves, UI doesn't; bitten 2026-06-06: /admin/git was
        // missing from the deployed SPA). Deploys build it; checkpoints skip it.
        '--build-spa',
      ]);
      log(`release checkout swapped to ${targetSha.slice(0, 8)} (node_modules: ${lockfileChanged ? 'resynced' : 'unchanged'}; SPA rebuilt)`);
    },

    async migrate() {
      return applyStagedMigrations({ releaseRoot: cfg.releaseRoot, log: (s) => log(`migrate: ${s}`) });
    },

    async restart(): Promise<void> {
      if (!allowRestart) {
        throw new Error('restart withheld — set PAPERCUSP_ALLOW_DEV_RESTART=1 to enable the real deploy restart');
      }
      const [bin, ...rest] = cfg.systemdUnit.includes(' ')
        ? cfg.systemdUnit.split(' ')
        : ['systemctl', '--user', 'restart', cfg.systemdUnit];
      await run(bin, rest);
      log(`restarted ${cfg.systemdUnit}`);
    },

    async health() {
      return probeHealth(cfg.operatorHealthUrl, { log: (s) => log(s) });
    },

    async verifyPaths() {
      // Run the integration tree's verify script with cwd = the release tree, so
      // process.cwd()-based resolution checks the release checkout. (Integration
      // tsx/script are always present — avoids a first-deploy chicken-and-egg.)
      const tsx = path.join(cfg.integrationRoot, 'node_modules/.bin/tsx');
      const script = path.join(cfg.integrationRoot, 'apps/operator/lib/release/verify-release-paths.ts');
      // The verify script prints exactly one marker-delimited JSON line on
      // stdout; everything else (human text, stray PG NOTICEs from imported
      // modules) is noise we must skip. Parse the marker line, not the whole
      // stream — JSON.parse(stdout) broke on the trailing OK line (2026-06-05).
      const parseMarker = (stream: string): { ok: boolean; failures: string[] } | null => {
        const line = stream
          .split('\n')
          .find((l) => l.includes(VERIFY_RESULT_MARKER));
        if (!line) return null;
        try {
          const json = JSON.parse(line.slice(line.indexOf(VERIFY_RESULT_MARKER) + VERIFY_RESULT_MARKER.length).trim());
          return { ok: !!json.ok, failures: Array.isArray(json.failures) ? json.failures : [] };
        } catch {
          return null;
        }
      };
      try {
        const { stdout } = await run(tsx, [script, cfg.releaseRoot], {
          cwd: path.join(cfg.releaseRoot, 'apps/operator'),
          env: { PAPERCUSP_RELEASE_ROOT: cfg.releaseRoot },
        });
        const parsed = parseMarker(stdout);
        if (parsed) return parsed;
        return { ok: false, failures: [`verify-paths: no ${VERIFY_RESULT_MARKER} line in output`] };
      } catch (e) {
        // Non-zero exit = verification failed; the marker line is still on the
        // captured stdout (run() includes it in the thrown error's message).
        const msg = e instanceof Error ? e.message : String(e);
        const parsed = parseMarker(msg);
        if (parsed) return parsed;
        const m = msg.match(/"failures":\s*(\[[^\]]*\])/);
        return { ok: false, failures: m ? (JSON.parse(m[1]) as string[]) : [msg] };
      }
    },

    async restoreSnapshot(snap: SnapshotInfo): Promise<void> {
      const ws = safeWorkspaceId();
      if (!ws) throw new Error('cannot restore snapshot: no active workspace');
      log(`restoring workspace from snapshot ${snap.kopiaSnapshotId.slice(0, 12)}`);
      await workspaceBackupFor(ws).restoreInPlace({ kopiaSnapshotId: snap.kopiaSnapshotId });
    },

    async broadcast(summary: string, body?: string): Promise<void> {
      await sendMessage(deployIdentity(), {
        to: ['*'],
        summary,
        body,
        category: 'service-health',
      });
    },

    async recordEvent(ev): Promise<void> {
      // The /admin/git deploy history (mig 177). Recorded by the DEPLOY process
      // (which survives the :3070 restart it performs) — the release-trigger
      // routine's host does not (deployer-dies-with-deployed, 2026-06-06).
      const { appendPipelineEvent } = await import(
        '@papercusp/operator-core/lib/harness/git-sync/pipeline-events'
      );
      await appendPipelineEvent({
        workspaceId: safeWorkspaceId() ?? '*',
        installSlug: process.env.RELEASE_ROUTINE_SLUG ?? 'papercup',
        kind: 'deploy',
        status: ev.status,
        detail: ev.detail,
      });
    },

    log,
  };
}
