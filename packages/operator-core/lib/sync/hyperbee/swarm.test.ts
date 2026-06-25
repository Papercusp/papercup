import { afterEach, describe, expect, it } from 'vitest';
import { parseDhtBootstrap, parseDhtHost, swarmConstructorOpts } from './swarm';

// ─── parseDhtBootstrap ──────────────────────────────────────────────────────────

describe('parseDhtBootstrap', () => {
  it('returns undefined for unset / empty / whitespace', () => {
    expect(parseDhtBootstrap(undefined)).toBeUndefined();
    expect(parseDhtBootstrap('')).toBeUndefined();
    expect(parseDhtBootstrap('   ')).toBeUndefined();
  });

  it('parses a comma-separated host:port list', () => {
    expect(parseDhtBootstrap('127.0.0.1:49737,127.0.0.1:49738,10.0.0.5:1234')).toEqual([
      { host: '127.0.0.1', port: 49737 },
      { host: '127.0.0.1', port: 49738 },
      { host: '10.0.0.5', port: 1234 },
    ]);
  });

  it('trims whitespace around entries', () => {
    expect(parseDhtBootstrap(' 127.0.0.1:1 , 127.0.0.1:2 ')).toEqual([
      { host: '127.0.0.1', port: 1 },
      { host: '127.0.0.1', port: 2 },
    ]);
  });

  it('drops malformed entries (no port, bad port, leading colon) but keeps the valid ones', () => {
    expect(parseDhtBootstrap('127.0.0.1:49737,nope,:5,host:notaport,1.2.3.4:0')).toEqual([
      { host: '127.0.0.1', port: 49737 },
    ]);
  });

  it('returns undefined when every entry is malformed', () => {
    expect(parseDhtBootstrap('nope,:5,host:abc')).toBeUndefined();
  });
});

// ─── swarmConstructorOpts ────────────────────────────────────────────────────────

describe('swarmConstructorOpts', () => {
  const SAVED = {
    bootstrap: process.env.PAPERCUSP_DHT_BOOTSTRAP,
    dhtHost: process.env.PAPERCUSP_DHT_HOST,
    maxPeers: process.env.PAPERCUSP_SWARM_MAX_PEERS,
  };
  afterEach(() => {
    // restore
    if (SAVED.bootstrap === undefined) delete process.env.PAPERCUSP_DHT_BOOTSTRAP;
    else process.env.PAPERCUSP_DHT_BOOTSTRAP = SAVED.bootstrap;
    if (SAVED.dhtHost === undefined) delete process.env.PAPERCUSP_DHT_HOST;
    else process.env.PAPERCUSP_DHT_HOST = SAVED.dhtHost;
    if (SAVED.maxPeers === undefined) delete process.env.PAPERCUSP_SWARM_MAX_PEERS;
    else process.env.PAPERCUSP_SWARM_MAX_PEERS = SAVED.maxPeers;
  });

  it('omits bootstrap when PAPERCUSP_DHT_BOOTSTRAP is unset (uses the public DHT)', () => {
    delete process.env.PAPERCUSP_DHT_BOOTSTRAP;
    const opts = swarmConstructorOpts();
    expect(opts.bootstrap).toBeUndefined();
    expect(opts.maxPeers).toBe(256); // default
  });

  it('includes bootstrap nodes when PAPERCUSP_DHT_BOOTSTRAP is set', () => {
    process.env.PAPERCUSP_DHT_BOOTSTRAP = '127.0.0.1:49737,127.0.0.1:49738';
    expect(swarmConstructorOpts().bootstrap).toEqual([
      { host: '127.0.0.1', port: 49737 },
      { host: '127.0.0.1', port: 49738 },
    ]);
  });

  it('honors PAPERCUSP_SWARM_MAX_PEERS override', () => {
    process.env.PAPERCUSP_SWARM_MAX_PEERS = '8';
    expect(swarmConstructorOpts().maxPeers).toBe(8);
  });

  it('trims and omits empty PAPERCUSP_DHT_HOST values', () => {
    expect(parseDhtHost(undefined)).toBeUndefined();
    expect(parseDhtHost('   ')).toBeUndefined();
    expect(parseDhtHost(' 10.99.0.1 ')).toBe('10.99.0.1');
  });

  it('includes an explicit DHT host when PAPERCUSP_DHT_HOST is set', () => {
    process.env.PAPERCUSP_DHT_HOST = '10.99.0.2';
    expect(swarmConstructorOpts().dhtHost).toBe('10.99.0.2');
  });
});
