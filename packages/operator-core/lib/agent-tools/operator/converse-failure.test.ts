import { describe, expect, it } from 'vitest';
import { BRAIN_NO_OUTPUT_PREFIX, brainNoOutputMessage } from './converse-failure';

describe('brainNoOutputMessage — a failed converse turn says WHY (WI-10003188)', () => {
  it("carries the backend's own error line plus the backend and model that ran", () => {
    const msg = brainNoOutputMessage({
      engine: 'codex',
      model: 'gpt-5.6-luna:low',
      lastBackendError: 'codex: not logged in (run `codex login`)\n--- noise on a later line ---',
    });
    expect(msg.startsWith(BRAIN_NO_OUTPUT_PREFIX)).toBe(true);
    expect(msg).toContain('codex, model gpt-5.6-luna:low');
    expect(msg).toContain('codex: not logged in');
    // Only the first line travels; the rest stays in the host journal.
    expect(msg).not.toContain('noise on a later line');
  });

  it('with no backend error, names the backend and points at its credential instead of a bare "failure"', () => {
    const msg = brainNoOutputMessage({ engine: 'codex', model: 'gpt-5.6-luna:low', lastBackendError: null });
    expect(msg).toContain('codex, model gpt-5.6-luna:low returned an empty turn and reported no error');
    expect(msg).toContain('working codex credential');
    // The old fixed text said nothing actionable; this must never regress to it.
    expect(msg).not.toBe('operator brain produced no output (agent backend failure)');
  });

  it('keeps the legacy prefix so existing log greps still match', () => {
    expect(BRAIN_NO_OUTPUT_PREFIX).toBe('operator brain produced no output (agent backend failure');
  });

  it('caps a runaway backend error line and skips blank leading lines', () => {
    const msg = brainNoOutputMessage({ engine: 'claude', model: null, lastBackendError: `\n   \n${'x'.repeat(1000)}` });
    expect(msg).toContain(': claude: ');
    expect(msg).not.toContain('model');
    const backendPart = msg.slice(msg.indexOf(': claude: ') + ': claude: '.length, -1);
    expect(backendPart.length).toBeLessThanOrEqual(240);
    expect(backendPart.endsWith('…')).toBe(true);
  });

  it('degrades to a generic label when the backend is unknown', () => {
    expect(brainNoOutputMessage({ engine: undefined, model: undefined, lastBackendError: '' })).toContain(
      'unknown backend returned an empty turn',
    );
  });
});
