import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import type { IpcStatus } from '@papercusp/operator-core/lib/tauri-bindings';

const pid = process.env.VERIFY_TAURI_PID;
const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN;
const run = promisify(execFile);

// Run only in the verifier-owned native process. No browser imitation or
// intercepted requests: the actual desktop bootstrap installs the transport.
it.skipIf(!pid || !tool)('opens the portal shell with desktop environments and routes its API through Rust IPC', async () => {
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.PAPERCUSP_DESKTOP_INTERFACE).toBe('portal-candidate');
  const evaluate = async (expression: string) => {
    const { stdout } = await run(tool!, ['eval', '--pid', pid!, expression, '--json'], { timeout: 15_000 });
    const response = JSON.parse(stdout);
    expect(Object.hasOwn(response, 'result')).toBe(true);
    return response.result;
  };
  await expect.poll(() => evaluate(`Boolean(
    document.querySelector('meta[name="papercusp-desktop-interface"]')?.content === 'portal-candidate'
    && document.querySelector('[aria-label="Papercusp Portal"]')
    && document.querySelector('[aria-label="Apps"]')
    && document.querySelector('[aria-label="Environment switcher"]')
    && window.__TAURI_INTERNALS__?.invoke
  )`), { timeout: 60_000 }).toBe(true);
  const envs = await evaluate('window.__TAURI_INTERNALS__.invoke("list_envs")');
  expect(envs.map((env: { id: string }) => env.id)).toEqual(expect.arrayContaining(['local', 'dev', 'prod', 'staging']));
  const before: IpcStatus = await evaluate('window.__TAURI_INTERNALS__.invoke("endpoint_ipc_status")');
  await evaluate(`(() => {
    window.__desktopPortalProbe = null;
    Promise.all(['/api/apps', '/api/preferences'].map(path => fetch(path).then(async response => ({
      status: response.status, body: await response.json()
    })))).then(result => { window.__desktopPortalProbe = { result }; },
      error => { window.__desktopPortalProbe = { error: String(error) }; });
    return true;
  })()`);
  await expect.poll(() => evaluate('window.__desktopPortalProbe !== null'), { timeout: 60_000 }).toBe(true);
  const probe = await evaluate('window.__desktopPortalProbe');
  expect(probe.error).toBeUndefined();
  expect(probe.result.map((response: { status: number }) => response.status)).toEqual([200, 200]);
  expect(probe.result[0].body.apps.some((app: { slug: string }) => app.slug === 'home')).toBe(true);
  expect(probe.result[1].body.preferences.theme).toBe('dark');
  const after: IpcStatus = await evaluate('window.__TAURI_INTERNALS__.invoke("endpoint_ipc_status")');
  expect(after.client).toBe('connected');
  expect(after.ownerIsContentOrigin).toBe(true);
  expect(after.invokes).toBeGreaterThan(before.invokes);
}, 150_000);
