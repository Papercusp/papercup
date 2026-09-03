/**
 * EI-19344528739076339 — the `pipeline` identity, and why it must never be a harness slug.
 *
 * Run: cd packages/operator-core && npx vitest run lib/release/pipeline-name.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentPipelineName,
  isMultiPipelineGateKey,
  isMultiPipelineGateKeyPattern,
  pipelineName,
  pipelineRef,
  pipelineTag,
  MULTI_PIPELINE_GATE_KEYS,
} from './pipeline-name';

const ORIGINAL = process.env.PAPERCUSP_INTEGRATION_ROOT;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
  else process.env.PAPERCUSP_INTEGRATION_ROOT = ORIGINAL;
});

describe('pipelineName', () => {
  /**
   * These four cases are lifted VERBATIM from green-checkpoint.test.ts's own pipelineName
   * block. green-checkpoint.ts is the emitter of record and lives in a different workspace
   * (apps/operator), so this suite cannot import it — duplicating its assertions is what
   * keeps the awaiting side pinned to the emitting side. If someone changes either
   * derivation, one of these two suites goes red.
   */
  it('⭐ is the sanitized BASENAME of the integration root — byte-identical to the emitter', () => {
    expect(pipelineName('/home/x/papercupai-workspace/papercusp')).toBe('papercusp');
    expect(pipelineName('/home/x/papercupai-workspace/papercup/')).toBe('papercup');
  });

  it('sanitizes characters that are not safe in an event-key segment', () => {
    expect(pipelineName('/tmp/my repo!')).toBe('my-repo-');
  });

  it('caps the segment at 64 chars', () => {
    expect(pipelineName(`/tmp/${'a'.repeat(200)}`)).toHaveLength(64);
  });

  /**
   * The whole reason this module exists. `papercusp` and `papercup` are one letter apart and
   * co-hosted on the same box; the value is whatever the CHECKOUT DIRECTORY is called, so it
   * is not derivable from a harness slug and must not be guessed from one.
   */
  it('⭐ distinguishes the two co-hosted pipelines that differ by one letter', () => {
    expect(pipelineName('/w/papercusp')).not.toBe(pipelineName('/w/papercup'));
  });
});

describe('pipelineTag', () => {
  /**
   * EI-21949138739080608. Lifted VERBATIM from green-checkpoint.test.ts's own pipelineTag
   * block, for the same reason the pipelineName cases above are: the emitter of record lives
   * in another workspace this suite cannot import, so duplicated assertions are what keep the
   * two renderings pinned. Change either and one of the two suites goes red.
   */
  it('⭐ tags with a `pipeline:` discriminator — byte-identical to the emitter', () => {
    expect(pipelineTag('papercusp')).toBe('[pipeline:papercusp]');
    expect(pipelineTag('email')).toBe('[pipeline:email]');
  });

  /**
   * The regression itself: a BARE bracketed basename reads as a redaction/template artifact
   * when the pipeline name collides with an ordinary word. `[email]` was filed as "names no
   * hive" by a reader who quoted that very tag without recognising it.
   */
  it('⭐ is not the bare bracketed basename that was misread as a placeholder', () => {
    expect(pipelineTag('email')).not.toBe('[email]');
    expect(pipelineTag('email')).toContain('email');
  });
});

describe('pipelineRef — EI-22240267519750098: the CLAIM must be attributable, not just the prefix', () => {
  // Fourth instance of one class. The three fixes before it all asked "is the pipeline
  // NAMED?" — prefix the broadcast, prefix the wake banner, make the prefix legible — and
  // coverage became complete. It recurred anyway: an su read
  //   [pipeline:email] 🟩 green-checkpoint: `main` advanced to ad49e48a (green, deployable)
  // as their own gate greening. A prefix reads as routing metadata; the sentence after it
  // is the claim, and its subject `main` is a ref every reader resolves against their OWN
  // checkout. So the property here is not presence but: does the CLAIM survive losing the
  // prefix?

  it('qualifies the ref with its pipeline', () => {
    expect(pipelineRef('email', 'main')).toBe('email:main');
    expect(pipelineRef('papercusp', 'ready')).toBe('papercusp:ready');
  });

  it('⭐ CONTROL — "is the pipeline named?" passes on the exact string that caused the incident', () => {
    // A permanent deliberately-weak predicate, kept as the control: it must NOT be able to
    // separate the pre-fix rendering from the fixed one. Nothing in production is mutated
    // to prove this guard falsifiable.
    const preFix = `${pipelineTag('email')} 🟩 green-checkpoint: \`main\` advanced to ad49e48a`;
    const postFix = `${pipelineTag('email')} 🟩 green-checkpoint: \`${pipelineRef('email', 'main')}\` advanced to ad49e48a`;
    expect(preFix).toContain('email');
    expect(postFix).toContain('email');

    // The real predicate — strip the routing prefix, then look for a ref a reader would
    // resolve locally — separates them. This is the assertion the incident fails.
    const claimOf = (s: string): string => s.slice(pipelineTag('email').length).trim();
    const bareMain = /(^|[^:\w-])main\b/;
    expect(claimOf(preFix)).toMatch(bareMain);
    expect(claimOf(postFix)).not.toMatch(bareMain);
  });

  it('keeps neighbouring pipelines distinguishable — the papercusp/papercup hazard at ref level', () => {
    expect(pipelineRef('papercusp', 'main')).not.toBe(pipelineRef('papercup', 'main'));
    for (const p of ['email', 'papercusp', 'papercup', 'oddsmith', 'hello-world-3-pot']) {
      expect(pipelineRef(p, 'main')).not.toBe('main');
      expect(pipelineRef(p, 'main')).toContain(p);
    }
  });
});

describe('currentPipelineName', () => {
  it('resolves from PAPERCUSP_INTEGRATION_ROOT', () => {
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/home/x/papercupai-workspace/papercusp';
    expect(currentPipelineName()).toBe('papercusp');
  });

  /**
   * The safety property. A caller auto-scoping an await must be able to tell "I know which
   * pipeline I am" from "I do not" — because narrowing a payload_filter on a wrong value
   * produces an await that can NEVER fire, which is a silent hang. A noisy wrong-pipeline
   * wake is recoverable; sleeping through your own green is not. So the unresolvable case
   * has to be reportable, never papered over with the sanitizer's 'default' fallback.
   */
  it('⭐ answers null rather than the sanitizer\'s "default" fallback when it cannot resolve', () => {
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/';
    expect(currentPipelineName()).toBeNull();
  });
});

describe('isMultiPipelineGateKey', () => {
  it('⭐ flags the three GLOBALLY-emitted gate keys — the ones that fire from every co-hosted pipeline', () => {
    expect(isMultiPipelineGateKey('release:green')).toBe(true);
    expect(isMultiPipelineGateKey('green-checkpoint:red')).toBe(true);
    // EI-19928976726540168: the third terminal-outcome family — was missing entirely before
    // this fix, so even the EXACT-key form was unscoped for it.
    expect(isMultiPipelineGateKey('green-checkpoint:inconclusive')).toBe(true);
  });

  it('does NOT flag an already pipeline-scoped key — that one is already safe', () => {
    expect(isMultiPipelineGateKey('release:green:papercusp')).toBe(false);
    expect(isMultiPipelineGateKey('green-checkpoint:red:oddsmith')).toBe(false);
  });

  it('does not flag unrelated keys', () => {
    expect(isMultiPipelineGateKey('work-item:claimable')).toBe(false);
    expect(isMultiPipelineGateKey('')).toBe(false);
  });

  it('every declared key is bare (no colon-suffixed pipeline segment baked in)', () => {
    for (const k of MULTI_PIPELINE_GATE_KEYS) expect(k.split(':').length).toBeLessThanOrEqual(2);
  });
});

describe('isMultiPipelineGateKeyPattern', () => {
  /**
   * EI-19928976726540168: the glob form an agent reaches for when they actually want "any
   * verdict for my pipeline" — exactly as cross-tenant as the bare key, but the exact-key
   * auto-narrow never runs for it (it requires `!patternAwait`).
   */
  it('⭐ flags the exact `<family>:*` glob for each multi-pipeline gate key', () => {
    expect(isMultiPipelineGateKeyPattern('release:green:*')).toBe(true);
    expect(isMultiPipelineGateKeyPattern('green-checkpoint:red:*')).toBe(true);
    expect(isMultiPipelineGateKeyPattern('green-checkpoint:inconclusive:*')).toBe(true);
  });

  it('does not flag a glob with no colon before the star', () => {
    expect(isMultiPipelineGateKeyPattern('release:green*')).toBe(false);
  });

  it('does not flag a multi-segment or already-scoped glob', () => {
    expect(isMultiPipelineGateKeyPattern('release:green:papercusp:*')).toBe(false);
    expect(isMultiPipelineGateKeyPattern('release:green:papercusp')).toBe(false);
  });

  it('does not flag an unrelated glob or a bare non-glob key', () => {
    expect(isMultiPipelineGateKeyPattern('work-item:*')).toBe(false);
    expect(isMultiPipelineGateKeyPattern('release:green')).toBe(false);
    expect(isMultiPipelineGateKeyPattern('')).toBe(false);
  });
});
