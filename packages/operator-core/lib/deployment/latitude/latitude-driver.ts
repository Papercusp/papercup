/**
 * LatitudeDriver — the first cloud DeploymentDriver (`cloud-deployment-layer-2026-06-06`
 * P-009 / D-002 / D-003). Implements the provider-agnostic `DeploymentDriver`
 * contract from `@papercusp/deployment-driver` against the Latitude.sh REST API.
 *
 * - `provision` — `POST /servers` then poll `GET /servers/{id}` until the frame is
 *   reachable (status ready + an IPv4 assigned); returns a `Frame`.
 * - `teardown` — `DELETE /servers/{id}` (DESTROY, not stop — ends billing, P-012).
 * - `install` / `join` — P-010/P-014: bootstrap the runtime on the frame (per the
 *   ratified D-006/D-007: the frame runs its OWN orchestrator loop + its OWN
 *   embedded-pg federating via the peer-log) and admit it as a headless peer.
 *   These need a live frame to exercise, so they're explicit `pending` throws
 *   rather than silent no-ops (a remote frame with nothing installed is broken).
 *
 * The API client + `sleep` are injectable so provision/teardown are fully
 * unit-testable with a mocked HTTP layer — no live Latitude account required.
 */
import type {
  DeploymentConfig,
  DeploymentContext,
  DeploymentDriver,
  Frame,
} from '@papercusp/deployment-driver';
import { createLatitudeApiClient, type LatitudeApiClient, type LatitudeServerAttributes } from './latitude-api';

/** Latitude statuses that mean the frame is up and usable. */
const READY_STATUSES = new Set(['on', 'active', 'ready', 'running']);
/** Latitude statuses that mean provisioning failed (stop polling, throw). */
const FAILED_STATUSES = new Set(['failed', 'error', 'deleted']);

const DEFAULT_OS = 'ubuntu_22_04_x64_lts';

export interface LatitudeDriverDeps {
  /** Injected client (tests). Default: built per-call from the resolved API key. */
  client?: LatitudeApiClient;
  /** Resolve the API key for a config. Default: `credentialRef` env name, else LATITUDE_API_KEY. */
  resolveApiKey?: (config: DeploymentConfig) => string | undefined;
  baseUrl?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Injected for tests so polling doesn't actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultResolveApiKey(config: DeploymentConfig): string | undefined {
  // `credentialRef` may name an env var (`env:MY_KEY` or `MY_KEY`); default to the
  // documented LATITUDE_API_KEY. The secret itself never lives in the config.
  const ref = config.credentialRef;
  if (ref) {
    const envName = ref.startsWith('env:') ? ref.slice(4) : ref;
    const v = process.env[envName];
    if (v) return v;
  }
  return process.env.LATITUDE_API_KEY;
}

/** Map a DeploymentConfig onto Latitude `POST /servers` attributes (validated). */
export function toLatitudeAttributes(config: DeploymentConfig, ctx: DeploymentContext): LatitudeServerAttributes {
  const provider = (config.provider ?? {}) as Record<string, unknown>;
  const project = (provider.project as string | undefined)?.trim();
  // `size` IS the Latitude plan slug (VM vs bare metal is the plan's nature).
  const plan = config.size?.trim() ?? (provider.plan as string | undefined)?.trim();
  const site = config.region?.trim() ?? (provider.site as string | undefined)?.trim();
  const missing = [
    !project && 'provider.project',
    !plan && 'size (the Latitude plan slug)',
    !site && 'region (the Latitude site code)',
  ].filter(Boolean) as string[];
  if (missing.length) {
    throw new Error(
      `LatitudeDriver.provision: deployment config is missing required field(s): ${missing.join(', ')}. ` +
        `Provide e.g. { target:'latitude', region:'NYC', size:'c2-small-x86', provider:{ project:'<id>' } }.`,
    );
  }
  return {
    project: project!,
    plan: plan!,
    site: site!,
    operating_system: (provider.operatingSystem as string | undefined) ?? DEFAULT_OS,
    hostname: (provider.hostname as string | undefined) ?? `papercusp-${ctx.harnessSlug}`,
    ssh_keys: provider.sshKeys as string[] | undefined,
    user_data: provider.userData as string | undefined,
    // Hourly so a destroy-on-teardown frame only bills while it's actually running.
    billing: (provider.billing as LatitudeServerAttributes['billing']) ?? 'hourly',
  };
}

const PENDING_INSTALL = (verb: string) =>
  new Error(
    `LatitudeDriver.${verb} is not implemented yet (cloud-deployment-layer P-010/P-014). ` +
      `Per ratified D-006/D-007 it must bootstrap the frame to run its OWN orchestrator loop + OWN ` +
      `embedded-pg (federating via the peer-log) from the blueprint's environment spec, then admit it ` +
      `as a headless peer. Blocked on a live frame to exercise.`,
  );

export function makeLatitudeDriver(deps: LatitudeDriverDeps = {}): DeploymentDriver {
  const resolveApiKey = deps.resolveApiKey ?? defaultResolveApiKey;
  const pollIntervalMs = deps.pollIntervalMs ?? 10_000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 15 * 60_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  function clientFor(config: DeploymentConfig): LatitudeApiClient {
    if (deps.client) return deps.client;
    const apiKey = resolveApiKey(config);
    if (!apiKey) {
      throw new Error(
        `LatitudeDriver: no API key. Set LATITUDE_API_KEY (or a credentialRef env) so the driver can ` +
          `call the Latitude.sh API.`,
      );
    }
    return createLatitudeApiClient({ apiKey, baseUrl: deps.baseUrl });
  }

  const log = (ctx: DeploymentContext, level: 'info' | 'warn' | 'error', msg: string) =>
    ctx.log?.(level, `[latitude] ${msg}`);

  return {
    target: 'latitude',
    placement: 'remote',

    async provision(config, ctx): Promise<Frame> {
      const client = clientFor(config);
      const attrs = toLatitudeAttributes(config, ctx);
      log(ctx, 'info', `creating server (plan=${attrs.plan}, site=${attrs.site}, os=${attrs.operating_system})`);
      const created = await client.createServer(attrs);
      log(ctx, 'info', `server ${created.id} created (status=${created.status}); waiting for it to come up`);

      // Poll until ready (IP assigned + status ready), or fail/timeout.
      const deadline = Date.now() + pollTimeoutMs;
      let server = created;
      while (!(READY_STATUSES.has(server.status) && server.primary_ipv4)) {
        if (FAILED_STATUSES.has(server.status)) {
          throw new Error(`LatitudeDriver.provision: server ${server.id} entered status '${server.status}'`);
        }
        if (ctx.signal?.aborted) throw new Error('LatitudeDriver.provision: aborted');
        if (Date.now() >= deadline) {
          throw new Error(
            `LatitudeDriver.provision: server ${server.id} not ready after ${Math.round(pollTimeoutMs / 1000)}s ` +
              `(last status '${server.status}', ip=${server.primary_ipv4 ?? 'none'})`,
          );
        }
        await sleep(pollIntervalMs);
        server = await client.getServer(server.id);
      }

      log(ctx, 'info', `server ${server.id} ready at ${server.primary_ipv4}`);
      return {
        id: server.id,
        target: 'latitude',
        placement: 'remote',
        host: server.primary_ipv4,
        kind: config.kind === 'metal' ? 'metal' : 'vm',
        region: config.region,
        meta: { planSlug: server.planSlug, ipv6: server.primary_ipv6, hostname: server.hostname },
      };
    },

    async install(_frame, _config, _ctx): Promise<void> {
      throw PENDING_INSTALL('install');
    },

    async join(_frame, _config, _ctx): Promise<void> {
      throw PENDING_INSTALL('join');
    },

    async teardown(frame, config, ctx): Promise<void> {
      const client = clientFor(config);
      log(ctx, 'info', `destroying server ${frame.id} (teardown = DESTROY → ends billing)`);
      await client.deleteServer(frame.id);
      log(ctx, 'info', `server ${frame.id} destroyed`);
    },
  };
}

/** The default LatitudeDriver (resolves its API key + client per call). */
export const LatitudeDriver: DeploymentDriver = makeLatitudeDriver();
