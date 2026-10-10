// @vitest-environment node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureCpuProfile, readInspectorProcessIdentity } from '../../../scripts/cpu-sample.mjs';

async function withTarget(run: (target: { pid: number; port: number; out: string }) => Promise<void>) {
  const out = mkdtempSync(join(tmpdir(), 'cpu-sample-test-'));
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--cpu-prof',
    '--cpu-prof-dir=' + out, '--cpu-prof-name=killed.cpuprofile', '-e',
    'function profiledWork(){const until=Date.now()+10;while(Date.now()<until)Math.sqrt(Math.random());}setInterval(profiledWork,15);console.log("CPU_SAMPLE_TARGET_READY");',
    'cpu-sample-target', '--probe-target'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('inspector did not open')), 5000);
      let inspectorPort: number | undefined;
      let ready = false;
      const settle = () => { if (inspectorPort && ready) { clearTimeout(timer); resolve(inspectorPort); } };
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stderr!.on('data', chunk => {
        const match = String(chunk).match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (match) { inspectorPort = Number(match[1]); settle(); }
      });
      child.stdout!.on('data', chunk => {
        if (String(chunk).includes('CPU_SAMPLE_TARGET_READY')) { ready = true; settle(); }
      });
    });
    await run({ pid: child.pid!, port, out });
    child.kill('SIGTERM');
    expect((await exit)[1]).toBe('SIGTERM');
    // The explicit inspector stop preserves data that exit-only --cpu-prof loses.
    expect(existsSync(join(out, 'killed.cpuprofile'))).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exit;
    rmSync(out, { recursive: true, force: true });
  }
}

it('collects a real startup profile before SIGTERM without changing the child exit', async () => {
  await withTarget(async ({ pid, port }) => {
    const result = await captureCpuProfile({ pid, startPort: port, attachExisting: true,
      expectedEntry: 'cpu-sample-target', expectedArg: '--probe-target', durationMs: 250, deadlineMs: 7000 });
    expect(result.target.pid).toBe(pid);
    expect(result.profile.samples.length).toBeGreaterThan(0);
    // V8 may inline the callback into its timer caller (especially with a second
    // --cpu-prof session). Verify sampled work and a real interval, not its name.
    const samples = new Set(result.profile.samples);
    expect(result.profile.endTime).toBeGreaterThan(result.profile.startTime);
    expect(result.profile.nodes.some((node: { id: number; callFrame: { functionName: string } }) =>
      samples.has(node.id) && !['(root)', '(idle)', '(program)', '(garbage collector)']
        .includes(node.callFrame.functionName))).toBe(true);
  });
}, 15000);

it.each([
  { expectedEntry: 'different-entry', expectedArg: '--probe-target' },
  { expectedEntry: 'cpu-sample-target', expectedArg: '--different-argument' },
])('refuses an inspector whose entry or required argument differs: %j', async mismatch => {
  await withTarget(async ({ pid, port }) => {
    await expect(captureCpuProfile({ pid, startPort: port, attachExisting: true,
      ...mismatch, durationMs: 250, deadlineMs: 7000 })).rejects.toThrow('identity mismatch');
  });
}, 15000);

it('requires an exact entry when the pid is unknown', async () => {
  await expect(captureCpuProfile({ pid: 0, attachExisting: true, startPort: 9229,
    durationMs: 250 })).rejects.toThrow('exact expected entry');
});

async function withBusyTarget(run: (target: { pid: number; port: number; entry: string }) => Promise<void>) {
  const out = mkdtempSync(join(tmpdir(), 'cpu-sample-busy-'));
  const entry = join(out, 'startup.mjs');
  writeFileSync(entry, 'console.log("CPU_SAMPLE_BUSY_READY");function busyStartup(){while(true)Math.sqrt(Math.random());}busyStartup();');
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', entry, '--probe-target'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('busy inspector did not open')), 5000);
      let inspectorPort: number | undefined;
      let ready = false;
      const settle = () => { if (inspectorPort && ready) { clearTimeout(timer); resolve(inspectorPort); } };
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stderr!.on('data', chunk => {
        const match = String(chunk).match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (match) { inspectorPort = Number(match[1]); settle(); }
      });
      child.stdout!.on('data', chunk => {
        if (String(chunk).includes('CPU_SAMPLE_BUSY_READY')) { ready = true; settle(); }
      });
    });
    await run({ pid: child.pid!, port, entry });
  } finally {
    child.kill('SIGTERM');
    await exit;
    rmSync(out, { recursive: true, force: true });
  }
}

it.skipIf(process.platform !== 'linux')('profiles a synchronously busy target with kernel identity before SIGTERM', async () => {
  await withBusyTarget(async ({ pid, port, entry }) => {
    const result = await captureCpuProfile({ pid: 0, startPort: port, attachExisting: true, procIdentity: true,
      expectedEntry: entry, expectedArg: '--probe-target', durationMs: 250, deadlineMs: 7000 });
    expect(result.target).toMatchObject({ pid, entry, identity: 'proc' });
    const samples = new Set(result.profile.samples);
    expect(result.profile.nodes.some((node: { id: number; callFrame: { functionName: string } }) =>
      samples.has(node.id) && node.callFrame.functionName === 'busyStartup')).toBe(true);
  });
}, 15000);

it.skipIf(process.platform !== 'linux')('refuses a matching entry whose PID does not own the inspector socket', async () => {
  await withBusyTarget(({ port, entry }) => {
    expect(() => readInspectorProcessIdentity({ pid: process.pid, port, expectedEntry: entry,
      expectedArg: '--probe-target' })).toThrow('identity mismatch');
    expect(() => readInspectorProcessIdentity({ pid: 0, port, expectedEntry: entry,
      expectedArg: '--wrong-argument' })).toThrow('identity mismatch');
    return Promise.resolve();
  });
}, 15000);
