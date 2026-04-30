/**
 * Cloudflare Pages API client. Just the calls the Worker needs.
 *
 *   POST /accounts/:account/pages/projects                     create project
 *   GET  /accounts/:account/pages/projects/:name               read project (subdomain)
 *   POST /accounts/:account/pages/projects/:name/files         upload-file (per-file content-addressed)
 *   POST /accounts/:account/pages/projects/:name/deployments   create deployment from staged files
 *   GET  /accounts/:account/pages/projects/:name/deployments/:dep   poll deployment status
 *
 * docs: https://developers.cloudflare.com/api/operations/pages-project-create-project
 */

import type { Env } from './env.ts';

const CF_API = 'https://api.cloudflare.com/client/v4';

export class CfApiError extends Error {
  constructor(
    public status: number,
    public errors: unknown,
    public path: string,
  ) {
    super(`cloudflare api error ${status} on ${path}`);
  }
}

async function cf<T>(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(CF_API + path, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CF_MASTER_TOKEN}`,
      ...(init.body && !(init.body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
      ...init.headers,
    },
  });
  const json = await res.json<{ success: boolean; result: T; errors?: unknown }>();
  if (!res.ok || !json.success) {
    throw new CfApiError(res.status, json.errors ?? null, path);
  }
  return json.result;
}

export interface CfProject {
  name: string;
  subdomain: string;
}

export async function getProject(env: Env, name: string): Promise<CfProject | null> {
  try {
    return await cf<CfProject>(
      env,
      `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${encodeURIComponent(name)}`,
    );
  } catch (e) {
    if (e instanceof CfApiError && e.status === 404) return null;
    throw e;
  }
}

export async function createProject(
  env: Env,
  name: string,
): Promise<CfProject> {
  return cf<CfProject>(env, `/accounts/${env.CF_ACCOUNT_ID}/pages/projects`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      production_branch: 'main',
    }),
  });
}

export async function ensureProject(env: Env, name: string): Promise<{ project: CfProject; created: boolean }> {
  // Local-dev short-circuit: when running under `wrangler dev --local` with
  // the stub CF_MASTER_TOKEN, fabricate a CF project response so the full
  // publish flow is exercisable without real Cloudflare credentials.
  if (env.CF_MASTER_TOKEN === 'local-stub') {
    return {
      project: { name, subdomain: `${name}.localhost-stub.dev` },
      created: false,
    };
  }
  const existing = await getProject(env, name);
  if (existing) return { project: existing, created: false };
  const created = await createProject(env, name);
  return { project: created, created: true };
}

/**
 * POST /pages/projects/:name/upload-token then PUT to the returned URL with
 * the file body. CF Pages content-addresses files by sha256, so re-uploading
 * the same bytes is a no-op server-side.
 *
 * We stream the body through the Worker without buffering so we don't pay
 * Worker memory or bandwidth costs.
 */
export async function uploadFile(
  env: Env,
  projectName: string,
  body: ReadableStream<Uint8Array>,
  sha256: string,
  bytes: number,
): Promise<void> {
  if (env.CF_MASTER_TOKEN === 'local-stub') {
    // Drain the body so the caller's tee/stream contracts remain happy.
    const reader = body.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    return;
  }
  const res = await fetch(
    `${CF_API}/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${encodeURIComponent(projectName)}/file`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CF_MASTER_TOKEN}`,
        'content-type': 'application/octet-stream',
        'cf-pages-file-sha256': sha256,
        'content-length': String(bytes),
      },
      body: body as ReadableStream,
      // @ts-expect-error workerd accepts these; types lag
      duplex: 'half',
    },
  );
  if (!res.ok) {
    const err = await safeJson(res);
    throw new CfApiError(res.status, err, `upload-file/${sha256}`);
  }
}

export interface CfDeployment {
  id: string;
  url: string;
  latest_stage: { name: string; status: string };
}

export async function createDeployment(
  env: Env,
  projectName: string,
  manifest: Record<string, { hash: string; size: number }>,
): Promise<CfDeployment> {
  if (env.CF_MASTER_TOKEN === 'local-stub') {
    return {
      id: 'cfdep_localstub',
      url: `https://${projectName}.pages.dev`,
      latest_stage: { name: 'deploy', status: 'success' },
    };
  }
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  return cf<CfDeployment>(
    env,
    `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${encodeURIComponent(projectName)}/deployments`,
    { method: 'POST', body: form },
  );
}

export async function getDeployment(
  env: Env,
  projectName: string,
  deploymentId: string,
): Promise<CfDeployment> {
  if (env.CF_MASTER_TOKEN === 'local-stub') {
    return {
      id: deploymentId,
      url: `https://${projectName}.pages.dev`,
      latest_stage: { name: 'deploy', status: 'success' },
    };
  }
  return cf<CfDeployment>(
    env,
    `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${encodeURIComponent(projectName)}/deployments/${deploymentId}`,
  );
}

export async function deleteDeployment(
  env: Env,
  projectName: string,
  deploymentId: string,
): Promise<void> {
  try {
    await cf<unknown>(
      env,
      `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${encodeURIComponent(projectName)}/deployments/${deploymentId}`,
      { method: 'DELETE' },
    );
  } catch (e) {
    if (e instanceof CfApiError && e.status === 404) return;
    throw e;
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function cfStageToStatus(
  stage: CfDeployment['latest_stage'],
): 'building' | 'live' | 'failed' {
  if (stage.status === 'success' && (stage.name === 'deploy' || stage.name === 'success'))
    return 'live';
  if (stage.status === 'failure') return 'failed';
  return 'building';
}
