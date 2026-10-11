import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, 'docker-bench.sh');

// The MAIN daemon's well-known state. The bench daemon must share none of it (P-007, D-013 item 1).
const MAIN = {
  dataRoot: '/var/lib/docker',
  socket: '/var/run/docker.sock',
  runSocket: '/run/docker.sock',
  execRoot: '/var/run/docker',
  containerdNamespace: 'moby',
  bridge: 'docker0',
};

const dirs: string[] = [];
function render(env: Record<string, string> = {}) {
  const out = mkdtempSync(join(tmpdir(), 'docker-bench-render-'));
  dirs.push(out);
  execFileSync('bash', [SCRIPT, 'render', out], { env: { PATH: process.env.PATH ?? '', ...env } });
  return {
    daemon: JSON.parse(readFileSync(join(out, 'daemon.json'), 'utf8')) as Record<string, unknown>,
    unit: readFileSync(join(out, 'docker-bench.service'), 'utf8'),
    net: readFileSync(join(out, 'docker-bench-net'), 'utf8'),
    netPath: join(out, 'docker-bench-net'),
  };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('docker-bench daemon config', () => {
  it('keeps every piece of daemon state off the main daemon', () => {
    const { daemon } = render();
    expect(daemon['data-root']).toBe('/mnt/bench/docker');
    expect(daemon['data-root']).not.toBe(MAIN.dataRoot);
    expect(daemon['hosts']).toEqual(['unix:///run/docker-bench.sock']);
    expect(daemon['hosts']).not.toContain(`unix://${MAIN.socket}`);
    expect(daemon['hosts']).not.toContain(`unix://${MAIN.runSocket}`);
    expect(daemon['exec-root']).toBe('/run/docker-bench');
    expect(daemon['exec-root']).not.toBe(MAIN.execRoot);
    expect(daemon['pidfile']).toBe('/run/docker-bench.pid');
    expect(daemon['containerd-namespace']).toBe('bench');
    expect(daemon['containerd-namespace']).not.toBe(MAIN.containerdNamespace);
    expect(daemon['containerd-plugins-namespace']).toBe('bench-plugins');
    expect(daemon['bridge']).toBe('docker-bench0');
    expect(daemon['bridge']).not.toBe(MAIN.bridge);
  });

  it('stores image layers in the data-root, not in the shared containerd snapshotter', () => {
    const { daemon } = render();
    // With the containerd image store, layers would land in /var/lib/containerd on the root disk.
    expect(daemon['storage-driver']).toBe('overlay2');
    expect(daemon['features']).toEqual({ 'containerd-snapshotter': false });
  });

  it('never manages the fleet-shared iptables chains', () => {
    const { daemon } = render();
    expect(daemon['iptables']).toBe(false);
    expect(daemon['ip6tables']).toBe(false);
    expect(daemon['ip-masq']).toBe(false);
    expect(daemon['default-address-pools']).toEqual([{ base: '10.232.0.0/16', size: 24 }]);
  });

  it('orders the unit after the bench mount and starts dockerd from the rendered config', () => {
    const { unit } = render();
    expect(unit).toContain('RequiresMountsFor=/mnt/bench');
    expect(unit).toContain('ExecStart=/usr/bin/dockerd --config-file /etc/docker-bench/daemon.json');
    expect(unit).toContain('ExecStartPre=/usr/local/sbin/docker-bench-net up');
    expect(unit).toContain('ExecStopPost=/usr/local/sbin/docker-bench-net down');
  });

  it('derives the MASQUERADE source subnet from the bridge CIDR', () => {
    expect(render().net).toContain('SUBNET=10.231.0.0/24');
    expect(render({ BENCH_BRIDGE_CIDR: '10.240.5.9/20' }).net).toContain('SUBNET=10.240.0.0/20');
  });

  it('renders a syntactically valid net helper', () => {
    const { netPath } = render();
    expect(() => execFileSync('bash', ['-n', netPath])).not.toThrow();
  });

  it('follows a relocated bench mount', () => {
    const { daemon, unit } = render({ BENCH_MOUNT: '/srv/bench2' });
    expect(daemon['data-root']).toBe('/srv/bench2/docker');
    expect(unit).toContain('RequiresMountsFor=/srv/bench2');
  });
});
