/**
 * The PROVIDER-AGNOSTIC half of a cloud driver: `install` + `join`
 * (`cloud-deployment-layer-2026-06-06` P-010/P-018).
 *
 * Once a frame is provisioned, bootstrapping it is identical regardless of who
 * provisioned it — stage the per-frame credentials, run the same
 * `buildFrameBootstrap` script over SSH, then admit it as a peer. So this logic is
 * SHARED by every `DeploymentDriver`; only `provision`/`teardown` are provider-
 * specific. That's the cleanest proof the abstraction isn't Latitude-shaped (P-018):
 * Latitude + Hetzner differ only in how they make/destroy a machine.
 */
import type { DeploymentConfig, DeploymentContext, Frame } from '@papercusp/deployment-driver';
import { buildFrameBootstrap } from './frame-bootstrap';
import { createSshRemoteExec, type RemoteExec } from './remote-exec';

/** Where the per-frame Claude credentials are staged on the frame before bootstrap. */
export const REMOTE_CRED_PATH = '/root/papercusp-claude-credentials.json';
/** Where the per-frame long-lived OAuth token (`claude setup-token`) is staged. */
export const REMOTE_TOKEN_PATH = '/root/papercusp-claude-token';

export interface FrameInstallerDeps {
  /** Build the RemoteExec for a frame. Injected for tests; default = SSH. */
  makeRemoteExec?: (frame: Frame, config: DeploymentConfig) => RemoteExec;
  /** Optional admission hook (P-015). Default: the frame federates via its boot announce. */
  onJoin?: (frame: Frame, config: DeploymentConfig, ctx: DeploymentContext) => Promise<void>;
}

export function defaultMakeRemoteExec(frame: Frame, config: DeploymentConfig): RemoteExec {
  const provider = (config.provider ?? {}) as Record<string, unknown>;
  if (!frame.host) throw new Error('installFrame: frame has no host/IP to SSH to');
  return createSshRemoteExec({
    host: frame.host,
    user: (provider.sshUser as string | undefined) ?? 'root',
    identityFile: provider.sshIdentityFile as string | undefined,
  });
}

/** Bootstrap the papercusp runtime on a provisioned frame (own loop + own embedded-pg). */
export async function installFrame(
  frame: Frame,
  config: DeploymentConfig,
  ctx: DeploymentContext,
  deps: FrameInstallerDeps = {},
): Promise<void> {
  const makeRemoteExec = deps.makeRemoteExec ?? defaultMakeRemoteExec;
  const boot = ctx.bootstrap ?? {};
  const exec = makeRemoteExec(frame, config);
  const log = (msg: string) => ctx.log?.('info', `[install] ${msg}`);

  // P-011: stage the per-frame Claude subscription (its own rate limits) first —
  // either a credentials bundle, a long-lived OAuth token, or both.
  if (boot.credentialsLocalPath) {
    log(`staging per-frame Claude credentials → ${REMOTE_CRED_PATH}`);
    await exec.copyFile(boot.credentialsLocalPath, REMOTE_CRED_PATH);
  }
  if (boot.oauthTokenLocalPath) {
    log(`staging per-frame Claude OAuth token → ${REMOTE_TOKEN_PATH}`);
    await exec.copyFile(boot.oauthTokenLocalPath, REMOTE_TOKEN_PATH);
  }
  const { script } = buildFrameBootstrap({
    harnessSlug: ctx.harnessSlug,
    repoUrl: boot.repoUrl,
    repoRef: boot.repoRef,
    environment: {
      setup: boot.setup ?? [],
      install: boot.install ?? [],
      build: boot.build ?? [],
      test: [],
      run: boot.run ?? [],
      services: boot.services ?? [],
      ports: boot.ports ?? [],
      env: boot.env ?? {},
    },
    claudeCredentialsRemotePath: boot.credentialsLocalPath ? REMOTE_CRED_PATH : undefined,
    claudeTokenRemotePath: boot.oauthTokenLocalPath ? REMOTE_TOKEN_PATH : undefined,
    embeddedPg: true, // D-007 ratified — frame runs its own embedded-pg
    orchestratorOnFrame: true, // D-006 ratified — frame runs its own loop
    env: boot.env,
    instanceConfigJson: boot.instanceConfigJson, // P-008: frame's instance config via env
    controlNode: boot.controlNode, // P-016: the Queen supervises across frames (unscoped)
  });
  log(`bootstrapping frame ${frame.id} (${script.length} bytes; own loop + own embedded-pg per D-006/D-007)`);
  await exec.runScript(script);
  log(`frame ${frame.id} bootstrapped`);
}

/** Admit the frame as a headless federated peer. */
export async function joinFrame(
  frame: Frame,
  config: DeploymentConfig,
  ctx: DeploymentContext,
  deps: FrameInstallerDeps = {},
): Promise<void> {
  if (deps.onJoin) {
    await deps.onJoin(frame, config, ctx);
    return;
  }
  // The frame admits itself via its boot announce (signed device pubkey →
  // read-admission). Explicit headless-peer admission lands with P-015 (deps.onJoin).
  ctx.log?.('info', `[install] frame ${frame.id} joins as a headless peer via its boot announce (P-014/P-015)`);
}
