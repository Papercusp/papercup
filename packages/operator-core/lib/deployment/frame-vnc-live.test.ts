/**
 * LIVE proof that the local VNC bridge actually speaks RFB (P-004).
 *
 * The unit tests around `frame-vnc.ts` drive a fake spawn and a fake WS, so they
 * prove the plumbing and the admission gate but say NOTHING about whether the
 * command we build works. This file answers that one question against a real
 * Xvfb: start a display, run the exact script `localVncCommand` produces, and
 * require the RFB protocol greeting back.
 *
 * OPT-IN, like desktop-gl-live: it needs Xvfb + x11vnc + socat on the host, so
 * running it by default would red the suite on any machine without them. Run it
 * with:
 *
 *   PAPERCUSP_FRAME_VNC_LIVE=1 npx vitest run lib/deployment/frame-vnc-live.test.ts
 *
 * Verified 2026-08-23 on the dev box: greeting `RFB 003.008`, and every x11vnc
 * listener bound to 127.0.0.1 / ::1 — never 0.0.0.0.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { localVncCommand } from './frame-vnc';

const LIVE = process.env.PAPERCUSP_FRAME_VNC_LIVE === '1';
// A display number unlikely to collide with a peer agent's lease on this box.
const DISPLAY = Number(process.env.PAPERCUSP_FRAME_VNC_LIVE_DISPLAY ?? 121);

let xvfb: ChildProcess | undefined;

function haveBinary(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('bash', ['-c', `command -v ${name} >/dev/null 2>&1`]);
    p.on('close', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

/**
 * Run the bridge command and return whatever it writes first. stdin is held OPEN
 * deliberately: socat bridges STDIO, so closing stdin makes it exit on EOF
 * BEFORE the server greeting arrives — which looks exactly like "the bridge
 * produced nothing" and is the first way this test was written wrong.
 */
function readGreeting(display: number, mode: 'watch' | 'takeover', ms = 15_000): Promise<string> {
  const { cmd, args } = localVncCommand(display, mode);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const done = (fn: () => void) => {
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`no greeting in ${ms}ms; stderr=${err.slice(0, 300)}`))),
      ms,
    );
    child.stdout.on('data', (b: Buffer) => {
      out += String(b);
      if (out.length >= 12) done(() => resolve(out));
    });
    child.stderr.on('data', (b: Buffer) => {
      err += String(b);
    });
    child.on('error', (e) => done(() => reject(e)));
    child.on('close', () =>
      done(() => (out ? resolve(out) : reject(new Error(`exited with no output; stderr=${err.slice(0, 300)}`)))),
    );
  });
}

beforeAll(async () => {
  if (!LIVE) return;
  xvfb = spawn('Xvfb', [`:${DISPLAY}`, '-screen', '0', '1024x768x24'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2_000));
}, 30_000);

afterAll(() => {
  try {
    xvfb?.kill('SIGTERM');
  } catch {
    /* gone */
  }
});

describe.skipIf(!LIVE)('local VNC bridge, live against a real Xvfb (P-004)', () => {
  it('speaks the RFB protocol greeting — the command we build actually works', async () => {
    const greeting = await readGreeting(DISPLAY, 'watch');
    // "RFB 003.008\n" is the protocol handshake. Anything else means the bridge
    // produced bytes that are not VNC, which noVNC would fail on opaquely.
    expect(greeting).toMatch(/^RFB \d{3}\.\d{3}/);
  }, 40_000);

  it('takeover mode also connects (the -viewonly flag is not load-bearing for setup)', async () => {
    const greeting = await readGreeting(DISPLAY, 'takeover');
    expect(greeting).toMatch(/^RFB \d{3}\.\d{3}/);
  }, 40_000);

  it('CONTROL: a display with no X server fails instead of hanging or half-succeeding', async () => {
    // Without this, a greeting from a stale x11vnc on another display would look
    // like success. 91 is chosen to be absent, and the failure must be prompt.
    await expect(readGreeting(91, 'watch', 12_000)).rejects.toThrow();
  }, 30_000);

  it('reports a MISSING binary as missing, not as a phantom port problem', async () => {
    // Regression control for a genuinely misleading diagnostic: before the
    // preflight, an absent x11vnc reported `x11vnc-no-port`, which reads as
    // "x11vnc ran and gave no port" and sends the reader after a display bug.
    if (await haveBinary('x11vnc')) {
      // Simulate absence with an empty PATH — invoking bash by ABSOLUTE path,
      // because a bare 'bash' is itself unresolvable once PATH is gone (which is
      // how this test first failed, with a spawn ENOENT that had nothing to do
      // with the behaviour under test).
      const { args } = localVncCommand(DISPLAY, 'watch');
      const out = await new Promise<string>((resolve) => {
        const p = spawn('/bin/bash', ['-c', args[1]], { env: { ...process.env, PATH: '/nonexistent' } });
        let err = '';
        p.stderr.on('data', (b: Buffer) => (err += String(b)));
        p.on('close', () => resolve(err));
      });
      expect(out).toContain('x11vnc-not-installed');
      expect(out).not.toContain('x11vnc-no-port');
    }
  }, 30_000);
});
