import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { mediaConfig, validateCertificate, checkTlsEndpoint } from '../../../../infra/phone-app/media-config.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const deploy = join(repoRoot, 'infra/phone-app/deploy.sh');
let root: string, certPath: string, keyPath: string, shortCert: string, otherKey: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'phone-media-contract-'));
  certPath = join(root, 'turn certificate.pem'); keyPath = join(root, 'turn private.pem');
  shortCert = join(root, 'short.pem'); otherKey = join(root, 'other.pem');
  for (const [cert, key, days] of [[certPath, keyPath, '30'], [shortCert, otherKey, '1']]) {
    const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', days, '-subj', '/CN=turn.example.com',
      '-addext', 'subjectAltName=DNS:turn.example.com'], { encoding: 'utf8' });
    expect(result.status, 'generate isolated test certificate').toBe(0);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(name: string) {
  const conf = join(root, name); mkdirSync(conf);
  const original = 'PHONE_LIVEKIT_API_KEY=test-key\nPHONE_LIVEKIT_API_SECRET=test-secret-withheld\n' +
    'PHONE_LIVEKIT_URL=ws://127.0.0.1:7890\nPHONE_WORKER_SECRET=test-worker-retained\n';
  writeFileSync(join(conf, 'livekit.env'), original, { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PHONE_')));
  return { conf, original, env: { ...env, PHONE_CONFIG_DIR: conf,
    PHONE_NODE_BIN: process.execPath, PHONE_LAN_IFACE: 'test0',
    PHONE_LIVEKIT_PUBLIC_URL: 'wss://voice.example.com', PHONE_TURN_DOMAIN: 'turn.example.com',
    PHONE_TURN_CERT_FILE: certPath, PHONE_TURN_KEY_FILE: keyPath } };
}
function run(env: NodeJS.ProcessEnv, args = ['--hosted', '--render-only']) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PHONE_')));
  return spawnSync('bash', [deploy, ...args], { env: { ...base, ...env }, encoding: 'utf8', timeout: 15_000 });
}

describe('Phone existing deployer public media preparation', () => {
  it('renders valid TURN TLS YAML, preserves credentials/control and repeats from persisted input', () => {
    const f = fixture('persist');
    const first = run(f.env);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('configuration prepared only');
    expect(first.stdout + first.stderr).not.toContain('test-secret-withheld');
    const file = join(f.conf, 'livekit-server.yaml');
    const config = parse(readFileSync(file, 'utf8'));
    expect(config.turn).toMatchObject({ enabled: true, udp_port: 7893, tls_port: 7894,
      domain: 'turn.example.com', cert_file: certPath, key_file: keyPath });
    expect(config.keys).toEqual({ 'test-key': 'test-secret-withheld' });
    expect(parse(readFileSync(join(f.conf, 'livekit-sip.yaml'), 'utf8')).ws_url).toBe('ws://127.0.0.1:7890');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = readFileSync(join(f.conf, 'livekit.env'), 'utf8');
    expect(stored).toContain('PHONE_WORKER_SECRET=test-worker-retained');
    expect(stored).toContain('PHONE_LIVEKIT_URL=ws://127.0.0.1:7890');
    const before = readFileSync(file, 'utf8');
    const second = run({ PHONE_CONFIG_DIR: f.conf, PHONE_NODE_BIN: process.execPath,
      PHONE_LAN_IFACE: 'test0', PATH: process.env.PATH });
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a private WSS origin before any configuration write', () => {
    const f = fixture('unsafe');
    const result = run({ ...f.env, PHONE_LIVEKIT_PUBLIC_URL: 'wss://localhost' });
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(f.conf, 'livekit.env'), 'utf8')).toBe(f.original);
    expect(result.stdout).not.toContain('rendered livekit-server.yaml');
  });

  it('refuses mismatched or expiring certificates and missing hosted TURN', () => {
    expect(() => validateCertificate(readFileSync(certPath), readFileSync(otherKey), 'turn.example.com')).toThrow('do not match');
    expect(() => validateCertificate(readFileSync(shortCert), readFileSync(otherKey), 'turn.example.com')).toThrow('seven days');
    expect(() => validateCertificate(readFileSync(certPath), readFileSync(keyPath), 'wrong.example.com')).toThrow('hostname');
    expect(() => mediaConfig({ PHONE_LIVEKIT_PUBLIC_URL: 'wss://voice.example.com' }, true)).toThrow();
    expect(mediaConfig({}, false).turnYaml).toBe('  tls_port: 0');
  });

  it('honors caller overrides after sourcing existing coordinates', () => {
    const f = fixture('override');
    expect(run(f.env).status).toBe(0);
    expect(run({ ...f.env, PHONE_LIVEKIT_PUBLIC_URL: 'wss://new.example.com' }).status).toBe(0);
    expect(readFileSync(join(f.conf, 'livekit.env'), 'utf8')).toContain('wss://new.example.com');
  });

  it('rejects a preparation credential rotation without modifying the credential record', () => {
    const f = fixture('rotation');
    expect(run(f.env, ['--render-only', '--rotate-secret']).status).not.toBe(0);
    expect(readFileSync(join(f.conf, 'livekit.env'), 'utf8')).toBe(f.original);
  });

  it('rejects an invalid remote preflight with no config file and no service/key side effects', () => {
    const result = run({ PHONE_CONFIG_DIR: join(root, 'absent'), PHONE_NODE_BIN: process.execPath,
      PHONE_LIVEKIT_PUBLIC_URL: 'wss://localhost', PATH: process.env.PATH }, ['--preflight']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('public DNS hostname');
    expect(result.stdout).not.toContain('Credentials');
  });

  it('checks real TLS trust and hostname against a pinned address (isolated laboratory evidence)', async () => {
    const cert = readFileSync(certPath), key = readFileSync(keyPath);
    const server = createServer({ key, cert });
    server.on('tlsClientError', () => {});
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing isolated TLS listener');
    try {
      const params = { hostname: 'turn.example.com', address: '127.0.0.1', port: address.port, timeoutMs: 1000 };
      await expect(checkTlsEndpoint({ ...params, ca: cert })).resolves.toMatchObject({ hostname: 'turn.example.com' });
      await expect(checkTlsEndpoint(params)).rejects.toThrow('trust');
      await expect(checkTlsEndpoint({ ...params, hostname: 'wrong.example.com', ca: cert })).rejects.toThrow('trust');
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });
});
