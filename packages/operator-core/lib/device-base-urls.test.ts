/**
 * device-base-urls — the mesh → lan → tunnel advertise list behind device
 * pairing/discovery (on-desktop-direct-lan-voice-2026-07-14 P-005).
 * Interfaces + env are injected so the tests are host-independent.
 */
import { describe, expect, it } from 'vitest';
import {
  advertisedBaseUrls,
  lanAddressFrom,
  meshAddressFrom,
} from './device-base-urls';

type IfaceMap = Parameters<typeof lanAddressFrom>[0];

function iface(address: string, opts?: { internal?: boolean; family?: 'IPv4' | 'IPv6' }) {
  return {
    address,
    netmask: '255.255.255.0',
    family: (opts?.family ?? 'IPv4') as 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: opts?.internal ?? false,
    cidr: `${address}/24`,
  };
}

/** A realistic dev-box layout: loopback, wifi LAN, docker bridge, WG mesh. */
const DEV_BOX: IfaceMap = {
  lo: [iface('127.0.0.1', { internal: true })],
  wlp183s0: [iface('192.168.40.216')],
  docker0: [iface('172.17.0.1')],
  papercusp: [iface('10.10.0.2')],
};

describe('lanAddressFrom', () => {
  it('picks the first RFC1918 IPv4, skipping loopback', () => {
    expect(lanAddressFrom(DEV_BOX)).toBe('192.168.40.216');
  });

  it('never advertises a mesh interface IP as LAN', () => {
    const meshOnly: IfaceMap = {
      lo: [iface('127.0.0.1', { internal: true })],
      papercusp: [iface('10.10.0.2')],
      wg0: [iface('10.20.0.7')],
    };
    expect(lanAddressFrom(meshOnly)).toBeNull();
  });

  it('falls back to any non-internal IPv4 when nothing is RFC1918', () => {
    const publicOnly: IfaceMap = {
      lo: [iface('127.0.0.1', { internal: true })],
      eth0: [iface('203.0.113.9')],
    };
    expect(lanAddressFrom(publicOnly)).toBe('203.0.113.9');
  });
});

describe('meshAddressFrom', () => {
  it('finds the Defguard/WireGuard interface by name', () => {
    expect(meshAddressFrom(DEV_BOX)).toBe('10.10.0.2');
    expect(meshAddressFrom({ wg0: [iface('10.20.0.7')] })).toBe('10.20.0.7');
  });

  it('returns null when not enrolled', () => {
    expect(meshAddressFrom({ wlp183s0: [iface('192.168.40.216')] })).toBeNull();
  });
});

describe('advertisedBaseUrls', () => {
  it('orders mesh → lan → tunnel with the operator port', () => {
    const urls = advertisedBaseUrls({
      port: 3070,
      ifaces: DEV_BOX,
      env: { MOBILE_DESKTOP_PUBLIC_URL: 'https://api.example.com/' },
    });
    expect(urls).toEqual([
      { kind: 'mesh', url: 'http://10.10.0.2:3070' },
      { kind: 'lan', url: 'http://192.168.40.216:3070' },
      { kind: 'tunnel', url: 'https://api.example.com' },
    ]);
  });

  it('omits unavailable paths (no mesh, no tunnel → lan only)', () => {
    const urls = advertisedBaseUrls({
      port: 3070,
      ifaces: { wlp183s0: [iface('192.168.40.216')] },
      env: {},
    });
    expect(urls).toEqual([{ kind: 'lan', url: 'http://192.168.40.216:3070' }]);
  });

  it('MOBILE_MESH_HOST overrides interface detection (host, host:port, URL forms)', () => {
    const env = { MOBILE_MESH_HOST: 'desktop.mesh.example' };
    expect(advertisedBaseUrls({ port: 3070, ifaces: {}, env })[0]).toEqual({
      kind: 'mesh',
      url: 'http://desktop.mesh.example:3070',
    });
    expect(
      advertisedBaseUrls({ port: 3070, ifaces: {}, env: { MOBILE_MESH_HOST: '10.10.0.2:3171' } })[0],
    ).toEqual({ kind: 'mesh', url: 'http://10.10.0.2:3171' });
    expect(
      advertisedBaseUrls({
        port: 3070,
        ifaces: {},
        env: { MOBILE_MESH_HOST: 'https://mesh-gw.example/' },
      })[0],
    ).toEqual({ kind: 'mesh', url: 'https://mesh-gw.example' });
  });

  it('uses the PORT env when no explicit port is passed', () => {
    const urls = advertisedBaseUrls({
      ifaces: { wlp183s0: [iface('192.168.40.216')] },
      env: { PORT: '3170' },
    });
    expect(urls).toEqual([{ kind: 'lan', url: 'http://192.168.40.216:3170' }]);
  });
});
