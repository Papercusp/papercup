/**
 * pretooluse-schedule-wakeup-provenance.mjs — turn-provenance ENROLLMENT for
 * the Claude-CLI-native ScheduleWakeup tool (EI-18680056073436345).
 *
 * Drives the hook exactly as Claude Code does — a PreToolUse JSON on stdin
 * (tool_name: 'ScheduleWakeup', tool_input: {prompt, delaySeconds, ...}) —
 * against a HERMETIC ledger dir, then asserts the written ledger row shape:
 * origin 'cli-schedule-wakeup', a hash matching the scheduled prompt (same
 * normalize-then-sha256 as turn-provenance.ts), and a per-row ttlMs sized to
 * the (clamped) requested delay + slack. Also covers the fail-open contract:
 * this hook must NEVER exit non-zero / block the tool call, whatever the
 * input.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pretooluse-schedule-wakeup-provenance.mjs');
const SID = 'su-schedule-hook-test';

let ledgerDir = '';
beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), 'sched-wakeup-hook-'));
});
afterEach(() => {
  rmSync(ledgerDir, { recursive: true, force: true });
});

function sha256Normalized(s: string): string {
  return createHash('sha256').update(s.replace(/\r\n?/g, '\n').trim(), 'utf8').digest('hex');
}

function runHook(
  payload: unknown,
  env: Record<string, string> = {},
  withSid = true,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: '/nonexistent-home',
      PAPERCUSP_TURN_PROVENANCE_DIR: ledgerDir,
      ...(withSid ? { PAPERCUSP_SID: SID } : {}),
      ...env,
    },
    timeout: 15_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function readRows(): Array<Record<string, unknown>> {
  const p = join(ledgerDir, `${SID}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('pretooluse-schedule-wakeup-provenance.mjs', () => {
  it('a ScheduleWakeup call writes a hash-only cli-schedule-wakeup ledger row', () => {
    const prompt = 'Fallback wake (WI-5862 backstop — self-imposed, not owner)';
    const out = runHook({
      tool_name: 'ScheduleWakeup',
      tool_input: { delaySeconds: 300, prompt, reason: 'watching a background run' },
      session_id: 's1',
    });
    expect(out.status).toBe(0);
    const rows = readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sid: SID,
      origin: 'cli-schedule-wakeup',
      sha256: sha256Normalized(prompt),
    });
    expect(typeof rows[0].nonce).toBe('string');
    expect(typeof rows[0].ts).toBe('number');
    // 300s (within the [60,3600] clamp) + 5min slack = 600_000ms.
    expect(rows[0].ttlMs).toBe(300_000 + 5 * 60_000);
  });

  it('clamps an out-of-range delaySeconds to the documented [60,3600] window before sizing ttlMs', () => {
    const prompt = 'a wake requesting an absurd delay';
    runHook({
      tool_name: 'ScheduleWakeup',
      tool_input: { delaySeconds: 999_999, prompt },
      session_id: 's1',
    });
    const rows = readRows();
    expect(rows[0].ttlMs).toBe(3600_000 + 5 * 60_000); // clamped to 3600s
  });

  it('clamps a too-small delaySeconds up to the 60s floor', () => {
    const prompt = 'a wake requesting an implausibly short delay';
    runHook({
      tool_name: 'ScheduleWakeup',
      tool_input: { delaySeconds: 1, prompt },
      session_id: 's1',
    });
    const rows = readRows();
    expect(rows[0].ttlMs).toBe(60_000 + 5 * 60_000); // clamped to 60s
  });

  it('a stop:true call schedules nothing → no-op, no ledger row', () => {
    const out = runHook({
      tool_name: 'ScheduleWakeup',
      tool_input: { stop: true },
      session_id: 's1',
    });
    expect(out.status).toBe(0);
    expect(readRows()).toHaveLength(0);
  });

  it('a non-ScheduleWakeup tool call is untouched', () => {
    const out = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      session_id: 's1',
    });
    expect(out.status).toBe(0);
    expect(readRows()).toHaveLength(0);
  });

  it('a missing/empty prompt is a no-op', () => {
    runHook({ tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 60, prompt: '' }, session_id: 's1' });
    expect(readRows()).toHaveLength(0);
    runHook({ tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 60 }, session_id: 's1' });
    expect(readRows()).toHaveLength(0);
  });

  it('no PAPERCUSP_SID → silent no-op (not a psu session)', () => {
    const out = runHook(
      { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 60, prompt: 'x' }, session_id: 's1' },
      {},
      false,
    );
    expect(out.status).toBe(0);
    expect(existsSync(join(ledgerDir, `${SID}.jsonl`))).toBe(false);
  });

  it('fail-open: malformed stdin JSON never blocks (exit 0)', () => {
    const out = runHook('{not json');
    expect(out.status).toBe(0);
  });

  it('CRLF in the scheduled prompt normalizes to the same hash the delivered turn will hash to', () => {
    const promptCRLF = 'line one\r\nline two\r\n';
    runHook({
      tool_name: 'ScheduleWakeup',
      tool_input: { delaySeconds: 120, prompt: promptCRLF },
      session_id: 's1',
    });
    const rows = readRows();
    expect(rows[0].sha256).toBe(sha256Normalized(promptCRLF));
    // Sanity: the LF-only equivalent hashes identically (normalize is CRLF→LF + trim).
    expect(rows[0].sha256).toBe(sha256Normalized('line one\nline two'));
  });
});
