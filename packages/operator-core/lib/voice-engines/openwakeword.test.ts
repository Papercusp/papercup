import { describe, it, expect } from 'vitest';
import { OPENWAKEWORD_KEYWORDS, startOpenWakeWordDetection } from './openwakeword';

describe('OPENWAKEWORD_KEYWORDS', () => {
  it('exposes the built-in keyword set, all unique', () => {
    expect(OPENWAKEWORD_KEYWORDS.length).toBeGreaterThan(0);
    expect(new Set(OPENWAKEWORD_KEYWORDS).size).toBe(OPENWAKEWORD_KEYWORDS.length);
    expect(OPENWAKEWORD_KEYWORDS).toContain('hey_jarvis');
  });
});

describe('startOpenWakeWordDetection', () => {
  it('refuses to start outside a browser audio context', async () => {
    await expect(
      startOpenWakeWordDetection({ keyword: 'alexa', onWake: () => {} }),
    ).rejects.toThrow(/not in browser|getUserMedia/);
  });
});
