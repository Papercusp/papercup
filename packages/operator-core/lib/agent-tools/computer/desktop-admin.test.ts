/**
 * desktop-admin.test.ts — the explicit per-hive desktop lease tools
 * (computer:provision_desktop / release_desktop / list_desktops, Gap A). Driven through
 * the injectable provisioner seam so no real Xvfb is spawned; asserts the handler output
 * shape + the lease-Map side effects.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  __setProvisionerForTests,
  __resetProvisioner,
  releaseAllHiveDesktops,
  leasedHiveDesktops,
} from './desktop-lease';
import type { ProvisionOptions, SandboxDesktop } from './desktop-provisioner';
import provisionTool from './provision-desktop';
import releaseTool from './release-desktop';
import listTool from './list-desktops';

type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> => JSON.parse(r.content[0].text);
const CTX = {} as never;

const provision = provisionTool as unknown as Tool;
const release = releaseTool as unknown as Tool;
const list = listTool as unknown as Tool;

/** A fake provisioner that records the opts it was handed and hands back a fake desktop. */
function fakeProvisioner() {
  const seen: ProvisionOptions[] = [];
  let n = 200;
  __setProvisionerForTests(async (opts) => {
    seen.push(opts ?? {});
    const display = `:${n++}`;
    const d: SandboxDesktop = {
      display,
      number: Number(display.slice(1)),
      width: opts?.width ?? 1024,
      height: opts?.height ?? 768,
      release: async () => {},
    };
    return d;
  });
  return seen;
}

describe('computer desktop-lease admin tools', () => {
  afterEach(async () => {
    await releaseAllHiveDesktops();
    __resetProvisioner();
  });

  it('provision_desktop stands up a sandbox display for a hive and forwards apps/geometry', async () => {
    const seen = fakeProvisioner();
    const r = parse(await provision.handler({ pot: 'demo', apps: [['firefox']], width: 800, height: 600 }, CTX));
    expect(r.ok).toBe(true);
    expect(r.pot).toBe('demo');
    expect(typeof r.display).toBe('string');
    expect((r.display as string).startsWith(':')).toBe(true);
    expect(r.display).not.toBe(':0'); // never the host
    expect(r.reused).toBe(false);
    expect(r.width).toBe(800);
    expect(seen[0]).toMatchObject({ apps: [['firefox']], width: 800, height: 600 }); // forwarded to the provisioner
    expect(leasedHiveDesktops()).toContain('demo');
  });

  it('provision_desktop is idempotent — a second call reuses the lease (reused:true), no relaunch', async () => {
    const seen = fakeProvisioner();
    const first = parse(await provision.handler({ pot: 'demo' }, CTX));
    const second = parse(await provision.handler({ pot: 'demo', apps: [['xterm']] }, CTX));
    expect(second.reused).toBe(true);
    expect(second.display).toBe(first.display); // same desktop
    expect(seen).toHaveLength(1); // provisioner called ONCE — apps on the 2nd call are not relaunched
  });

  it('list_desktops reports every leased hive with its display/geometry', async () => {
    fakeProvisioner();
    await provision.handler({ pot: 'alpha' }, CTX);
    await provision.handler({ pot: 'beta', width: 1280, height: 720 }, CTX);
    const r = parse(await list.handler({}, CTX));
    expect(r.count).toBe(2);
    const rows = r.desktops as Array<{ pot: string; display: string; width: number }>;
    expect(rows.map((d) => d.pot).sort()).toEqual(['alpha', 'beta']);
    expect(rows.find((d) => d.pot === 'beta')?.width).toBe(1280);
  });

  it('release_desktop tears down the lease (released:true), then is a no-op (released:false)', async () => {
    fakeProvisioner();
    await provision.handler({ pot: 'demo' }, CTX);
    const r1 = parse(await release.handler({ pot: 'demo' }, CTX));
    expect(r1.released).toBe(true);
    expect(leasedHiveDesktops()).not.toContain('demo');
    const r2 = parse(await release.handler({ pot: 'demo' }, CTX));
    expect(r2.released).toBe(false); // idempotent no-op
  });
});
