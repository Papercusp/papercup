// @vitest-environment node
/**
 * tutorial-runner-flow.integration.test.ts — the DETERMINISTIC tutorial, END TO END
 * (deterministic-onboarding-tutorial-2026-07-04 P-007).
 *
 * Proves what the unit file can't: the REAL tutorial-runner.mjs child process fetches
 * the tutorial in one call and drives it DETERMINISTICALLY — printing each section's
 * Brief VERBATIM, advancing on [1], showing Details verbatim on [2], checkpointing
 * progress, narrating the finale, and graduating (finished_at) — with the agent invoked
 * ONLY for a free-form question (a one-shot to a FAKE agent binary). Runs anywhere CI
 * does: a node:http stub operator, no LLM, no Tauri.
 *
 * The tested path is deliberately the `input`-only first-run flow (empty optionalSetup +
 * no prior progress ⇒ no @inquirer select/confirm), so answers drive cleanly over a pipe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, '..', 'tutorial-runner.mjs');

let tmp: string;
let fakeAgent: string;

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'tutorial-flow-'));
  const binDir = path.join(tmp, 'bin');
  mkdirSync(binDir);
  // Fake agent CLI: the runner one-shots it for a question (`<bin> -p <prompt>`); it
  // echoes a marker so the test can prove the agent's answer surfaced in the tutorial.
  fakeAgent = path.join(binDir, 'claude');
  writeFileSync(fakeAgent, '#!/usr/bin/env bash\necho "FAKE_AGENT_ANSWER for a question"\n');
  chmodSync(fakeAgent, 0o755);
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Recorder {
  patches: Array<Record<string, unknown>>;
  scriptRequests: URL[];
}

/** A stub operator serving the tutorial-script + setup-wizard-state contract. */
function startOperator(sections: unknown[]): Promise<{
  server: Server;
  port: number;
  rec: Recorder;
}> {
  return new Promise((resolve) => {
    const rec: Recorder = { patches: [], scriptRequests: [] };
    let wizardState: Record<string, unknown> = {};
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (url.pathname === '/api/desktop/tutorial-script') {
          rec.scriptRequests.push(url);
          res.end(
            JSON.stringify({
              mode: url.searchParams.get('tutorial') === '1' ? 'tutorial' : 'first-run',
              os: 'linux',
              previewEnabled: false,
              sections,
              chapters: [{ number: 1, title: 'Orientation', sectionIds: (sections as any[]).map((s) => s.id) }],
              coreChapters: [1, 2],
              progress: null,
              optionalSetup: [], // empty ⇒ the runner skips Phase A (no confirm prompt)
              guiTabTour: [{ id: 'overview', label: 'Overview', blurb: 'THE_OVERVIEW_BLURB' }],
              agentBinaries: { claude: fakeAgent, codex: null, omp: null, pi: null },
            }),
          );
          return;
        }
        if (url.pathname === '/api/desktop/setup-wizard-state') {
          if (req.method === 'PATCH') {
            const body = raw ? JSON.parse(raw) : {};
            rec.patches.push(body);
            wizardState = { ...wizardState, ...body };
            res.end(JSON.stringify(wizardState));
            return;
          }
          res.end(JSON.stringify(wizardState));
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, rec });
    });
  });
}

/** Spawn the REAL runner, feed `input` over a pipe, resolve with exit + stdout. */
function runRunner(
  args: string[],
  stdin: string,
  timeoutMs = 25_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PAPERCUSP_OPERATOR_URL: undefined },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`runner timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.stdin.write(stdin);
    // Leave stdin open — the child exits on its own after graduation.
  });
}

const TWO_SECTIONS = [
  {
    id: 'ch1-01',
    chapter: 1,
    order: 1,
    title: 'First section',
    brief: 'BRIEF_ONE_VERBATIM.',
    details: 'DETAILS_ONE_VERBATIM.',
    docSlugs: ['a/b'],
  },
  {
    id: 'ch1-02',
    chapter: 1,
    order: 2,
    title: 'Second section',
    brief: 'BRIEF_TWO_VERBATIM.',
    details: 'DETAILS_TWO_VERBATIM.',
    docSlugs: [],
  },
];

describe('deterministic tutorial runner — end to end', () => {
  it(
    'prints each Brief verbatim, checkpoints progress per section, and graduates',
    async () => {
      const { server, port, rec } = await startOperator(TWO_SECTIONS);
      try {
        // [1] then [1] → walk both sections → finale → graduate.
        const r = await runRunner([`--operator-url=http://127.0.0.1:${port}`], '1\n1\n');
        expect(r.code, r.stderr).toBe(0);
        // Content pack delivered VERBATIM (no LLM paraphrase).
        expect(r.stdout).toContain('BRIEF_ONE_VERBATIM.');
        expect(r.stdout).toContain('BRIEF_TWO_VERBATIM.');
        // Finale narrated deterministically.
        expect(r.stdout).toContain('THE_OVERVIEW_BLURB');
        // Progress checkpointed after each section, then graduation stamped finished_at.
        const progressPatches = rec.patches
          .map((p) => (p.tutorial_progress as any)?.last_section_id)
          .filter(Boolean);
        expect(progressPatches).toContain('ch1-01');
        expect(progressPatches).toContain('ch1-02');
        expect(rec.patches.some((p) => typeof p.finished_at === 'string')).toBe(true);
      } finally {
        server.close();
      }
    },
    30_000,
  );

  it(
    '[2] shows Details verbatim; a free-form question one-shots the agent, then [1] continues',
    async () => {
      const { server, port } = await startOperator(TWO_SECTIONS);
      try {
        // section1: [2] details → ask a question → [1] continue → section2: [1] → end.
        const r = await runRunner(
          [`--agent=claude`, `--operator-url=http://127.0.0.1:${port}`],
          '2\nwhat is a harness?\n1\n1\n',
        );
        expect(r.code, r.stderr).toBe(0);
        // [2] rendered the section's Details verbatim.
        expect(r.stdout).toContain('DETAILS_ONE_VERBATIM.');
        // The free-form question was routed to the (fake) agent one-shot and surfaced.
        expect(r.stdout).toContain('FAKE_AGENT_ANSWER');
      } finally {
        server.close();
      }
    },
    30_000,
  );
});
