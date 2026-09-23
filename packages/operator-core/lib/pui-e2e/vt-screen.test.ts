import { describe, expect, test } from 'vitest';
import { paneContains, screenContains, screenHasAssistantReply } from './vt-screen';

function frame(left: string[], right?: string[], title = 'Agent Chat'): string {
  const header = `┌ ${title} `.padEnd(36, '─') + '┐';
  return [header + (right ? '┌ Presence ──────┐' : ''), ...left.map((line, index) =>
    '│' + line.padEnd(35) + '│' + (right ? '│' + (right[index] ?? '').padEnd(16) + '│' : ''))].join('\n');
}

describe('rendered screen needle matching', () => {
  // A double-width glyph occupies TWO terminal columns. VtScreen models one
  // cell per character and honours the cursor move Ratatui emits past the
  // continuation column, so that column replays as the blank it began as: a
  // composer holding `日本語` reads back off the grid as `日 本 語`.
  const padded = '│> δraft ünsent 日 本 語          ││';

  test('matches a double-width needle across its continuation columns', () => {
    expect(screenContains(padded, '> δraft ünsent 日本語')).toBe(true);
  });
  test('still matches a needle written with the padding intact', () => {
    expect(screenContains(padded, '日 本 語')).toBe(true);
  });
  test('treats an astral-plane glyph as ONE character, not a surrogate pair', () => {
    expect(screenContains('│draft 🙂 x', 'draft 🙂x')).toBe(true);
  });

  // Negative controls. Collapsing the screen must not MANUFACTURE a match:
  // a helper that simply stripped every space would satisfy all three cases
  // above while making this clause's assertions unfalsifiable.
  test('rejects a double-width needle that is not on the screen', () => {
    expect(screenContains(padded, '日本語字')).toBe(false);
    expect(screenContains(padded, '日語')).toBe(false);
  });
  test('never strips a space that follows a NARROW character', () => {
    expect(screenContains(padded, 'δraftünsent')).toBe(false);
  });
  test('leaves an all-narrow needle on the untouched path', () => {
    expect(screenContains('│PUI-REPLY        ││', 'PUI-REPLY')).toBe(true);
    expect(screenContains('│PUI-REPLY        ││', 'PUI-ABSENT')).toBe(false);
  });
});

describe('rendered assistant reply evidence', () => {
  // Real frames: the transcript list draws a two-column highlight gutter, so
  // labels read `  agent` / `  you`, and `▸ agent` on the focused message.
  test('accepts the gutter and focus-marker label forms the PUI actually renders', () => {
    expect(screenHasAssistantReply(frame(['  you', 'Hi.', '▸ agent', 'PUI-REPLY']), 'PUI-REPLY')).toBe(true);
    expect(screenHasAssistantReply(frame(['  agent', 'PUI-REPLY', '▸ you', 'next']), 'PUI-REPLY')).toBe(true);
  });
  test('still ends the bubble at the next gutter-labelled owner turn', () => {
    expect(screenHasAssistantReply(frame(['  agent', 'waiting', '  you', 'PUI-REPLY']), 'PUI-REPLY')).toBe(false);
  });
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

describe('pane-scoped wrapped text', () => {
  const composer = 'Message not accepted';
  test('reads a phrase the pane soft-wrapped across rows, which the row-bound matcher cannot', () => {
    // The measured shape: the composer wrapped the operator error between
    // "connection" and "interrupted", and where it wraps depends on open panes.
    const screen = frame(['503: PUI-E2E startup connection', 'interrupted draft kept'], ['omp', 'active'], composer);
    expect(screenContains(screen, 'PUI-E2E startup connection interrupted')).toBe(false);
    expect(paneContains(screen, composer, 'PUI-E2E startup connection interrupted')).toBe(true);
  });
  test('never splices the neighbouring pane into the phrase', () => {
    const screen = frame(['PUI-E2E startup', 'draft kept'], ['connection', 'interrupted'], composer);
    expect(paneContains(screen, composer, 'PUI-E2E startup connection')).toBe(false);
    expect(paneContains(screen, 'Presence', 'connection interrupted')).toBe(true);
  });
  test('only reads the pane the title names', () => {
    expect(paneContains(frame(['PUI-E2E startup connection interrupted']), 'Plans', 'startup connection')).toBe(false);
  });
});
