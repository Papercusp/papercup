import { describe, expect, test } from 'vitest';
import { screenHasAssistantReply } from './vt-screen';

function frame(left: string[], right?: string[], title = 'Agent Chat'): string {
  const header = `┌ ${title} `.padEnd(36, '─') + '┐';
  return [header + (right ? '┌ Presence ──────┐' : ''), ...left.map((line, index) =>
    '│' + line.padEnd(35) + '│' + (right ? '│' + (right[index] ?? '').padEnd(16) + '│' : ''))].join('\n');
}

describe('rendered assistant reply evidence', () => {
  test('accepts an assistant bubble in a single pane', () => {
    expect(screenHasAssistantReply(frame(['agent', 'PUI-REPLY']), 'PUI-REPLY')).toBe(true);
  });
  test('accepts the same bubble beside populated Presence rows', () => {
    expect(screenHasAssistantReply(frame(['agent', 'PUI-REPLY'], ['omp active', 'working']), 'PUI-REPLY')).toBe(true);
  });
  test('retains literal pipe characters inside the assistant content', () => {
    expect(screenHasAssistantReply(frame(['agent', 'PUI│REPLY'], ['codex active']), /^PUI│REPLY$/)).toBe(true);
  });
  test('accepts a final reply after an indented reasoning section', () => {
    const screen = frame(['agent', '  reasoning', '  The requested marker is PUI-REPLY', 'RESUMED: PUI-REPLY']);
    expect(screenHasAssistantReply(screen, /^RESUMED:\s*PUI-REPLY$/)).toBe(true);
  });
  test('rejects a marker that appears only in reasoning detail', () => {
    expect(screenHasAssistantReply(frame(['agent', '  reasoning', '  PUI-REPLY']), 'PUI-REPLY')).toBe(false);
  });
  test('rejects an echoed owner request', () => {
    expect(screenHasAssistantReply(frame(['you', 'PUI-REPLY'], []), 'PUI-REPLY')).toBe(false);
  });
  test('rejects an apparent answer in a different pane', () => {
    expect(screenHasAssistantReply(frame(['you', 'still waiting'], ['agent', 'PUI-REPLY']), 'PUI-REPLY')).toBe(false);
    expect(screenHasAssistantReply(frame(['agent', 'PUI-REPLY'], undefined, 'Plans'), 'PUI-REPLY')).toBe(false);
  });
});
