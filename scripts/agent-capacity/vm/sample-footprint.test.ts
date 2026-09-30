import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The sampler runs on the test VMs with stock python3; these tests drive its pure pieces
// through the same interpreter so the class names the summary groups by stay stable.
const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLER = join(HERE, 'sample-footprint.py');

function py(body: string): unknown {
  const script = [
    'import importlib.util, json, os, sys',
    `spec = importlib.util.spec_from_file_location("sf", ${JSON.stringify(SAMPLER)})`,
    'sf = importlib.util.module_from_spec(spec); spec.loader.exec_module(sf)',
    body,
  ].join('\n');
  const r = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`python3 failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe('sample-footprint.py classify', () => {
  it('names each Papercusp Server process class the way the S7 summary groups them', () => {
    const cases = py(`print(json.dumps([
      sf.classify("MainThread", ["node", "--require", "/s/sidecar-preload.js", "/s/serve.mjs", "--ensure"]),
      sf.classify("MainThread", ["/s/bin/node", "/s/serve.mjs"]),
      sf.classify("MainThread", ["/s/bin/node", "/s/mcp-proxy.mjs"]),
      sf.classify("node", ["node", "-e", "1+1"]),
      sf.classify("postgres", ["postgres: harness_admin papercusp 127.0.0.1(54710) idle"]),
      sf.classify("postgres", ["/x/native/bin/postgres", "-D", "/data"]),
      sf.classify("papercusp-serv", ["/usr/bin/papercusp-server", "--headless-service"]),
      sf.classify("git", ["git", "fetch"]),
      sf.classify("kopia", ["/s/bin/kopia", "snapshot"]),
    ]))`);
    expect(cases).toEqual([
      'node:serve.mjs',
      'node:serve.mjs',
      'node:mcp-proxy.mjs',
      'node:?',
      'postgres',
      'postgres',
      'supervisor',
      'git',
      'kopia',
    ]);
  });
});

describe('sample-footprint.py proc_sample', () => {
  it('parses its own /proc entry, including utime+stime past the comm field', () => {
    const row = py('print(json.dumps(sf.proc_sample(os.getpid())))') as Record<string, unknown>;
    expect(row.comm).toBe('python3');
    expect(row.cls).toBe('python3');
    expect(typeof row.ticks).toBe('number');
    expect(row.rss_kb as number).toBeGreaterThan(1000);
    expect(row.anon_kb as number).toBeGreaterThan(0);
  });

  it('returns None for a pid that does not exist rather than raising', () => {
    expect(py('print(json.dumps(sf.proc_sample(2**22 + 12345)))')).toBeNull();
  });
});
