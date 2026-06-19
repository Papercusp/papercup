/**
 * agent-trailer.test.ts — the agent-authored PR marker (PR-4 (c)5).
 *
 * The body carries a Co-authored-by: papercusp-bee trailer (GitHub co-author
 * attribution) + a human-visible marker; the account stays the human operator.
 * Idempotent so a re-open can't double-stamp.
 */
import { describe, expect, it } from 'vitest';
import {
  appendAgentTrailer,
  hasAgentTrailer,
  AGENT_COAUTHOR_TRAILER,
  AGENT_BODY_MARKER,
} from './agent-trailer';

describe('appendAgentTrailer', () => {
  it('appends the body marker + Co-authored-by trailer, blank-line separated', () => {
    const out = appendAgentTrailer('Automated PR for F-001.');
    expect(out).toBe(`Automated PR for F-001.\n\n${AGENT_BODY_MARKER}\n\n${AGENT_COAUTHOR_TRAILER}`);
    expect(hasAgentTrailer(out)).toBe(true);
  });

  it('is idempotent — a second append does not duplicate the trailer', () => {
    const once = appendAgentTrailer('body');
    const twice = appendAgentTrailer(once);
    expect(twice).toBe(once);
    expect(twice.match(/Co-authored-by:/g)).toHaveLength(1);
  });

  it('handles an empty body (marker + trailer only)', () => {
    expect(appendAgentTrailer('')).toBe(`${AGENT_BODY_MARKER}\n\n${AGENT_COAUTHOR_TRAILER}`);
  });

  it('the trailer names the bee as co-author (account stays the human)', () => {
    expect(AGENT_COAUTHOR_TRAILER).toMatch(/^Co-authored-by: papercusp-bee <.+@.+>$/);
  });
});
