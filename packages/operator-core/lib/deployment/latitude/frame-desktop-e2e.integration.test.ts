/**
 * LIVE frame-desktop E2E (`hive-frame-desktops-live-view-2026-06-06`
 * P-004 + P-011) — extends the cloud-deployment live E2E (P-013 conventions).
 *
 * SKIPPED unless the owner creds + frame SSH identity are present — it
 * provisions a REAL Latitude VM and costs money. Required env:
 *   LATITUDE_API_KEY, LATITUDE_E2E_PROJECT,
 *   LATITUDE_SSH_KEY_ID            # the ssh key id injected at provision
 *   LATITUDE_SSH_IDENTITY_FILE     # the matching private key path
 *
 * One VM verifies the whole plan live:
 *   P-004 — bootstrap with desktop:{displays:2} → Xvfb :99/:100 + openbox up;
 *           GUI clients started on :99; the capture loop ships a REAL JPEG
 *           which we pull over SSH via the production FRAME_PULL_SCRIPT;
 *           the idle display (:100) publishes NO stale frame.
 *   P-011 — a real noVNC-equivalent RFB session through the production stack
 *           (ticketed loopback WS → ssh `x11vnc -inetd` → Xvfb): watch mode
 *           handshakes read-only and its input is IGNORED; takeover mode
 *           DRIVES the pointer (verified via xdotool on the frame); audit
 *           events fire for request/start/end.
 *
 * ALWAYS destroys the VM in finally — a failed run never leaks billing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { once } from 'node:events';
import type { DeploymentConfig, DeploymentContext, Frame } from '@papercusp/deployment-driver';
import { LatitudeDriver } from './latitude-driver';
import { buildFrameBootstrap } from '../frame-bootstrap';
import { createSshRemoteExec, type RemoteExec } from '../remote-exec';
import { sshTargetForFrame, waitForSsh } from '../frame-installer';
import { FRAME_PULL_SCRIPT, parseFramePull } from '../frame-view';
import {
  createVncSession,
  startFrameVncWs,
  VNC_WS_PATH,
  _setFrameVncDepsForTests,
  _resetFrameVncForTests,
} from '../frame-vnc';

const haveAll =
  !!process.env.LATITUDE_API_KEY &&
  !!process.env.LATITUDE_E2E_PROJECT &&
  !!process.env.LATITUDE_SSH_KEY_ID &&
  !!process.env.LATITUDE_SSH_IDENTITY_FILE;

const FORTY_MIN = 40 * 60_000;

const ctx: DeploymentContext = {
  harnessSlug: 'desktop-e2e',
  workspaceId: 'e2e',
  log: (lvl, msg) => console.log(`[desktop-e2e ${lvl}] ${msg}`),
};

const liveConfig = (): DeploymentConfig => ({
  target: 'latitude',
  kind: 'vm',
  size: process.env.LATITUDE_E2E_VM_PLAN ?? 'vm.small',
  desktop: { displays: 2 },
  provider: {
    project: process.env.LATITUDE_E2E_PROJECT,
    sshKeys: [process.env.LATITUDE_SSH_KEY_ID],
    sshIdentityFile: process.env.LATITUDE_SSH_IDENTITY_FILE,
  },
});

/** Minimal RFB 3.8 client over the bridge WS — enough to prove the live path. */
class RfbWsClient {
  private buf = Buffer.alloc(0);
  private waiters: Array<{ n: number; resolve: (b: Buffer) => void }> = [];
  private closed = false;
  constructor(private ws: import('ws').WebSocket) {
    ws.on('message', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
    ws.on('close', () => {
      this.closed = true;
      this.drain();
    });
  }
  private drain() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (this.buf.length >= w.n) {
        const out = this.buf.subarray(0, w.n);
        this.buf = this.buf.subarray(w.n);
        this.waiters.shift();
        w.resolve(Buffer.from(out));
      } else if (this.closed) {
        this.waiters.shift();
        w.resolve(Buffer.alloc(0));
      } else {
        break;
      }
    }
  }
  read(n: number): Promise<Buffer> {
    return new Promise((resolve) => {
      this.waiters.push({ n, resolve });
      this.drain();
    });
  }
  send(b: Buffer): void {
    this.ws.send(b);
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* gone */
    }
  }
}

/** RFB 3.8 handshake (security None) → { width, height }. */
async function rfbHandshake(c: RfbWsClient): Promise<{ width: number; height: number }> {
  const version = await c.read(12);
  expect(version.toString('latin1')).toMatch(/^RFB 003\.\d{3}\n$/);
  c.send(Buffer.from('RFB 003.008\n', 'latin1'));
  const nTypes = (await c.read(1))[0];
  expect(nTypes).toBeGreaterThan(0);
  const types = await c.read(nTypes);
  expect([...types]).toContain(1); // security None — auth is the ticketed tunnel
  c.send(Buffer.from([1]));
  const result = (await c.read(4)).readUInt32BE(0);
  expect(result).toBe(0); // SecurityResult OK
  c.send(Buffer.from([1])); // ClientInit: shared
  const serverInit = await c.read(24);
  const width = serverInit.readUInt16BE(0);
  const height = serverInit.readUInt16BE(2);
  const nameLen = serverInit.readUInt32BE(20);
  await c.read(nameLen);
  return { width, height };
}

function pointerEvent(x: number, y: number, buttons = 0): Buffer {
  const b = Buffer.alloc(6);
  b.writeUInt8(5, 0);
  b.writeUInt8(buttons, 1);
  b.writeUInt16BE(x, 2);
  b.writeUInt16BE(y, 4);
  return b;
}

afterEach(() => _resetFrameVncForTests());

describe.skipIf(!haveAll)(
  'frame desktop + live view E2E (needs LATITUDE_* creds + ssh identity)',
  () => {
    it(
      'desktop:true frame: Xvfb up, capture pulled over SSH, VNC watch read-only + takeover drives (then DESTROY)',
      async () => {
        const config = liveConfig();
        let frame: Frame | undefined;
        try {
          // ── provision + desktop bootstrap (runtime skipped — not under test) ──
          frame = await LatitudeDriver.provision(config, ctx);
          expect(frame.host).toBeTruthy();
          console.log(`[desktop-e2e] provisioned ${frame.id} @ ${frame.host}`);
          const exec: RemoteExec = createSshRemoteExec(sshTargetForFrame(frame, config));
          await waitForSsh(exec, (m) => console.log(`[desktop-e2e] ${m}`), { attempts: 60, delayMs: 5_000 });

          const { script, steps } = buildFrameBootstrap({
            harnessSlug: 'desktop-e2e',
            desktop: config.desktop,
            embeddedPg: false,
            orchestratorOnFrame: false,
            runtimeSetup: ['true # runtime delivery skipped — desktop capability E2E'],
          });
          expect(steps).toContain('desktop');
          console.log('[desktop-e2e] bootstrapping (desktop section live)…');
          await exec.runScript(script);

          // ── P-004: displays up; GUI clients on :99; capture ships a real JPEG ──
          const ps = await exec.runScript(
            'pgrep -ac Xvfb; pgrep -ac openbox; pgrep -afc papercusp-desktop-capture || true',
          );
          const [xvfb, openbox] = ps.stdout.trim().split('\n').map((s) => Number(s.trim()));
          expect(xvfb).toBe(2);
          expect(openbox).toBe(2);

          // A real GUI on :99 (xterm + xeyes; browser-equivalent X clients —
          // chromium on Ubuntu is snap-only and flaky as root, so the GUI
          // clients prove the display; the capture proves the pixels). A fresh
          // VM's cloud-init can hold the dpkg lock — wait for it, fail LOUD.
          const gui = await exec.runScript(
            [
              'set -e',
              'export DEBIAN_FRONTEND=noninteractive',
              'apt-get -o DPkg::Lock::Timeout=180 install -y --no-install-recommends xterm x11-apps',
              'command -v xterm >/dev/null || { echo "XTERM-MISSING" >&2; exit 9; }',
              `nohup bash -c 'DISPLAY=:99 xterm -geometry 120x30 -e "bash -c \\"while true; do date; sleep 1; done\\"" ' >/dev/null 2>&1 &`,
              `nohup bash -c 'DISPLAY=:99 xeyes' >/dev/null 2>&1 &`,
              // wait until the clients actually registered on the display
              'for i in $(seq 1 15); do',
              `  n=$(DISPLAY=:99 xlsclients 2>/dev/null | grep -civ openbox || true)`,
              '  [ "$n" -gt 0 ] && break || sleep 1',
              'done',
              'echo "CLIENTS:"; DISPLAY=:99 xlsclients',
            ].join('\n'),
          );
          console.log(`[desktop-e2e] GUI clients on :99 →\n${gui.stdout.slice(-400)}`);
          expect(gui.stdout).toMatch(/CLIENTS:[\s\S]*(xterm|xeyes)/);

          // capture interval is 5s — wait two ticks then pull via the REAL script
          await new Promise((r) => setTimeout(r, 12_000));
          const pull = await exec.runScript(FRAME_PULL_SCRIPT);
          const parsed = parseFramePull(pull.stdout);
          if (parsed.thumbs.length === 0) {
            // surface the frame-side state before the assertion kills the run
            const diag = await exec.runScript(
              'ls -la /run/papercusp/desktop 2>&1; echo ---; tail -20 /var/log/papercusp-desktop/capture.log 2>&1; echo ---; pgrep -afc papercusp-desktop-capture || true',
            );
            console.log(`[desktop-e2e] DIAG (no thumbs):\n${diag.stdout.slice(-1200)}`);
          }
          expect(parsed.noCaptureDir).toBe(false);
          const displays = parsed.thumbs.map((t) => t.display);
          expect(displays).toContain(99); // active display captured
          expect(displays).not.toContain(100); // idle display paused (P-005 rule)
          const jpeg = Buffer.from(parsed.thumbs.find((t) => t.display === 99)!.jpegBase64, 'base64');
          expect(jpeg[0]).toBe(0xff); // JPEG SOI
          expect(jpeg[1]).toBe(0xd8);
          expect(jpeg.length).toBeGreaterThan(2_000); // real pixels, not a stub
          console.log(`[desktop-e2e] P-004 OK — live thumbnail ${jpeg.length} bytes from :99`);

          // ── P-011: VNC watch (read-only) + takeover (drives) through the
          //    production ticketed WS bridge → ssh x11vnc -inetd ────────────
          const audits: Array<{ action: string }> = [];
          _setFrameVncDepsForTests({
            loadFrame: async () => ({ frame: frame!, config }),
            audit: (ev) => audits.push({ action: ev.action }),
          });
          const port = await startFrameVncWs();
          expect(port).toBeTruthy();
          const { WebSocket } = await import('ws');

          const session = async (mode: 'watch' | 'takeover') => {
            const t = await createVncSession({
              slug: 'desktop-e2e',
              workspaceId: 'e2e',
              display: 99,
              mode,
              actor: 'user:e2e',
            });
            const ws = new WebSocket(`ws://127.0.0.1:${port}${VNC_WS_PATH}?ticket=${t.ticket}`);
            await once(ws, 'open');
            return new RfbWsClient(ws as never);
          };

          // watch: handshake proves the full path; its input must be DROPPED
          const watch = await session('watch');
          const geo = await rfbHandshake(watch);
          expect(geo).toEqual({ width: 1920, height: 1080 });
          console.log(`[desktop-e2e] watch session live (${geo.width}x${geo.height}, read-only)`);
          watch.send(pointerEvent(50, 50));
          await new Promise((r) => setTimeout(r, 1_500));
          const lockedLoc = (await exec.runScript('DISPLAY=:99 xdotool getmouselocation')).stdout;
          expect(lockedLoc).not.toMatch(/x:50 y:50 /); // -viewonly dropped it
          watch.close();

          // takeover: the SAME event must MOVE the pointer (the input path)
          const drive = await session('takeover');
          await rfbHandshake(drive);
          drive.send(pointerEvent(500, 400));
          await new Promise((r) => setTimeout(r, 1_500));
          const drivenLoc = (await exec.runScript('DISPLAY=:99 xdotool getmouselocation')).stdout;
          expect(drivenLoc).toMatch(/x:500 y:400 /);
          console.log('[desktop-e2e] P-011 OK — takeover drove the pointer to 500,400; watch input was ignored');
          drive.close();
          await new Promise((r) => setTimeout(r, 1_000));

          // D-002/P-010: the lifecycle was audited
          const actions = audits.map((a) => a.action);
          expect(actions).toContain('frame-vnc.watch-requested');
          expect(actions).toContain('frame-vnc.watch-started');
          expect(actions).toContain('frame-vnc.takeover-requested');
          expect(actions).toContain('frame-vnc.takeover-started');
          expect(actions.filter((a) => a === 'frame-vnc.ended').length).toBeGreaterThanOrEqual(2);
        } finally {
          if (frame) {
            await LatitudeDriver.teardown(frame, config, ctx);
            console.log(`[desktop-e2e] destroyed ${frame.id} (billing ended)`);
          }
        }
      },
      FORTY_MIN,
    );
  },
);
