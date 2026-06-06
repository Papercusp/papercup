/**
 * Minimal Hetzner Cloud client (`cloud-deployment-layer-2026-06-06` P-018 —
 * the SECOND driver that proves the abstraction isn't Latitude-shaped).
 *
 * Hetzner's API shape is DELIBERATELY different from Latitude's: a flat
 * `{ server: { id, status, public_net: { ipv4: { ip } } } }` envelope (not
 * JSON:API `data.attributes`), `server_type`/`image`/`location` attributes (not
 * `plan`/`operating_system`/`site`). That the same `DeploymentDriver` interface
 * absorbs both differences is the point of P-018.
 */
export interface HetznerServerAttributes {
  name: string;
  /** Instance type slug — e.g. `cx22` (from config.size). */
  server_type: string;
  /** Image slug — e.g. `ubuntu-22.04`. */
  image: string;
  /** Datacenter location — e.g. `nbg1`, `ash` (from config.region). */
  location?: string;
  ssh_keys?: Array<string | number>;
  user_data?: string;
  start_after_create?: boolean;
}

export interface HetznerServer {
  id: string;
  /** `initializing` | `starting` | `running` | `off` | … */
  status: string;
  ipv4?: string;
  raw?: unknown;
}

export class HetznerApiError extends Error {
  constructor(readonly op: string, readonly status: number, readonly body: unknown) {
    super(`Hetzner API ${op} failed (HTTP ${status}): ${typeof body === 'string' ? body : JSON.stringify(body)?.slice(0, 400)}`);
    this.name = 'HetznerApiError';
  }
}

export interface HetznerApiClient {
  createServer(attrs: HetznerServerAttributes): Promise<HetznerServer>;
  getServer(id: string): Promise<HetznerServer>;
  deleteServer(id: string): Promise<void>;
}

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

function parseServer(json: unknown): HetznerServer {
  const s = (json as { server?: Record<string, unknown> } | null)?.server ?? {};
  const publicNet = s.public_net as { ipv4?: { ip?: string } } | undefined;
  return {
    id: String(s.id ?? ''),
    status: String(s.status ?? 'unknown'),
    ipv4: publicNet?.ipv4?.ip,
    raw: s,
  };
}

export function createHetznerApiClient(opts: {
  apiToken: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}): HetznerApiClient {
  const baseUrl = (opts.baseUrl ?? 'https://api.hetzner.cloud/v1').replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const headers = {
    Authorization: `Bearer ${opts.apiToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  return {
    async createServer(attrs) {
      const res = await fetchImpl(`${baseUrl}/servers`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ start_after_create: true, image: 'ubuntu-22.04', ...attrs }),
      });
      const json = await res.json().catch(() => null);
      if (res.status !== 201 && res.status !== 200) throw new HetznerApiError('createServer', res.status, json);
      return parseServer(json);
    },
    async getServer(id) {
      const res = await fetchImpl(`${baseUrl}/servers/${encodeURIComponent(id)}`, { headers });
      const json = await res.json().catch(() => null);
      if (res.status !== 200) throw new HetznerApiError('getServer', res.status, json);
      return parseServer(json);
    },
    async deleteServer(id) {
      const res = await fetchImpl(`${baseUrl}/servers/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
      // Hetzner returns 200 (with an action) or 204 on delete.
      if (res.status !== 200 && res.status !== 204) {
        const body = await res.text().catch(() => '');
        throw new HetznerApiError('deleteServer', res.status, body);
      }
    },
  };
}
