/**
 * The relay VM's daemon (plan public-blind-relay-2026-10-01, P-001): argument
 * parsing, and a bundle that needs nothing at runtime but hyperdht +
 * blind-relay (the only deps provision-relay-vm.sh installs on the VM).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseDaemonArgs } from './blind-relay-daemon';
// @ts-expect-error — plain .mjs build script, no type declarations
import { buildRelayDaemon, RUNTIME_DEPS } from './build-relay-daemon.mjs';

describe('parseDaemonArgs', () => {
  it('requires --seed-file', () => {
    expect(() => parseDaemonArgs([])).toThrow(/--seed-file/);
  });
  it('parses seed file, port and stats interval', () => {
    expect(parseDaemonArgs(['--seed-file', '/etc/relay/seed.hex', '--port', '49737', '--stats-sec', '60'])).toEqual({
      seedFile: '/etc/relay/seed.hex',
      port: 49737,
      statsSec: 60,
    });
  });
  it('defaults the stats interval and leaves the port unset', () => {
    expect(parseDaemonArgs(['--seed-file', 's'])).toEqual({ seedFile: 's', statsSec: 300 });
  });
  it('refuses a bad port, a bad interval and unknown flags', () => {
    expect(() => parseDaemonArgs(['--seed-file', 's', '--port', '70000'])).toThrow(/--port/);
    expect(() => parseDaemonArgs(['--seed-file', 's', '--stats-sec', '0'])).toThrow(/--stats-sec/);
    expect(() => parseDaemonArgs(['--seed-file', 's', '--verbose'])).toThrow(/unknown/);
  });
});

describe('buildRelayDaemon', () => {
  const out = mkdtempSync(join(tmpdir(), 'relay-build-'));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('emits a bundle whose only non-builtin imports are the pinned runtime deps', async () => {
    const r = (await buildRelayDaemon(out)) as { outfile: string; packageJson: string };
    const bundle = readFileSync(r.outfile, 'utf8');
    const specifiers = new Set(
      [...bundle.matchAll(/(?:from\s+|import\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!),
    );
    const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
    const external = [...specifiers].filter((s) => !builtins.has(s));
    expect(external.sort()).toEqual([...RUNTIME_DEPS].sort());

    const pkg = JSON.parse(readFileSync(r.packageJson, 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([...RUNTIME_DEPS].sort());
    for (const v of Object.values(pkg.dependencies)) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bundle).toContain('blind relay seed must be');
  }, 60_000);
});
