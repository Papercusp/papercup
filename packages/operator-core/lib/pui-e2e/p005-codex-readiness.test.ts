import { describe, expect, it } from 'vitest';
import {
  CODEX_GREETING_EXPECTATION,
  codexHomeControlSocketPath,
  codexHomeFitsControlSocket,
  codexStartupAction,
  codexTaskCompleted,
  isCodexPromptReady,
} from './p005-codex-readiness.js';

describe('P-005 Codex TUI readiness', () => {
  it('keeps the isolated CODEX_HOME control socket below the Unix path limit', () => {
    const shortHome = '/tmp/p5c-a1b2c3';
    expect(codexHomeFitsControlSocket(shortHome)).toBe(true);
    expect(codexHomeControlSocketPath(shortHome)).toBe('/tmp/p5c-a1b2c3/app-server-control/app-server-control.sock');
    expect(codexHomeFitsControlSocket(`/tmp/${'long-path-segment-'.repeat(8)}`)).toBe(false);
  });

  it('does not mistake daemon installation or the empty command center for a ready prompt', () => {
    expect(isCodexPromptReady('Installing daemon from CLI version 0.157.1...')).toBe(false);
    expect(isCodexPromptReady('model: loading\ndirectory: loading\n› Ask Codex to do anything')).toBe(false);
    const commandCenter = 'Agent command center  Group: Project\nNo tasks yet\n? help  esc back  n new';
    expect(isCodexPromptReady(commandCenter)).toBe(false);
    expect(codexStartupAction(commandCenter, true)).toEqual({ kind: 'create-first-task', keys: 'n' });
    expect(codexStartupAction(commandCenter, false)).toBeNull();
  });

  it('answers the first-run trust prompt and skips only the update dialog', () => {
    expect(codexStartupAction('Trust this folder?\n1. Trust and continue', true))
      .toEqual({ kind: 'trust-folder', keys: '\r' });
    expect(codexStartupAction('Update available\nSkip', true))
      .toEqual({ kind: 'skip-update', keys: '\x1b[B\r' });
    expect(codexStartupAction('Update available! 0.157.1 -> 0.159.3', true)).toBeNull();
    expect(isCodexPromptReady('model: GPT-6-Astra\ndirectory: /tmp/p005\n› Ask Codex to do anything')).toBe(true);
  });

  it('counts a task only when its prompt, expected answer, and idle composer are visible', () => {
    const completed = 'The prompt is yours.\n› hi\n• Hi! What can I help you with?\n› Ask Codex to do anything';
    const alternateGreeting = '› hi\n• Hi! What would you like to work on?\n› Ask Codex to do anything';
    expect(codexTaskCompleted(completed, 'hi', CODEX_GREETING_EXPECTATION)).toBe(true);
    expect(codexTaskCompleted(alternateGreeting, 'hi', CODEX_GREETING_EXPECTATION)).toBe(true);
    expect(codexTaskCompleted('› Ask Codex to do anything', 'hi', CODEX_GREETING_EXPECTATION)).toBe(false);
    expect(codexTaskCompleted('Agent command center\nNo tasks yet\nn new', 'hi', /what can I help you with/i)).toBe(false);
  });
});
