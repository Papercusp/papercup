/**
 * Minimal Latitude.sh REST client (the bits the deployment driver needs).
 *
 * `cloud-deployment-layer-2026-06-06` P-009. Latitude.sh is the first cloud
 * backend (D-003). API: `POST /servers` (JSON:API envelope, `Authorization:
 * Bearer <key>`) → 201; `GET /servers/{id}` to poll status; `DELETE /servers/{id}`
 * to destroy (teardown = DESTROY, to end billing — P-012).
 *
 * `fetchImpl` is injectable so the driver is unit-testable with a mocked HTTP
 * layer (no live account needed); the default is the global `fetch`.
 */

/** Attributes for `POST /servers` `data.attributes` (the documented contract). */
export interface LatitudeServerAttributes {
  /** Project id or slug (required). */
  project: string;
  /** Plan slug — e.g. `m4-metal-small` (required). Determines VM vs bare metal. */
  plan: string;
  /** Site code — e.g. `ASH`, `NYC` (required). */
  site: string;
  /** OS slug — e.g. `ubuntu_22_04_x64_lts` (required). */
  operating_system: string;
  hostname?: string;
  /** SSH key ids to inject (for the driver's post-provision install over SSH). */
  ssh_keys?: string[];
  /** User-data id for a post-deploy cloud-init script. */
  user_data?: string;
  /** `hourly` keeps a torn-down frame from billing past its run (P-012 default). */
  billing?: 'hourly' | 'monthly' | 'yearly';
  raid?: 'raid-0' | 'raid-1' | null;
}

/** The normalized server view the driver consumes (flattened from the envelope). */
export interface LatitudeServer {
  id: string;
  /** e.g. `off` | `deploying` | `on` | `active` | `failed`. */
  status: string;
  primary_ipv4?: string;
  primary_ipv6?: string;
  hostname?: string;
  planSlug?: string;
  /** The raw `data` object, for diagnostics / driver `Frame.meta`. */
  raw?: unknown;
}

export class LatitudeApiError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Latitude API ${op} failed (HTTP ${status}): ${typeof body === 'string' ? body : JSON.stringify(body)?.slice(0, 400)}`);
    this.name = 'LatitudeApiError';
  }
}

/** A plan's live stock view (flattened from `GET /plans` regions[].locations). */
export interface LatitudePlanStock {
  slug: string;
  /** Site codes with live stock, in catalog order. VOLATILE — re-query per provision. */
  inStock: string[];
}

/** Pick a site with live stock for a plan — preferred sites first, else first in stock.
 *  Stock is volatile (observed live 2026-06-06: consuming a site's last unit 422'd the
 *  next create with SERVERS_OUT_OF_STOCK), so pick from a fresh listPlans() result. */
export function pickInStockSite(
  plans: LatitudePlanStock[],
  planSlug: string,
  preferred: string[] = [],
): string | undefined {
  const stock = plans.find((p) => p.slug === planSlug)?.inStock ?? [];
  return preferred.find((s) => stock.includes(s)) ?? stock[0];
}

export interface LatitudeApiClient {
  createServer(attrs: LatitudeServerAttributes): Promise<LatitudeServer>;
  getServer(id: string): Promise<LatitudeServer>;
  deleteServer(id: string): Promise<void>;
  /** Live plan→stock catalog (for in-stock site selection before a create). */
  listPlans(): Promise<LatitudePlanStock[]>;
}

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Flatten a JSON:API `{ data: { id, attributes } }` server response. */
function parseServer(json: unknown): LatitudeServer {
  const data = (json as { data?: Record<string, unknown> } | null)?.data ?? {};
  const attrs = (data.attributes as Record<string, unknown> | undefined) ?? {};
  const plan = attrs.plan as { slug?: string } | undefined;
  return {
    id: String(data.id ?? ''),
    status: String(attrs.status ?? 'unknown'),
    primary_ipv4: attrs.primary_ipv4 as string | undefined,
    primary_ipv6: attrs.primary_ipv6 as string | undefined,
    hostname: attrs.hostname as string | undefined,
    planSlug: plan?.slug,
    raw: data,
  };
}

export function createLatitudeApiClient(opts: {
  apiKey: string;
  baseUrl?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
}): LatitudeApiClient {
  const baseUrl = (opts.baseUrl ?? 'https://api.latitude.sh').replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const headers = {
    Authorization: `Bearer ${opts.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  return {
    async createServer(attrs) {
      const res = await fetchImpl(`${baseUrl}/servers`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ data: { type: 'servers', attributes: attrs } }),
      });
      const json = await res.json().catch(() => null);
      if (res.status !== 201 && res.status !== 200) throw new LatitudeApiError('createServer', res.status, json);
      return parseServer(json);
    },
    async getServer(id) {
      const res = await fetchImpl(`${baseUrl}/servers/${encodeURIComponent(id)}`, { headers });
      const json = await res.json().catch(() => null);
      if (res.status !== 200) throw new LatitudeApiError('getServer', res.status, json);
      return parseServer(json);
    },
    async deleteServer(id) {
      const res = await fetchImpl(`${baseUrl}/servers/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
      if (res.status !== 200 && res.status !== 204) {
        const body = await res.text().catch(() => '');
        throw new LatitudeApiError('deleteServer', res.status, body);
      }
    },
    async listPlans() {
      const res = await fetchImpl(`${baseUrl}/plans`, { headers });
      const json = await res.json().catch(() => null);
      if (res.status !== 200) throw new LatitudeApiError('listPlans', res.status, json);
      const data = (json as { data?: Array<Record<string, unknown>> } | null)?.data ?? [];
      return data.map((p) => {
        const attrs = (p.attributes as Record<string, unknown> | undefined) ?? {};
        const regions =
          (attrs.regions as Array<{ locations?: { in_stock?: string[] } }> | undefined) ?? [];
        return {
          slug: String(attrs.slug ?? ''),
          inStock: regions.flatMap((r) => r.locations?.in_stock ?? []),
        };
      });
    },
  };
}
