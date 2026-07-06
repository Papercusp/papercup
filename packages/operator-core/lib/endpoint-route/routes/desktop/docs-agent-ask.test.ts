/**
 * docs-agent-ask.test.ts — the pure helpers behind the tutorial's "ask an agent"
 * launcher: the seeded first-turn prompt, the psu launch command, and the shell
 * quoting that keeps a free-form question from breaking out of the greetingCmd.
 * (The launch/reuse handler itself is exercised live — it spawns a real terminal
 * + sends coord messages, neither unit-testable in isolation.)
 */
import { describe, expect, it } from 'vitest';
import {
  DOCS_AGENT_LABEL,
  composeDocsAgentKickoff,
  buildDocsAgentPsuCommand,
  shq,
} from './docs-agent-ask';

describe('shq (greetingCmd shell quoting)', () => {
  it('leaves a safe slug bare', () => {
    expect(shq('docs-tutor')).toBe('docs-tutor');
    expect(shq('opus:high')).toBe('opus:high');
  });
  it('single-quotes anything with whitespace / shell metacharacters', () => {
    expect(shq('what is a pot?')).toBe(`'what is a pot?'`);
    expect(shq('a & b | c')).toBe(`'a & b | c'`);
  });
  it("escapes an embedded single quote so it can't break out of the command", () => {
    expect(shq("it's a pot")).toBe(`'it'\\''s a pot'`);
  });
});

describe('composeDocsAgentKickoff (the seeded first user turn)', () => {
  const p = composeDocsAgentKickoff('what is a bee?');
  it('embeds the raw question as the first turn', () => {
    expect(p).toContain('what is a bee?');
  });
  it('mandates harness:"all" on every docs tool call (the :3070 harness_required fix)', () => {
    expect(p).toContain('harness: "all"');
    expect(p).toMatch(/MANDATORY/);
    expect(p).toContain('docs:search');
    expect(p).toContain('docs:get');
  });
  it('forbids asking the user about harness/scope and treats jargon-first', () => {
    expect(p).toMatch(/NEVER ask the user which harness/);
    expect(p).toMatch(/pot, bee, mug, queen, hive, cup, swarm/);
  });
  it('tells the agent it is a PERSISTENT session that gets coord follow-ups', () => {
    expect(p).toMatch(/PERSISTENT session/);
    expect(p).toMatch(/coordination messages/);
  });
});

describe('buildDocsAgentPsuCommand (the psu launch)', () => {
  it('is a scripted no-picker, no-plan claude launch stamped with the label + kickoff', () => {
    const cmd = buildDocsAgentPsuCommand({
      kickoff: 'answer: what is a pot?',
      label: DOCS_AGENT_LABEL,
      workspace: 'default',
    });
    expect(cmd.startsWith('psu --no-picker --agent=claude --no-plan')).toBe(true);
    expect(cmd).toContain('--workspace=default');
    expect(cmd).toContain('--label=docs-tutor');
    // the free-form kickoff is single-quoted as ONE token
    expect(cmd).toContain(`--kickoff='answer: what is a pot?'`);
  });
  it('shell-quotes a workspace / kickoff containing metacharacters', () => {
    const cmd = buildDocsAgentPsuCommand({
      kickoff: "what's a queen & a hive?",
      label: DOCS_AGENT_LABEL,
      workspace: 'ws one',
    });
    expect(cmd).toContain(`--workspace='ws one'`);
    expect(cmd).toContain(`--kickoff='what'\\''s a queen & a hive?'`);
  });
});
