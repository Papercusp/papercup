/**
 * external-app-access P-009 — the user's own tunnel: config builder (R-21), cert.pem parsing,
 * and idempotent provisioning against an in-memory fake of the Cloudflare API.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARED_CATCH_ALL_SERVICE,
  OwnTunnelInputError,
  buildCloudflaredIngress,
  normalizeHostname,
  parseArgoTunnelCert,
  parseLoginUrl,
  publicMcpUrl,
  tunnelNameFor,
  zoneCandidates,
} from './config';
import { CloudflareApiError, cloudflareApi } from './cloudflare-api';
import { provisionCloudflareTunnel, removeCloudflareTunnel } from './provision';

// The external-ingress listener's port and the operator's own port, as literals: the oracle for
// R-21 is "127.0.0.1:<ingress port>", written out here, not computed by the code under test.
const INGRESS_PORT = 38111;
const OPERATOR_PORT = 3070;

describe('R-21: the generated cloudflared ingress targets the external-ingress listener', () => {
  it('forwards the chosen hostname to the ingress listener on loopback, and nothing else', () => {
    const cfg = buildCloudflaredIngress({ hostname: 'Papercusp.Example.com', ingressPort: INGRESS_PORT });
    expect(cfg).toEqual({
      ingress: [
        { hostname: 'papercusp.example.com', service: 'http://127.0.0.1:38111' },
        { service: 'http_status:404' },
      ],
    });
    expect(JSON.stringify(cfg)).not.toContain(`:${OPERATOR_PORT}`);
  });

  it('never rewrites Host (D-020): no originRequest, no httpHostHeader', () => {
    const text = JSON.stringify(buildCloudflaredIngress({ hostname: 'a.example.com', ingressPort: INGRESS_PORT }));
    expect(text).not.toContain('httpHostHeader');
    expect(text).not.toContain('originRequest');
  });

  it('ends with the 404 catch-all cloudflared requires', () => {
    const cfg = buildCloudflaredIngress({ hostname: 'a.example.com', ingressPort: INGRESS_PORT });
    expect(cfg.ingress.at(-1)).toEqual({ service: CLOUDFLARED_CATCH_ALL_SERVICE });
  });

  it('refuses a port outside 1..65535', () => {
    expect(() => buildCloudflaredIngress({ hostname: 'a.example.com', ingressPort: 0 })).toThrow(OwnTunnelInputError);
    expect(() => buildCloudflaredIngress({ hostname: 'a.example.com', ingressPort: 70000 })).toThrow(/between 1 and 65535/);
  });
});

describe('hostname handling', () => {
  it('normalizes scheme, path, port, case and trailing dot', () => {
    expect(normalizeHostname(' HTTPS://Pc.Example.COM:443/api/mcp ')).toBe('pc.example.com');
    expect(normalizeHostname('pc.example.com.')).toBe('pc.example.com');
  });
  it('refuses single labels, IPs and bad labels', () => {
    for (const bad of ['localhost', '10.0.0.1', 'under_score.example.com', '-a.example.com', '']) {
      expect(() => normalizeHostname(bad), bad).toThrow(OwnTunnelInputError);
    }
  });
  it('lists zone candidates longest first down to two labels', () => {
    expect(zoneCandidates('a.b.example.com')).toEqual(['a.b.example.com', 'b.example.com', 'example.com']);
  });
  it('builds the public MCP URL and a stable tunnel name', () => {
    expect(publicMcpUrl('pc.example.com')).toBe('https://pc.example.com/api/mcp');
    expect(tunnelNameFor('Dev Box!')).toBe('papercusp-dev-box');
    expect(tunnelNameFor('')).toBe('papercusp-local');
  });
});

describe('cloudflared tunnel login output', () => {
  const token = { zoneID: 'zone-1', accountID: 'acct-1', apiToken: 'tok-abc' };
  const block = (json: string) =>
    ['-----BEGIN ARGO TUNNEL TOKEN-----', Buffer.from(json).toString('base64').replace(/(.{20})/g, '$1\n'), '-----END ARGO TUNNEL TOKEN-----'].join('\n');

  it('reads zone, account and API token from the ARGO TUNNEL TOKEN block', () => {
    expect(parseArgoTunnelCert(`preamble\n${block(JSON.stringify(token))}\n`)).toEqual({
      accountId: 'acct-1',
      zoneId: 'zone-1',
      apiToken: 'tok-abc',
    });
  });
  it('returns null without the block or with incomplete JSON', () => {
    expect(parseArgoTunnelCert('no token here')).toBeNull();
    expect(parseArgoTunnelCert(block('{"zoneID":"z"}'))).toBeNull();
    expect(parseArgoTunnelCert(block('not json'))).toBeNull();
  });
  it('finds the sign-in URL cloudflared prints', () => {
    const url = 'https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fabc';
    expect(parseLoginUrl(`Please open the following URL and log in with your Cloudflare account:\n\n${url}\n\nLeave cloudflared running`)).toBe(url);
    expect(parseLoginUrl('starting…')).toBeNull();
  });
});

/** In-memory fake of the Cloudflare API endpoints the provisioner uses. */
function fakeCloudflare(opts: { records?: Array<Record<string, unknown>> } = {}) {
  const zones = [{ id: 'zone-1', name: 'example.com' }];
  const tunnels: Array<{ id: string; name: string; deleted_at: string | null; config?: unknown }> = [];
  const records: Array<Record<string, unknown>> = [...(opts.records ?? [])];
  let n = 0;
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
  const notFound = () => new Response(JSON.stringify({ success: false, errors: [{ code: 1003, message: 'not found' }] }), { status: 404 });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/client\/v4/, '');
    if (new Headers(init?.headers).get('authorization') !== 'Bearer tok-abc') {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    let m: RegExpMatchArray | null;
    if (method === 'GET' && path === '/zones') return ok(zones.filter((z) => z.name === url.searchParams.get('name')));
    if (method === 'GET' && (m = path.match(/^\/zones\/([^/]+)$/))) {
      const z = zones.find((x) => x.id === m![1]);
      return z ? ok(z) : notFound();
    }
    if (path.match(/^\/accounts\/[^/]+\/cfd_tunnel$/)) {
      if (method === 'GET') return ok(tunnels.filter((t) => t.name === url.searchParams.get('name') && !t.deleted_at));
      const t = { id: `tun-${++n}`, name: body.name, deleted_at: null };
      tunnels.push(t);
      return ok(t);
    }
    if ((m = path.match(/^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/configurations$/))) {
      const t = tunnels.find((x) => x.id === m![1]);
      if (!t) return notFound();
      t.config = body.config;
      return ok({});
    }
    if ((m = path.match(/^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/token$/))) return ok(`run-token-for-${m[1]}-${'x'.repeat(24)}`);
    if (path.match(/^\/accounts\/[^/]+\/cfd_tunnel\/[^/]+\/connections$/)) return ok({});
    if (method === 'DELETE' && (m = path.match(/^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)$/))) {
      const t = tunnels.find((x) => x.id === m![1]);
      if (!t || t.deleted_at) return notFound();
      t.deleted_at = 'now';
      return ok({});
    }
    if (path.match(/^\/zones\/[^/]+\/dns_records$/)) {
      if (method === 'GET') return ok(records.filter((r) => r.name === url.searchParams.get('name')));
      const r = { id: `rec-${++n}`, ...body };
      records.push(r);
      return ok(r);
    }
    if (method === 'DELETE' && (m = path.match(/^\/zones\/[^/]+\/dns_records\/([^/]+)$/))) {
      const i = records.findIndex((r) => r.id === m![1]);
      if (i < 0) return notFound();
      records.splice(i, 1);
      return ok({});
    }
    return notFound();
  }) as typeof fetch;
  const base = 'http://cf.test/client/v4';
  return { api: cloudflareApi({ apiToken: 'tok-abc', fetch: fetchFn, baseUrl: base }), fetchFn, base, tunnels, records };
}

const INPUT = { accountId: 'acct-1', zoneId: 'zone-1', hostname: 'pc.example.com', ingressPort: INGRESS_PORT, tunnelName: 'papercusp-box' };

describe('provisionCloudflareTunnel', () => {
  it('creates a remotely managed tunnel whose ingress goes to the ingress listener, plus a proxied CNAME', async () => {
    const cf = fakeCloudflare();
    const out = await provisionCloudflareTunnel(cf.api, INPUT);
    expect(out).toMatchObject({ zoneName: 'example.com', hostname: 'pc.example.com', tunnelId: 'tun-1', tunnelName: 'papercusp-box' });
    expect(out.runToken).toMatch(/^run-token-for-tun-1-/);
    expect(cf.tunnels[0]!.config).toEqual({
      ingress: [{ hostname: 'pc.example.com', service: 'http://127.0.0.1:38111' }, { service: 'http_status:404' }],
    });
    expect(cf.records).toEqual([
      expect.objectContaining({ type: 'CNAME', name: 'pc.example.com', content: 'tun-1.cfargotunnel.com', proxied: true }),
    ]);
  });

  it('is idempotent: a second run reuses the tunnel and the CNAME', async () => {
    const cf = fakeCloudflare();
    const first = await provisionCloudflareTunnel(cf.api, INPUT);
    const second = await provisionCloudflareTunnel(cf.api, INPUT);
    expect(second.tunnelId).toBe(first.tunnelId);
    expect(second.dnsRecordId).toBe(first.dnsRecordId);
    expect(cf.tunnels).toHaveLength(1);
    expect(cf.records).toHaveLength(1);
  });

  it('refuses a hostname that already has another record, and writes no DNS', async () => {
    const cf = fakeCloudflare({ records: [{ id: 'r0', type: 'A', name: 'pc.example.com', content: '192.0.2.1' }] });
    await expect(provisionCloudflareTunnel(cf.api, INPUT)).rejects.toMatchObject({ code: 'hostname_taken' });
    expect(cf.records).toHaveLength(1);
  });

  it('refuses a hostname outside the zone the user signed in to, before creating anything', async () => {
    const cf = fakeCloudflare();
    await expect(provisionCloudflareTunnel(cf.api, { ...INPUT, hostname: 'pc.other.org' })).rejects.toMatchObject({
      code: 'hostname_outside_zone',
    });
    expect(cf.tunnels).toHaveLength(0);
  });

  it('finds the zone from the hostname when the user pasted a token', async () => {
    const cf = fakeCloudflare();
    const out = await provisionCloudflareTunnel(cf.api, { ...INPUT, zoneId: null, hostname: 'a.pc.example.com' });
    expect(out.zoneId).toBe('zone-1');
    await expect(provisionCloudflareTunnel(cf.api, { ...INPUT, zoneId: null, hostname: 'pc.nowhere.net' })).rejects.toMatchObject({
      code: 'zone_not_found',
    });
  });

  it('surfaces a refused token as an auth error', async () => {
    const cf = fakeCloudflare();
    const bad = cloudflareApi({ apiToken: 'wrong', fetch: cf.fetchFn, baseUrl: cf.base });
    const err = await provisionCloudflareTunnel(bad, INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareApiError);
    expect((err as CloudflareApiError).isAuth).toBe(true);
    expect(cf.tunnels).toHaveLength(0);
  });
});

describe('removeCloudflareTunnel', () => {
  it('deletes only our CNAME, then the tunnel; a second removal is a no-op', async () => {
    const cf = fakeCloudflare({ records: [{ id: 'keep', type: 'TXT', name: 'pc2.example.com', content: 'verify' }] });
    const out = await provisionCloudflareTunnel(cf.api, { ...INPUT, hostname: 'pc2.example.com' }).catch((e) => e);
    // A TXT record on the name blocks provisioning (it is "another record"), so remove it first.
    expect(out).toMatchObject({ code: 'hostname_taken' });
    cf.records.splice(0, 1, { id: 'keep', type: 'TXT', name: 'other.example.com', content: 'verify' });
    const done = await provisionCloudflareTunnel(cf.api, { ...INPUT, hostname: 'pc2.example.com' });
    await removeCloudflareTunnel(cf.api, done);
    expect(cf.records.map((r) => r.id)).toEqual(['keep']);
    expect(cf.tunnels[0]!.deleted_at).toBe('now');
    await expect(removeCloudflareTunnel(cf.api, done)).resolves.toBeUndefined();
  });
});
