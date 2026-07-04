// @vitest-environment node
/**
 * onboard-launcher-flow.integration.test.ts — the scripted concierge → agent
 * handoff, END TO END, with a FAKE agent binary
 * (plan agent-first-onboarding-2026-07-03, P-009 — the CI half; the
 * first-run routing + console-surface half is
 * apps/operator/e2e/onboarding-first-run.spec.ts).
 *
 * What the unit file (onboard-launcher.test.ts) can't prove: that the REAL
 * onboard-launcher.mjs child process drives the whole non-interactive flow —
 * intro banner → install stage (streams the installer SpawnSpec) → re-poll →
 * handoff (fetches the tutor launch-context, then execs `psu` from PATH with
 * the P-005 args). This spawns the real script against a stub operator API
 * (node:http serving the documented endpoint shapes) with PATH pointing at a
 * fake `psu` + a fake installer, so it runs anywhere CI does — no LLM, no
 * Tauri, no real installs, and no prompts (every prompt-bearing stage is
 * bypassed the same way the real flow bypasses it: --framework skips the
 * pick, the stub resolver never returns embeddings, and handoff already has
 * a chosen framework).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.resolve(HERE, '..', 'onboard-launcher.mjs');

/** Mirror of stage-resolver's FRAMEWORK_LABELS (the endpoint echoes them). */
const LABELS = {
  claude: 'Claude Code',
  codex: 'Codex (OpenAI)',
  'omp-meridian': 'oh-my-pi + Meridian',
} as const;

let tmp: string;
let binDir: string;
let fakeInstall: string;

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'onboard-flow-'));
  binDir = path.join(tmp, 'bin');
  mkdirSync(binDir);
  // The FAKE agent binary: stands in for `psu` on PATH, records its argv
  // (one arg per line) and exits 0 — the handoff's success contract.
  const psu = path.join(binDir, 'psu');
  writeFileSync(psu, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$PSU_ARGV_FILE"\nexit 0\n');
  chmodSync(psu, 0o755);
  // The fake installer SpawnSpec target: drops a marker so the test can prove
  // the install stage actually STREAMED a child process, not just printed.
  fakeInstall = path.join(binDir, 'fake-install');
  writeFileSync(fakeInstall, '#!/usr/bin/env bash\necho done > "$INSTALL_MARKER"\nexit 0\n');
  chmodSync(fakeInstall, 0o755);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Stub operator API: JSON per-path handler + a log of every request URL. */
function startFakeOperator(
  handler: (url: URL) => unknown,
): Promise<{ server: Server; port: number; requests: URL[] }> {
  return new Promise((resolve) => {
    const requests: URL[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push(url);
      const body = handler(url);
      if (body === undefined) {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, requests });
    });
  });
}

/** Spawn the REAL launcher as a child process; resolve with exit + output. */
function runLauncher(
  args: string[],
  extraEnv: Record<string, string>,
  timeoutMs = 25_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // The fake `psu` must win PATH resolution.
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      // Dev-box hygiene: these seams must come from THIS test, not the host.
      PAPERCUSP_ONBOARD_HARNESS: undefined,
      PAPERCUSP_ONBOARD_LAUNCH_CONTEXT: undefined,
      PAPERCUSP_OPERATOR_URL: undefined,
      ...extraEnv,
    };
    const child = spawn(process.execPath, [LAUNCHER, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(`onboard-launcher timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`),
      );
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

describe('onboard-launcher scripted flow → handoff (fake agent binary)', () => {
  it(
    'first-run: install stage streams the installer, handoff execs the fake psu with the P-005 argv',
    async () => {
      const argvFile = path.join(tmp, 'psu-argv-first-run.txt');
      const marker = path.join(tmp, 'install-marker.txt');
      const lcPath = path.join(tmp, 'tutor-launch-context.md');
      let statusPolls = 0;
      const { server, port, requests } = await startFakeOperator((url) => {
        if (url.pathname === '/api/desktop/onboarding-status') {
          statusPolls += 1;
          // Poll 1: chosen but not installed → install. Poll 2+: installed +
          // signed in (the fake installer "worked") → handoff.
          return statusPolls === 1
            ? { stage: { stage: 'install', framework: 'claude' }, labels: LABELS }
            : { stage: { stage: 'handoff', framework: 'claude' }, labels: LABELS };
        }
        if (url.pathname === '/api/desktop/setup-pty-commands') {
          return {
            installFramework: {
              claude: { command: fakeInstall, args: [], cwd: tmp, env: { INSTALL_MARKER: marker } },
            },
          };
        }
        if (url.pathname === '/api/desktop/onboarding-launch-context') {
          return { path: lcPath };
        }
        return undefined;
      });
      try {
        const r = await runLauncher(
          ['--framework=claude', `--operator-url=http://127.0.0.1:${port}`],
          { PSU_ARGV_FILE: argvFile },
        );
        expect(r.code).toBe(0);
        // The chat framing reached the terminal in order…
        expect(r.stdout).toContain('Welcome to papercusp'); // verbatim intro banner
        expect(r.stdout).toContain('Installing');
        expect(r.stdout).toContain('handing you to your agent now');
        // …the installer SpawnSpec actually RAN (streamed child, not prose)…
        expect(readFileSync(marker, 'utf8')).toContain('done');
        // …and the FAKE agent binary got exec'd with exactly the P-005 argv,
        // tutor launch-context threaded through the env seam.
        const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
        expect(argv).toEqual([
          '--no-picker',
          '--agent=claude',
          '--no-plan',
          `--launch-context=${lcPath}`,
        ]);
        // The tutor brief was requested for the right agent + mode.
        const lcReq = requests.find((u) => u.pathname === '/api/desktop/onboarding-launch-context');
        expect(lcReq?.searchParams.get('agent')).toBe('claude');
        expect(lcReq?.searchParams.get('mode')).toBe('first-run');
        // Every status poll carried the session's chosen framework (resumable
        // stage resolution is fully server-side).
        const polls = requests.filter((u) => u.pathname === '/api/desktop/onboarding-status');
        expect(polls.length).toBeGreaterThanOrEqual(2);
        for (const u of polls) expect(u.searchParams.get('chosen')).toBe('claude');
      } finally {
        server.close();
      }
    },
    30_000,
  );

  it(
    'already-set-up machine: exits 0 with the re-run hint and never spawns the agent',
    async () => {
      const argvFile = path.join(tmp, 'psu-argv-done.txt');
      const { server, port } = await startFakeOperator((url) => {
        if (url.pathname === '/api/desktop/onboarding-status') {
          return { stage: { stage: 'done' }, labels: LABELS };
        }
        return undefined;
      });
      try {
        const r = await runLauncher([`--operator-url=http://127.0.0.1:${port}`], {
          PSU_ARGV_FILE: argvFile,
        });
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('already set up');
        expect(r.stdout).toContain('papercusp tutorial'); // the re-entry hint
        expect(existsSync(argvFile)).toBe(false); // psu never ran
      } finally {
        server.close();
      }
    },
    30_000,
  );

  it(
    'tutorial re-entry (--tutorial): auto-accepts the detected framework and hands off in tutorial mode',
    async () => {
      const argvFile = path.join(tmp, 'psu-argv-tutorial.txt');
      const lcPath = path.join(tmp, 'tutor-launch-context-tutorial.md');
      const { server, port, requests } = await startFakeOperator((url) => {
        if (url.pathname === '/api/desktop/onboarding-status') {
          // A finished machine in tutorial mode resolves to handoff (P-014),
          // with the detected framework — NO pick, NO confirm.
          return { stage: { stage: 'handoff', framework: 'claude' }, labels: LABELS };
        }
        if (url.pathname === '/api/desktop/onboarding-launch-context') {
          return { path: lcPath };
        }
        return undefined;
      });
      try {
        const r = await runLauncher(['--tutorial', `--operator-url=http://127.0.0.1:${port}`], {
          PSU_ARGV_FILE: argvFile,
        });
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('Re-opening the Papercusp tutorial');
        expect(r.stdout).toContain('the tutorial continues right here');
        const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
        expect(argv).toContain('--agent=claude');
        expect(argv).toContain(`--launch-context=${lcPath}`);
        // The re-entry flag reached the server both places it matters.
        const poll = requests.find((u) => u.pathname === '/api/desktop/onboarding-status');
        expect(poll?.searchParams.get('tutorial')).toBe('1');
        const lcReq = requests.find((u) => u.pathname === '/api/desktop/onboarding-launch-context');
        expect(lcReq?.searchParams.get('mode')).toBe('tutorial');
      } finally {
        server.close();
      }
    },
    30_000,
  );
});
