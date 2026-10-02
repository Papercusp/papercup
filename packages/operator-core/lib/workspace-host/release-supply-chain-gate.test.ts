import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
// Overridable so scripts/mutation-probe.sh can point the suite at a copy outside the tree.
const SCRIPT = process.env.RELEASE_SUPPLY_CHAIN_SCRIPT ?? join(ROOT, 'infra/images/bootc/release-supply-chain.sh');
const DIGEST = 'sha256:' + '1'.repeat(64);

const genericKernelCpe = {
  artifact: { name: 'kernel-core', type: 'rpm', version: '5.14.0-730.el9' },
  vulnerability: {
    id: 'CVE-2024-1086',
    namespace: 'nvd:cpe',
    severity: 'High',
    fix: { state: 'fixed', versions: ['5.15.149'] },
  },
};

const vendorKernelFinding = {
  artifact: { name: 'kernel-core', type: 'rpm', version: '5.14.0-730.el9' },
  vulnerability: {
    id: 'RHSA-2026:1234',
    namespace: 'redhat:distro',
    severity: 'High',
    fix: { state: 'fixed', versions: ['5.14.0-731.el9'] },
  },
};

const nonKernelNvdFinding = {
  artifact: { name: 'openssl-libs', type: 'rpm', version: '3.0.7-30.el9' },
  vulnerability: {
    id: 'CVE-2026-9999',
    namespace: 'nvd:cpe',
    severity: 'Critical',
    fix: { state: 'fixed', versions: ['3.0.7-31.el9'] },
  },
};

const tempDirs: string[] = [];

function runGate(matches: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'release-supply-chain-gate-'));
  tempDirs.push(dir);
  const bin = join(dir, 'bin');
  const out = join(dir, 'out');
  const key = join(dir, 'release.key');
  const pubkey = join(dir, 'release.pub');
  const fixture = join(dir, 'vulns.json');
  mkdirSync(bin);
  mkdirSync(out);
  writeFileSync(key, 'fixture key\n');
  writeFileSync(pubkey, 'fixture pubkey\n');
  writeFileSync(fixture, JSON.stringify({ matches }));

  writeFileSync(
    join(bin, 'sudo'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '[ "\${1:-}" = "-n" ] && shift',
      'exec "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'podman'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf "%s\\n" "$*" >> "$PODMAN_CALL_LOG"',
      'if [[ " $* " == *" skopeo "* ]]; then',
      "  printf '%s\\n' '__DIGEST__'",
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n').replace('__DIGEST__', DIGEST),
    { mode: 0o755 },
  );
  const podmanCallLog = join(dir, 'podman-calls.log');
  writeFileSync(podmanCallLog, '');
  writeFileSync(
    join(bin, 'syft'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'write_sbom() {',
      '  out="\${1#*=}"',
      `  printf '%s' '{"artifacts":[{}' > "$out"`,
      '  for _ in $(seq 1 49); do printf ",{}" >> "$out"; done',
      `  printf '%s\\n' ']}' >> "$out"`,
      '}',
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    spdx-json=*) write_sbom "$arg" ;;',
      '    syft-json=*) write_sbom "$arg" ;;',
      '  esac',
      'done',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'grype'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "\${1:-}" = "db" ] && [ "\${2:-}" = "status" ]; then',
      "  printf 'Status: valid\\n'",
      'else',
      '  cat "$GRYPE_FIXTURE"',
      'fi',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const result = spawnSync(
    'bash',
    [
      SCRIPT,
      '--image',
      'registry.example.com/papercusp/workspace-host:fixture',
      '--key',
      key,
      '--pubkey',
      pubkey,
      '--out',
      out,
      '--fail-on-vulns',
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        PATH: bin + ':' + (process.env.PATH ?? ''),
        PODMAN_CALL_LOG: podmanCallLog,
        GRYPE_FIXTURE: fixture,
        SYFT_BIN: join(bin, 'syft'),
        GRYPE_BIN: join(bin, 'grype'),
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  return {
    status: result.status ?? -1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
    podmanCalls: readFileSync(podmanCallLog, 'utf8').split('\n').filter(Boolean),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('release supply-chain cosign container identity (WI-10005606)', () => {
  it('runs every cosign container as the caller uid:gid, so a 0600 release key stays readable', () => {
    // The cosign image defaults to uid 65532, which cannot open a 0600 key owned by the
    // caller. Measured 2026-10-02: signing died with "open /keys/cosign.key: permission
    // denied" after a full image build.
    const result = runGate([]);
    expect(result.status, result.output).toBe(0);
    const cosignCalls = result.podmanCalls.filter((call) => call.includes('/keys:') || call.includes('/keys '));
    const signAndVerify = result.podmanCalls.filter((call) => / (sign|attest|verify|verify-attestation) /.test(call));
    expect(signAndVerify.length).toBeGreaterThanOrEqual(4);
    const expectedUser = `--user ${process.getuid!()}:${process.getgid!()}`;
    for (const call of [...cosignCalls, ...signAndVerify]) {
      expect(call).toContain(expectedUser);
      expect(call).toContain('-e HOME=/tmp');
    }
  });
});

describe('release supply-chain vulnerability gate', () => {
  it('does not fail an EL9 kernel solely on a generic upstream NVD CPE fixed version', () => {
    const result = runGate([genericKernelCpe]);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('GRYPE_GENERIC_KERNEL_CPE_EXCLUDED=1');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=0');
    expect(result.output).toContain('SUPPLY_CHAIN_RESULT=PASS');
  });

  it('keeps vendor-confirmed kernel findings and unrelated NVD findings actionable', () => {
    const result = runGate([genericKernelCpe, vendorKernelFinding, nonKernelNvdFinding]);

    expect(result.status, result.output).toBe(3);
    expect(result.output).toContain('GRYPE_GENERIC_KERNEL_CPE_EXCLUDED=1');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=2');
    expect(result.output).toContain('SUPPLY_CHAIN_RESULT=VULN_GATE_REFUSED');
  });

  it('does not apply the EL9 exception to a non-EL9 kernel package', () => {
    const result = runGate([
      {
        ...genericKernelCpe,
        artifact: { ...genericKernelCpe.artifact, version: '6.8.0-31-generic' },
      },
    ]);

    expect(result.status, result.output).toBe(3);
    expect(result.output).toContain('GRYPE_GENERIC_KERNEL_CPE_EXCLUDED=0');
    expect(result.output).toContain('GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=1');
    expect(result.output).toContain('SUPPLY_CHAIN_RESULT=VULN_GATE_REFUSED');
  });
});
