/**
 * bash-desktop-env.test.ts — computer-tool-plan Gap C: capability:bash binds DISPLAY to
 * the calling hive's leased sandbox desktop, so a bee can LAUNCH GUI apps (`firefox &`)
 * on the desktop it then drives via capability:computer. Resolution is per-caller from
 * ctx.harnessSlug (the handler runs in the operator process, not the bee). Runs the real
 * shell (no mocks) through the injectable provisioner seam (no live Xvfb).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import bashTool from './bash';
import { __resetBashJobs } from './bash-jobs';
import {
  ensureHiveDesktop,
  releaseAllHiveDesktops,
  __setProvisionerForTests,
  __resetProvisioner,
} from '../computer/desktop-lease';

type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };
const bash = bashTool as unknown as Tool;
const STATE = mkdtempSync(join(tmpdir(), 'cap-bash-disp-'));

let savedDisplay: string | undefined;

function makeCtx(harnessSlug?: string) {
  return {
    projectDir: STATE,
    stateDir: STATE,
    harnessSlug,
    signal: new AbortController().signal,
    emit: () => {},
    role: 'bee',
  } as never;
}

function fakeLease(display: string) {
  __setProvisionerForTests(async () => ({
    display,
    number: Number(display.slice(1)),
    width: 1024,
    height: 768,
    release: async () => {},
  }));
}

describe('capability:bash — DISPLAY from the hive desktop lease (Gap C)', () => {
  beforeEach(() => {
    savedDisplay = process.env.DISPLAY;
    process.env.DISPLAY = ':5'; // a sentinel inherited value, to prove override vs passthrough
  });
  afterEach(async () => {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
    await releaseAllHiveDesktops();
    __resetProvisioner();
    __resetBashJobs();
  });

  it('binds DISPLAY to the caller hive lease (overriding the inherited value)', async () => {
    fakeLease(':222');
    await ensureHiveDesktop('demo-hive');
    const r = await bash.handler({ command: 'echo "D=[$DISPLAY]"' }, makeCtx('demo-hive'));
    expect(r.content[0].text).toContain('D=[:222]'); // the leased sandbox display, not :5
  });

  it('does NOT inject a display when the caller hive has no desktop (passes inherited env through)', async () => {
    const r = await bash.handler({ command: 'echo "D=[$DISPLAY]"' }, makeCtx('no-desktop-hive'));
    expect(r.content[0].text).toContain('D=[:5]'); // inherited sentinel — the tool added nothing
  });

  it('does NOT inject a display when there is no harnessSlug on the ctx', async () => {
    fakeLease(':223');
    await ensureHiveDesktop('some-hive'); // a lease exists, but this caller is not in that hive
    const r = await bash.handler({ command: 'echo "D=[$DISPLAY]"' }, makeCtx(undefined));
    expect(r.content[0].text).toContain('D=[:5]'); // no ctx.harnessSlug → no lease lookup
  });
});
