/**
 * Assemble the generic `FrameBootstrapInput` for a deploy (P-010/P-012): the
 * harness's git remote + its blueprint `environment` spec (P-007) + the per-frame
 * credential bundle named by `deployment.credentialRef` (P-011). Best-effort: a
 * missing piece degrades gracefully (no repo / empty env / no creds) rather than
 * failing the deploy assembly.
 */
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import type { DeploymentConfig, FrameBootstrapInput } from '@papercusp/deployment-driver';

/** Resolve a credentialRef to a local file path (or undefined for non-file refs). */
export function resolveCredentialPath(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith('file:')) return ref.slice(5);
  if (ref.startsWith('/')) return ref;
  if (ref.startsWith('~')) return ref.replace(/^~/, process.env.HOME ?? '~');
  // `env:NAME` / bare names refer to the API key, not a per-frame credentials FILE.
  return undefined;
}

export async function buildDeployBootstrapInput(
  slug: string,
  workspaceId: string,
  config: DeploymentConfig,
): Promise<FrameBootstrapInput> {
  const { loadHarnessRegistry } = await import('../harness-registry');
  const reg = await loadHarnessRegistry(workspaceId);
  const project = reg.projects.find((p) => p.slug === slug);
  const path = project?.path;

  let repoUrl: string | undefined;
  if (path) {
    try {
      repoUrl = execFileSync('git', ['-C', path, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim() || undefined;
    } catch {
      /* no git remote — repo-less or local-only; the frame won't clone */
    }
  }

  let env;
  if (path) {
    try {
      env = loadBlueprintFromFile(join(path, '.papercusp', 'blueprint.yaml')).blueprint.environment;
    } catch {
      /* no/invalid blueprint env spec — nothing extra to stand up */
    }
  }

  return {
    repoUrl,
    setup: env?.setup,
    install: env?.install,
    build: env?.build,
    run: env?.run,
    services: env?.services,
    ports: env?.ports,
    env: env?.env,
    credentialsLocalPath: resolveCredentialPath(config.credentialRef),
  };
}
