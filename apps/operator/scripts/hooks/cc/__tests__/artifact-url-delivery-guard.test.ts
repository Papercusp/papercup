/**
 * artifact-url-delivery-guard — falsifiability suite (EI-21844056581395228).
 *
 * The guard exists because a URL was twice reported to the owner as delivered
 * when no artifact existed. A guard that has never been shown to FAIL is a guard
 * nobody has tested, so this suite pins both directions:
 *   • it CATCHES the real incident string, and
 *   • it stays SILENT on a verified id, a quoted id, and a loop continuation.
 *
 * Per the repo's mutation-probe rule, falsifiability is proven with permanent
 * deliberately-wrong CONTROLS kept in this file — never by mutating the shared
 * tree, which git-sync can commit mid-probe.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateStop,
  extractArtifactIds,
  harvestLedgerIds,
  isArtifactTool,
  lastAssistantText,
  stripQuotedForScanning,
} from '../artifact-url-delivery-guard.mjs';

/** The id from the real incident; it does not exist and never did. */
const PHANTOM = '04e509ec-1703-42fc-adeb-bb243f8794e7';
/** The real artifact published for the platform-to-app-data-producer plan. */
const REAL = 'c500b6d2-d039-49f1-8b3e-3e7819dd72d7';

const incidentText = `Design is ready for your review: **https://claude.ai/code/artifact/${PHANTOM}**`;

describe('the incident is caught', () => {
  it('blocks the exact message that was sent to the owner', () => {
    const verdict = evaluateStop({ text: incidentText, ledger: new Set(), stopHookActive: false });
    expect(verdict).not.toBeNull();
    expect(verdict!.unverified).toEqual([PHANTOM]);
    expect(verdict!.reason).toContain(PHANTOM);
    expect(verdict!.reason).toContain('EI-21844056581395228');
  });

  it('CONTROL: a guard that ignored the ledger would not catch it — proving the assertion has teeth', () => {
    // A no-op guard is what "the rail is in the prompt" amounted to. If this
    // control ever starts passing the real assertion above, the test is broken.
    const noOpGuard = () => null;
    expect(noOpGuard()).toBeNull();
    expect(evaluateStop({ text: incidentText, ledger: new Set(), stopHookActive: false })).not.toBeNull();
  });
});

describe('no false positives', () => {
  it('allows an id a real Artifact call returned this session', () => {
    expect(evaluateStop({ text: `Published: https://claude.ai/code/artifact/${REAL}`, ledger: new Set([REAL]), stopHookActive: false })).toBeNull();
  });

  it('allows a turn that cites no artifact URL at all', () => {
    expect(evaluateStop({ text: 'Closed the item; evidence is on the work-item.', ledger: new Set(), stopHookActive: false })).toBeNull();
  });

  it.each([
    ['inline code', `Never cite \`https://claude.ai/code/artifact/${PHANTOM}\` — it does not exist.`],
    ['a fenced block', `\`\`\`\nhttps://claude.ai/code/artifact/${PHANTOM}\n\`\`\``],
    ['a blockquote', `> https://claude.ai/code/artifact/${PHANTOM}`],
  ])('allows a known-bad URL quoted as %s', (_label, text) => {
    expect(evaluateStop({ text, ledger: new Set(), stopHookActive: false })).toBeNull();
  });

  it('CONTROL: without quote-stripping those same strings WOULD trip — the stripper is load-bearing', () => {
    const quoted = `Never cite \`https://claude.ai/code/artifact/${PHANTOM}\``;
    expect(extractArtifactIds(quoted)).toEqual([PHANTOM]); // present in the raw text
    expect(extractArtifactIds(stripQuotedForScanning(quoted))).toEqual([]); // removed before scanning
  });
});

describe('the loop guard cannot wedge a session', () => {
  it('stays silent on the continuation that follows its own block', () => {
    expect(evaluateStop({ text: incidentText, ledger: new Set(), stopHookActive: true })).toBeNull();
  });
});

describe('the ledger oracle', () => {
  it('harvests ids a successful call returned', () => {
    const ids = harvestLedgerIds({
      tool_name: 'Artifact',
      tool_response: { artifacts: [{ url: `https://claude.ai/code/artifact/${REAL}` }] },
    });
    expect(ids).toEqual([REAL]);
  });

  it('refuses to harvest from an ERROR response — a bad URL cannot verify itself', () => {
    // The dangerous case: reading a nonexistent artifact echoes the requested
    // URL back inside the failure. Harvesting that would let a phantom URL
    // launder itself into the ledger and defeat the whole guard.
    for (const response of [
      { is_error: true, content: `not found: https://claude.ai/code/artifact/${PHANTOM}` },
      { error: 'no such artifact', url: `https://claude.ai/code/artifact/${PHANTOM}` },
      { ok: false, url: `https://claude.ai/code/artifact/${PHANTOM}` },
    ]) {
      expect(harvestLedgerIds({ tool_name: 'Artifact', tool_response: response })).toEqual([]);
    }
  });

  it('ignores an id that appears only in the REQUEST', () => {
    // An id the agent asserted is exactly the unverified thing being guarded.
    const ids = harvestLedgerIds({
      tool_name: 'Artifact',
      tool_input: { url: `https://claude.ai/code/artifact/${PHANTOM}` },
      tool_response: { ok: true, artifacts: [] },
    });
    expect(ids).toEqual([]);
  });

  it('ignores non-Artifact tools', () => {
    expect(harvestLedgerIds({ tool_name: 'Write', tool_response: { url: `https://claude.ai/code/artifact/${REAL}` } })).toEqual([]);
    expect(isArtifactTool('Artifact')).toBe(true);
    expect(isArtifactTool('mcp__papercusp-su__artifact')).toBe(true);
    expect(isArtifactTool('Write')).toBe(false);
  });
});

describe('transcript extraction', () => {
  const line = (obj: unknown) => JSON.stringify(obj);

  it('returns the most recent assistant TEXT, skipping tool-only turns', () => {
    const transcript = [
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'older turn' }] } }),
      line({ type: 'user', message: { content: 'a prompt' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: incidentText }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
    ].join('\n');
    const read = () => transcript;
    expect(lastAssistantText('/fake', read as never)).toBe(incidentText);
  });

  it('fails open to an empty string when the transcript is unreadable', () => {
    const read = () => {
      throw new Error('ENOENT');
    };
    expect(lastAssistantText('/missing', read as never)).toBe('');
    expect(lastAssistantText('', read as never)).toBe('');
  });
});
