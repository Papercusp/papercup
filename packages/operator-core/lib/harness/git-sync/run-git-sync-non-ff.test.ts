import { describe, it, expect } from 'vitest';
import { rejectedNonFastForward } from './run-git-sync';

// G21 (test-coverage-gap): the non-FF rejection detector is proven only
// empirically via integration races. This table test pins it against real git
// output strings so a future git wording change FAILS a test instead of silently
// turning a retriable non-fast-forward rejection into a hard escalation
// (run-git-sync.ts:366 retries iff this returns true).

const out = (stderr: string, stdout = '') => ({ stdout, stderr });

describe('rejectedNonFastForward — real git non-FF push rejections', () => {
  const shouldMatch: Array<[string, string]> = [
    ['classic non-fast-forward', ' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to \'origin\''],
    ['fetch first variant', ' ! [rejected]          main -> main (fetch first)'],
    ['Updates were rejected hint', 'hint: Updates were rejected because the remote contains work that you do\nhint: not have locally.'],
    ['bare [rejected] token', 'To github.com:org/repo.git\n ! [rejected]        HEAD -> main'],
  ];
  for (const [name, stderr] of shouldMatch) {
    it(`matches: ${name}`, () => expect(rejectedNonFastForward(out(stderr))).toBe(true));
  }

  const shouldNotMatch: Array<[string, string]> = [
    ['auth failure', 'fatal: Authentication failed for \'https://github.com/org/repo.git/\''],
    ['no remote', 'fatal: could not read from remote repository'],
    ['bad refspec', 'error: src refspec main does not match any'],
    ['up to date', 'Everything up-to-date'],
    ['empty', ''],
  ];
  for (const [name, stderr] of shouldNotMatch) {
    it(`does NOT match (must escalate, not retry): ${name}`, () =>
      expect(rejectedNonFastForward(out(stderr))).toBe(false));
  }

  it('inspects stdout as well as stderr', () => {
    expect(rejectedNonFastForward(out('', ' ! [rejected] (non-fast-forward)'))).toBe(true);
  });
});
