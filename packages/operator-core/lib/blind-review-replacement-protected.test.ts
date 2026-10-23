import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { replacementFixture } from './__tests__/_blind-review-replacement-fixture';

describe('recruiter replacement eligibility interleaving', () => {
  const fixture = () => replacementFixture(resolve(__dirname, '../../..'),
    'packages/operator-core/lib/blind-review-replacement-protected.test.ts');

  it.each(['inconclusive', 'conclusive', 'live', 'resuming', 'reserved'])('protected-state-interleaving-%s: rechecks eligibility after the brief while reservation is pending', async kind => {
    const f = fixture();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    f.deps.resolveImplementers = async () => { entered(); await barrier; return ['su-author']; };
    const request = f.run();
    await pending;
    expect(f.state.attempts).toEqual([]);
    if (kind === 'conclusive') { f.state.material.outcome = 'conclusive'; f.state.material.summary = 'CONCLUSIVE: reviewed'; }
    if (kind === 'live') f.state.ended = false;
    if (kind === 'resuming') f.state.sourceStatus = 'resuming';
    if (kind === 'reserved') f.state.resumeClaim = 'resume-active';
    release();
    if (kind === 'inconclusive') {
      expect(await request).toMatchObject({ ok: true, attempt: { status: 'ready' } });
      expect(f.launch).toHaveBeenCalledTimes(1);
    } else {
      expect(await request).toMatchObject({ ok: false, error: 'review_protected' });
      expect(f.state.attempts).toEqual([]);
      expect(f.launch).not.toHaveBeenCalled();
    }
  });
});
