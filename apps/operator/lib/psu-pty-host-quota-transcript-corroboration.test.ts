/**
 * WI-10003875 — a claude quota match on the pty screen is only a CANDIDATE wall.
 *
 * The claude banner set is bare phrases, so the model's own prose can match it:
 * su-be77f2f5's final message "its own 11.5-hour limit ran out" hit
 * /5-hour limit/i, the idle screen never repainted, and every wake for ~18h was
 * turn-deferred-quota-blocked until a human typed. These tests pin the
 * corroboration that tells that echo apart from a real wall (which Claude Code
 * records as a synthetic `isApiErrorMessage` row with `error:'rate_limit'`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeQuotaTranscriptVerdict,
  claudeTranscriptRowText,
  makeClaudeQuotaCorroborator,
  makeQuotaBlockDetector,
  QUOTA_CORROBORATE_TTL_MS,
} from '../scripts/psu-pty-host.mjs';

// The excerpt the host logged on 2026-09-28T21:28:45Z (quota-block-detected,
// matchedPattern /5-hour limit/i) — the model's own words.
const INCIDENT_PROSE =
  'The soak watcher woke me because its own 11.5-hour limit ran out, not because of a problem.';

const assistantText = (text: string, ts = '2026-09-28T21:28:44.000Z') => ({
  type: 'assistant',
  timestamp: ts,
  message: { model: 'claude-opus', role: 'assistant', content: [{ type: 'text', text }] },
});
const userPrompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
// Shapes captured from real Claude Code transcripts on this box (v2.1.25x).
const sessionWall = {
  type: 'assistant',
  isApiErrorMessage: true,
  error: 'rate_limit',
  message: {
    model: '<synthetic>',
    role: 'assistant',
    content: [{ type: 'text', text: "You've hit your session limit · resets 7:20am (America/New_York)" }],
  },
};
const http429 = {
  type: 'assistant',
  isApiErrorMessage: true,
  error: 'rate_limit',
  message: {
    model: '<synthetic>',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.",
      },
    ],
  },
};

describe('claudeQuotaTranscriptVerdict', () => {
  it('reads the incident prose as a transcript echo, not a wall', () => {
    expect(claudeQuotaTranscriptVerdict([userPrompt('wake'), assistantText(INCIDENT_PROSE)])).toBe('echo');
  });

  it('reads a synthetic rate_limit row as a real wall', () => {
    expect(claudeQuotaTranscriptVerdict([assistantText('done'), userPrompt('next'), sessionWall])).toBe('walled');
    expect(claudeQuotaTranscriptVerdict([userPrompt('next'), http429])).toBe('walled');
  });

  it('lets the NEWER of an echo and a wall decide', () => {
    // A wall that happened after the model talked about limits is still a wall.
    expect(claudeQuotaTranscriptVerdict([assistantText(INCIDENT_PROSE), userPrompt('go'), sessionWall])).toBe(
      'walled',
    );
    // A wall that was followed by successful model output has lifted.
    expect(claudeQuotaTranscriptVerdict([sessionWall, userPrompt('go'), assistantText(INCIDENT_PROSE)])).toBe(
      'echo',
    );
  });

  it('treats a tool_result that quotes a usage wall as an echo', () => {
    const toolResult = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: "codex exited 1: You've hit your usage limit. Visit settings" }],
      },
    };
    expect(claudeQuotaTranscriptVerdict([toolResult])).toBe('echo');
  });

  it('fails closed when nothing decisive is present', () => {
    expect(claudeQuotaTranscriptVerdict(null)).toBe('unknown');
    expect(claudeQuotaTranscriptVerdict([])).toBe('unknown');
    expect(claudeQuotaTranscriptVerdict([assistantText('all quiet'), userPrompt('ok')])).toBe('unknown');
    // A non-quota API error says nothing about quota.
    const authError = {
      type: 'assistant',
      isApiErrorMessage: true,
      error: 'authentication_failed',
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 401' }] },
    };
    expect(claudeQuotaTranscriptVerdict([authError])).toBe('unknown');
  });

  it('extracts text, tool_use input and tool_result bodies', () => {
    const row = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'a' },
          { type: 'tool_use', input: { cmd: 'b' } },
          { type: 'tool_result', content: [{ type: 'text', text: 'c' }] },
        ],
      },
    };
    expect(claudeTranscriptRowText(row)).toBe('a\n{"cmd":"b"}\nc');
  });
});

describe('makeQuotaBlockDetector with a corroborator', () => {
  it('latches on the incident prose without a corroborator (the regression being fixed)', () => {
    const d = makeQuotaBlockDetector({ agent: 'claude' });
    expect(d.observe(INCIDENT_PROSE)).toBe('detected');
    expect(d.isBlocked()).toBe(true);
    expect(d.isBlocked()).toBe(true);
  });

  it('dismisses an echo, reports it once, and does not re-latch on unrelated output', () => {
    const dismissed: Array<{ pattern: string | null }> = [];
    const d = makeQuotaBlockDetector({
      agent: 'claude',
      corroborate: () => 'echo',
      onDismiss: (m: { pattern: string | null }) => dismissed.push(m),
    });
    expect(d.observe(INCIDENT_PROSE)).toBe('detected');
    expect(d.isBlocked()).toBe(false);
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0].pattern).toBe(String(/5-hour limit/i));
    expect(d.snapshot().quotaBlocked).toBe(false);
    // The stale window was dropped, so ordinary output does not re-match it.
    expect(d.observe('\n> ')).toBeNull();
    expect(d.isBlocked()).toBe(false);
  });

  it('keeps a real or unverifiable wall blocked (fail closed)', () => {
    for (const corroborate of [() => 'walled', () => 'unknown', () => { throw new Error('io'); }]) {
      const d = makeQuotaBlockDetector({ agent: 'claude', corroborate });
      d.observe("You've hit your session limit · resets 7:20am");
      expect(d.isBlocked()).toBe(true);
      expect(d.snapshot().quotaBlocked).toBe(true);
    }
  });

  it('re-consults at most once per TTL while latched', () => {
    let t = 1_000_000;
    let calls = 0;
    let answer = 'unknown';
    const d = makeQuotaBlockDetector({
      agent: 'claude',
      now: () => t,
      corroborate: () => {
        calls += 1;
        return answer;
      },
    });
    d.observe(INCIDENT_PROSE);
    expect(d.isBlocked()).toBe(true);
    expect(d.isBlocked()).toBe(true);
    expect(calls).toBe(1);
    // The transcript's newest row finished writing; the next TTL window sees it.
    answer = 'echo';
    t += QUOTA_CORROBORATE_TTL_MS - 1;
    expect(d.isBlocked()).toBe(true);
    t += 1;
    expect(d.isBlocked()).toBe(false);
    expect(calls).toBe(2);
  });
});

describe('makeClaudeQuotaCorroborator (isolated transcript on disk)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const withTranscript = (rows: unknown[], { trailingNewline = true } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'wi10003875-'));
    dirs.push(root);
    const project = join(root, 'projects', '-repo');
    mkdirSync(project, { recursive: true });
    const body = rows.map((r) => JSON.stringify(r)).join('\n') + (trailingNewline ? '\n' : '');
    writeFileSync(join(project, 'session.jsonl'), body);
    return makeClaudeQuotaCorroborator({ CLAUDE_CONFIG_DIR: root }, root);
  };

  it('answers echo for the incident transcript and walled for a real wall', () => {
    expect(withTranscript([userPrompt('wake'), assistantText(INCIDENT_PROSE)])()).toBe('echo');
    expect(withTranscript([userPrompt('wake'), sessionWall])()).toBe('walled');
  });

  it('fails closed with no isolated root or a half-written newest row', () => {
    expect(makeClaudeQuotaCorroborator({}, tmpdir())()).toBe('unknown');
    expect(withTranscript([assistantText(INCIDENT_PROSE)], { trailingNewline: false })()).toBe('unknown');
  });
});
