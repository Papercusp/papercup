/**
 * WI-10001638 part 3 — the pty HTTP/SSE control plane must refuse under multi-worker
 * clustering, exactly as the WS leg does.
 *
 * The defect these tests pin: every route that reaches a terminal resolves it through
 * the SAME in-process `pty-bridge` handles map as the WS attach path, so clustering
 * breaks both. Before this guard the HTTP leg failed SILENTLY and DISHONESTLY — a
 * `404 {error:'unknown pty id'}` for a pty that existed on another worker. That string
 * produced two wrong root-cause theories on this item, which is why the assertions
 * below check the WORDING of the refusal and not merely its status code.
 *
 * The partition test is the durable half: a pty route added later must be either
 * cluster-guarded or explicitly declared disk-backed, or it fails here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ptyRoutes, { PTY_CLUSTER_SAFE_PATHS, PTY_CLUSTER_UNSERVICEABLE_CODE } from './index';
import {
  ptyRegistryClusterRefusal,
  __resetPtyRegistryClusterMemoForTests,
} from '../../../pty-bridge';
import type { Principal } from '@papercusp/agent-mcp';

const WORKSPACE = 'ws-cluster-refusal-test';
const SLUG = 'harness-under-test';

/**
 * A principal whose workspace matches the request header, so `resolvePtyAccessScope`
 * returns a scope from the request alone. This keeps the test off `activeWorkspaceId()`
 * and the workspace registry — the guard, not scope resolution, is the subject.
 */
const principal = { workspaceId: WORKSPACE, slug: 'cluster-refusal-test' } as unknown as Principal;

type HttpTool = {
  method: string;
  path: string;
  handler: (req: Request, ctx: { params: Record<string, string>; principal: Principal | null }) => unknown;
};

const tools = ptyRoutes as unknown as HttpTool[];

function concretePath(path: string, ptyId: string): string {
  return path
    .replace(':slug', SLUG)
    .replace(':id', ptyId)
    .replace(':filename', 'session.html');
}

/**
 * Invoke a route and report its status. A THROW is reported rather than propagated
 * because several disk-backed routes touch the harness state dir, which is not
 * provisioned here — and the only claim those routes are used for below is the
 * negative one ("the cluster guard did not fire"), which a throw also satisfies.
 * Registry-backed routes assert a positive 503, so a throw still fails them.
 */
async function statusOf(tool: HttpTool, ptyId = 'pty-under-test'): Promise<number | 'threw'> {
  try {
    return (await invoke(tool, ptyId)).status;
  } catch {
    return 'threw';
  }
}

function invoke(tool: HttpTool, ptyId: string): Promise<Response> {
  const url = `http://127.0.0.1:3070/api${concretePath(tool.path, ptyId)}`;
  const req = new Request(url, {
    method: tool.method,
    headers: { 'x-papercusp-workspace': WORKSPACE, origin: 'http://127.0.0.1:3055' },
  });
  const ctx = { params: { slug: SLUG, id: ptyId, filename: 'session.html' }, principal };
  return Promise.resolve(tool.handler(req, ctx) as Response | Promise<Response>);
}

/**
 * Whether a route answered with THE CLUSTER REFUSAL specifically.
 *
 * Status alone is not a sound test here, and this is not hypothetical: the first run
 * of this suite failed because `prewarm` returns its own unrelated
 * `503 prewarm spawn failed`, which a status-only assertion read as this guard firing
 * in a SINGLE-PROCESS deployment. Identify by the discriminating code instead.
 */
async function isClusterRefusal(tool: HttpTool, ptyId = 'pty-under-test'): Promise<boolean> {
  try {
    const res = await invoke(tool, ptyId);
    if (res.status !== 503) return false;
    return (await res.text()).includes(PTY_CLUSTER_UNSERVICEABLE_CODE);
  } catch {
    return false;
  }
}

async function bodyOf(tool: HttpTool, ptyId: string): Promise<string> {
  return await (await invoke(tool, ptyId)).text();
}

const registryBacked = () => tools.filter((t) => !PTY_CLUSTER_SAFE_PATHS.has(t.path));
const diskBacked = () => tools.filter((t) => PTY_CLUSTER_SAFE_PATHS.has(t.path));

let savedWorkers: string | undefined;
let savedCluster: string | undefined;

beforeEach(() => {
  savedWorkers = process.env.PAPERCUSP_CLUSTER_WORKERS;
  savedCluster = process.env.PAPERCUSP_CLUSTER;
  __resetPtyRegistryClusterMemoForTests();
});

afterEach(() => {
  if (savedWorkers === undefined) delete process.env.PAPERCUSP_CLUSTER_WORKERS;
  else process.env.PAPERCUSP_CLUSTER_WORKERS = savedWorkers;
  if (savedCluster === undefined) delete process.env.PAPERCUSP_CLUSTER;
  else process.env.PAPERCUSP_CLUSTER = savedCluster;
  __resetPtyRegistryClusterMemoForTests();
});

function forceClustered(workers = 6): void {
  process.env.PAPERCUSP_CLUSTER_WORKERS = String(workers);
  __resetPtyRegistryClusterMemoForTests();
}

function forceSingleProcess(): void {
  process.env.PAPERCUSP_CLUSTER_WORKERS = '0';
  delete process.env.PAPERCUSP_CLUSTER;
  __resetPtyRegistryClusterMemoForTests();
}

describe('ptyRegistryClusterRefusal', () => {
  it('is inert at one worker, on garbage, and when the caller passes an explicit count', () => {
    forceClustered(6);
    // An explicit count always wins over the environment: this is what lets
    // hono-host pass the one authoritative value it already resolved at boot.
    expect(ptyRegistryClusterRefusal({ clusterWorkers: 1 })).toBeNull();
    expect(ptyRegistryClusterRefusal({ clusterWorkers: 0 })).toBeNull();
    expect(ptyRegistryClusterRefusal({ clusterWorkers: Number.NaN })).toBeNull();
    expect(ptyRegistryClusterRefusal({ clusterWorkers: 4 })).toBe(4);
  });

  it('self-resolves from the environment when no count is supplied', () => {
    forceSingleProcess();
    expect(ptyRegistryClusterRefusal()).toBeNull();
    forceClustered(6);
    expect(ptyRegistryClusterRefusal()).toBe(6);
  });
});

describe('pty HTTP routes under multi-worker clustering', () => {
  it('classifies EVERY pty route as registry-backed or disk-backed', async () => {
    // The recurrence guard. A new pty route cannot quietly default into the
    // unguarded set: it either refuses under clustering or is declared cluster-safe.
    forceClustered();
    expect(tools.length).toBeGreaterThan(0);
    const unclassified: string[] = [];
    for (const tool of tools) {
      const declaredSafe = PTY_CLUSTER_SAFE_PATHS.has(tool.path);
      if (!declaredSafe && !(await isClusterRefusal(tool))) {
        unclassified.push(`${tool.method} ${tool.path} → ${await statusOf(tool)}`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  it('refuses every registry-backed route with 503', async () => {
    forceClustered();
    const backed = registryBacked();
    // Guards against the partition test passing vacuously if the set were ever empty.
    expect(backed.length).toBe(8);
    for (const tool of backed) {
      expect(await statusOf(tool), `${tool.method} ${tool.path}`).toBe(503);
      expect(await isClusterRefusal(tool), `${tool.method} ${tool.path}`).toBe(true);
    }
  });

  it('leaves the disk-backed routes enabled — they are not broken by clustering', async () => {
    forceClustered();
    const disk = diskBacked();
    expect(disk.length).toBe(3);
    for (const tool of disk) {
      // Refusing these would delete working functionality: exported transcripts and
      // the static tool inventory are read from disk and are identical in every worker.
      expect(await isClusterRefusal(tool), `${tool.method} ${tool.path}`).toBe(false);
    }
  });

  it('does not refuse anything in a single-process deployment', async () => {
    // The shipping desktop target pins PAPERCUSP_CLUSTER=0; terminals must be untouched.
    // Asserted by refusal IDENTITY, not status: prewarm legitimately 503s here when it
    // cannot spawn, and that is not this guard firing.
    forceSingleProcess();
    for (const tool of tools) {
      expect(await isClusterRefusal(tool), `${tool.method} ${tool.path}`).toBe(false);
    }
  });

  it('states the real cause and remedy instead of blaming the pty id', async () => {
    forceClustered(6);
    const stream = tools.find((t) => t.path === '/harness/:slug/pty/:id/stream');
    expect(stream).toBeDefined();
    const body = await bodyOf(stream!, 'pty-under-test');
    // The false statement this whole item traced back to. It must not reappear.
    expect(body).not.toContain('unknown pty id');
    // The actionable half: naming the count and the way out is what makes the
    // refusal diagnosable without reading source.
    expect(body).toContain('6');
    expect(body).toMatch(/PAPERCUSP_CLUSTER/);
    expect(body).toMatch(/clustering/i);
  });

  it('answers identically for any pty id, leaking no existence oracle', async () => {
    forceClustered();
    const stream = tools.find((t) => t.path === '/harness/:slug/pty/:id/stream')!;
    // Decided from configuration alone, before any registry lookup — so a caller
    // cannot probe which ids exist by diffing refusals. This preserves the property
    // the WS leg's deliberately-indistinguishable rejection was built to hold.
    const a = await bodyOf(stream, 'definitely-does-not-exist');
    const b = await bodyOf(stream, 'also-does-not-exist-but-different');
    expect(a).toBe(b);
  });
});
