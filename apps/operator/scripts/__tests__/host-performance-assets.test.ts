import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts/systemd/papercusp-host-performance.sh');
const UNIT = join(ROOT, 'scripts/systemd/papercusp-host-performance.service');

describe('WI-37533 host performance assets', () => {
  it('has a root-owned oneshot unit with an explicit boot target and no user-writable ExecStart', () => {
    const unit = readFileSync(UNIT, 'utf8');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('ExecStart=/etc/systemd/system/papercusp-host-performance.sh');
    expect(unit).toContain('WantedBy=multi-user.target');
    expect(unit).toContain('Before=postgresql@18-main.service');
    expect(unit).toContain('RequiredBy=postgresql@18-main.service');
    expect(unit).toContain('ProtectKernelTunables=no');
  });

  it('sets and verifies governor plus EPP and the 18,000-page default in a fake sysfs tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-cpufreq-'));
    const nrHugepages = join(root, 'nr_hugepages');
    try {
      writeFileSync(nrHugepages, '0\n');
      for (const name of ['policy0', 'policy7']) {
        const policy = join(root, name);
        mkdirSync(policy);
        writeFileSync(join(policy, 'scaling_governor'), 'powersave\n');
        writeFileSync(join(policy, 'energy_performance_preference'), 'balance_performance\n');
      }
      const output = execFileSync('bash', [SCRIPT], {
        env: {
          ...process.env,
          PAPERCUSP_CPU_SYSFS_ROOT: root,
          PAPERCUSP_NR_HUGEPAGES_REQUEST_PATH: nrHugepages,
        },
        encoding: 'utf8',
      });
      expect(output).toContain('verified on 2 CPU policies');
      expect(output).toContain('huge-page reservation verified: reserved=18000 required=18000');
      expect(readFileSync(nrHugepages, 'utf8').trim()).toBe('18000');
      for (const name of ['policy0', 'policy7']) {
        expect(readFileSync(join(root, name, 'scaling_governor'), 'utf8').trim()).toBe('performance');
        expect(readFileSync(join(root, name, 'energy_performance_preference'), 'utf8').trim()).toBe('performance');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when no CPU policy exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-cpufreq-empty-'));
    try {
      expect(() =>
        execFileSync('bash', [SCRIPT], {
          env: {
            ...process.env,
            PAPERCUSP_CPU_SYSFS_ROOT: root,
            PAPERCUSP_NR_HUGEPAGES_REQUEST_PATH: join(root, 'nr_hugepages'),
          },
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails loud when Linux accepts the request but reserves fewer huge pages', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-hugepages-short-'));
    try {
      const policy = join(root, 'policy0');
      const requested = join(root, 'nr_hugepages.request');
      const observed = join(root, 'nr_hugepages.status');
      mkdirSync(policy);
      writeFileSync(join(policy, 'scaling_governor'), 'powersave\n');
      writeFileSync(join(policy, 'energy_performance_preference'), 'balance_performance\n');
      writeFileSync(requested, '0\n');
      writeFileSync(observed, '618\n');

      expect(() =>
        execFileSync('bash', [SCRIPT], {
          env: {
            ...process.env,
            PAPERCUSP_CPU_SYSFS_ROOT: root,
            PAPERCUSP_NR_HUGEPAGES_REQUEST_PATH: requested,
            PAPERCUSP_NR_HUGEPAGES_STATUS_PATH: observed,
            PAPERCUSP_NR_HUGEPAGES_TARGET: '18000',
          },
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).toThrow();
      expect(readFileSync(requested, 'utf8').trim()).toBe('18000');
      expect(readFileSync(observed, 'utf8').trim()).toBe('618');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
