/**
 * generic-rag-chunking P-009: how plans:search names the section a chunk match
 * fell in.
 *
 * Plans are window-split (D-014), so a plan chunk records no anchor of its own.
 * plans:search takes the plan's content up to the winning window's midpoint and
 * reports the last markdown heading in that prefix. These tests pin the two
 * halves of that: the heading scan, and the window geometry — which must agree
 * with the library's real splitter, or the reported section drifts off the
 * matched text.
 */
import { describe, expect, it } from 'vitest';
import { splitWindows } from '@papercusp/search';
import { lastMarkdownHeading, planWindowGeometry, planWindowMidpoint } from '../semantic-leg';
import { PLANS_CHUNK_SURFACE } from '../../../search/chunks/registry';

describe('lastMarkdownHeading', () => {
  it('returns the last ATX heading at any level, without its #s', () => {
    const text = ['# Title', 'intro', '## Decisions', 'text', '### D-014 Plans window split', 'body'].join('\n');
    expect(lastMarkdownHeading(text)).toBe('D-014 Plans window split');
  });

  it('strips a closing run of #s and surrounding blanks', () => {
    expect(lastMarkdownHeading('## Now ##  \nstate')).toBe('Now');
    expect(lastMarkdownHeading('   #### Deep heading')).toBe('Deep heading');
  });

  it('returns null when the prefix has no heading', () => {
    expect(lastMarkdownHeading('just prose\nand more prose')).toBeNull();
    expect(lastMarkdownHeading('')).toBeNull();
  });

  it('ignores lines that are not headings', () => {
    // No space after the hashes, seven hashes, or indented four spaces (a code block).
    const text = ['## Real', '#hashtag', '####### seven', '    ## indented code'].join('\n');
    expect(lastMarkdownHeading(text)).toBe('Real');
  });

  it('ignores heading-shaped lines inside fenced code blocks', () => {
    const backticks = ['## Outside', '```bash', '# a shell comment', '```', 'after'].join('\n');
    expect(lastMarkdownHeading(backticks)).toBe('Outside');
    const tildes = ['## Outside', '~~~', '## inside tildes', '~~~'].join('\n');
    expect(lastMarkdownHeading(tildes)).toBe('Outside');
  });

  it('a fence only closes on its own kind, and an unclosed fence hides the rest', () => {
    const mixed = ['## Before', '```', '~~~', '## still inside', '```', '## After'].join('\n');
    expect(lastMarkdownHeading(mixed)).toBe('After');
    // The prefix is cut at a window midpoint, so it often ends inside a fence.
    const unclosed = ['## Before', '```ts', '# not a heading'].join('\n');
    expect(lastMarkdownHeading(unclosed)).toBe('Before');
  });
});

describe('plan window geometry', () => {
  it('reads the D-014 window from the registry entry', () => {
    expect(planWindowGeometry()).toEqual({ step: 1250, half: 750 });
    expect(planWindowMidpoint(0)).toBe(750);
    expect(planWindowMidpoint(1)).toBe(2000);
    expect(planWindowMidpoint(31)).toBe(31 * 1250 + 750);
  });

  it('agrees with the splitter the sync engine uses: window i is centred on planWindowMidpoint(i)', () => {
    const { splitter, maxChunks } = PLANS_CHUNK_SURFACE;
    if (splitter.kind !== 'window') throw new Error('plans surface is window-split (D-014)');
    // Each character encodes its own offset, so a window's text says where it starts.
    const text = Array.from({ length: 9000 }, (_, i) => String.fromCharCode(0x4e00 + (i % 20000))).join('');
    const windows = splitWindows(text, { size: splitter.size, overlap: splitter.overlap, maxChunks });
    expect(windows.length).toBeGreaterThan(3);
    const { half } = planWindowGeometry();
    for (const [i, w] of windows.entries()) {
      const start = planWindowMidpoint(i) - half;
      expect(w, `window ${i}`).toBe(text.slice(start, start + splitter.size));
    }
  });

  it('names the section a window mostly covers', () => {
    // Window 1 spans [1250, 2750); its midpoint 2000 lies after the second heading.
    const content = `## First\n${'a'.repeat(1400)}\n## Second\n${'b'.repeat(3000)}`;
    expect(content.indexOf('## Second')).toBeLessThan(planWindowMidpoint(1));
    expect(lastMarkdownHeading(content.slice(0, planWindowMidpoint(0)))).toBe('First');
    expect(lastMarkdownHeading(content.slice(0, planWindowMidpoint(1)))).toBe('Second');
  });
});
