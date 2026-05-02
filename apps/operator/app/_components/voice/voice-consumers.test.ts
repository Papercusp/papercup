import { describe, it, expect } from 'vitest';
import { registerVoiceConsumer } from './VoiceAppBridge';

describe('voice consumer registration', () => {
  it('register returns a deregister function', () => {
    const dereg = registerVoiceConsumer('test-1');
    expect(typeof dereg).toBe('function');
    dereg();
  });

  it('multiple consumers can register concurrently', () => {
    const d1 = registerVoiceConsumer('a');
    const d2 = registerVoiceConsumer('b');
    d1();
    d2();
  });

  it('deregister is idempotent (no throw on second call)', () => {
    const dereg = registerVoiceConsumer('once');
    dereg();
    expect(() => dereg()).not.toThrow();
  });
});
