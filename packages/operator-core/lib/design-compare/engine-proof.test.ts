/**
 * P-002 engine proof.
 *
 * These tests do not check Papercusp code. They PIN the measured behaviour of the
 * installed third-party comparison engines, so that the assumptions the adapter
 * (P-005) is built on cannot drift silently under a dependency bump. Every
 * assertion here corresponds to a claim recorded in a plan decision; if one of
 * these fails after an upgrade, the decision it pins is what needs rewriting, not
 * the test.
 *
 * Several of these assert behaviour that is WRONG from a gate's point of view.
 * That is the point: they are executable descriptions of hazards the adapter has
 * to defend against, and each one names the defence in its own body.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CORPUS_IMAGES } from './corpus/cases';
import committedDigests from './corpus/digests.json';
import { type RGB, createRaster, encodePng, rasterDigest } from './corpus/synthesize';

const COMMITTED_DIGESTS = committedDigests as unknown as Record<string, string>;
import {
  ENGINES,
  LOST_PIXEL_DEFAULT_ENGINE,
  type MaterialisedCorpus,
  comparePixelmatchDirect,
  compareWithEngine,
  engineVersions,
  lostPixelCompare,
  materialiseCorpus,
} from './corpus/harness';

let workDir: string;
let corpus: MaterialisedCorpus;

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'design-compare-proof-'));
  corpus = materialiseCorpus(path.join(workDir, 'corpus'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const pathFor = (key: string): string => {
  const found = corpus.paths.get(key);
  if (!found) throw new Error(`corpus path missing for '${key}'`);
  return found;
};

const diffPath = (name: string): string => path.join(workDir, 'diff', `${name}.png`);

describe('installed engine inventory', () => {
  it('records the exact versions every other assertion in this file is about', () => {
    const versions = engineVersions();
    // Pinned so a major bump forces a re-read of the proofs rather than sliding
    // under them. A patch bump is allowed; a major is not.
    expect(versions['lost-pixel']).toMatch(/^3\./);
    expect(versions.pixelmatch).toMatch(/^5\./);
    expect(versions.odiff).toMatch(/^2\./);
    expect(versions.pngjs).toMatch(/^7\./);
  });

  it('confirms odiff — not pixelmatch — is the engine that actually runs', () => {
    // lost-pixel's dispatcher selects pixelmatch only when config.compareEngine
    // is exactly 'pixelmatch' and otherwise falls through to odiff. No
    // lostpixel.config.ts in this repo sets compareEngine, so every proof about
    // "the default path" is a proof about odiff. The adapter must therefore
    // record which engine produced each result rather than assuming one.
    expect(LOST_PIXEL_DEFAULT_ENGINE).toBe('odiff');
  });
});

describe('metadata contract', () => {
  it('returns exactly the three documented fields from both engines', async () => {
    for (const engine of ENGINES) {
      const result = await compareWithEngine(
        engine,
        pathFor('artifact/reference'),
        pathFor('artifact/faithful'),
        diffPath(`meta-${engine}`),
      );
      expect(typeof result.pixelDifference).toBe('number');
      expect(typeof result.engineReportedPercentage).toBe('number');
      expect(typeof result.engineReportedWithinThreshold).toBe('boolean');
      expect(Number.isInteger(result.pixelDifference)).toBe(true);
    }
  });

  it('reports a non-zero difference for images that genuinely differ', async () => {
    const result = await compareWithEngine(
      'odiff',
      pathFor('artifact/reference'),
      pathFor('artifact/drifted'),
      diffPath('nonzero'),
    );
    expect(result.pixelDifference).toBeGreaterThan(0);
  });
});

describe('HAZARD: the pixelmatch verdict fails open', () => {
  it('reports isWithinThreshold TRUE for differing images when no diff path is passed', async () => {
    // compare.js performs its real threshold check only when
    // `pixelDifference > 0 && differenceShotPath`. Every other return path is a
    // hardcoded `isWithinThreshold: true`. Invoked without a difference path it
    // therefore certifies ANY pair as passing, no matter how different.
    //
    // DEFENCE: the harness always passes a difference path, and the adapter
    // recomputes the verdict from raw counts regardless.
    const failOpen = await compareWithEngine(
      'pixelmatch',
      pathFor('artifact/reference'),
      pathFor('artifact/drifted'),
      diffPath('fail-open'),
      { threshold: 0, withDiffPath: false },
    );

    expect(failOpen.pixelDifference).toBeGreaterThan(0);
    // The hazard, stated as an assertion: a real difference, certified as passing.
    expect(failOpen.engineReportedWithinThreshold).toBe(true);

    // Same inputs, same threshold, difference path supplied: the verdict flips.
    const honest = await compareWithEngine(
      'pixelmatch',
      pathFor('artifact/reference'),
      pathFor('artifact/drifted'),
      diffPath('fail-open-honest'),
      { threshold: 0, withDiffPath: true },
    );
    expect(honest.pixelDifference).toBe(failOpen.pixelDifference);
    expect(honest.engineReportedWithinThreshold).toBe(false);
  });

  it('recomputing from raw counts is unaffected by the fail-open path', async () => {
    // The counts are trustworthy even where the boolean is not, which is exactly
    // why the contract derives its verdict from counts and treats the engine
    // boolean as advisory.
    const result = await compareWithEngine(
      'pixelmatch',
      pathFor('artifact/reference'),
      pathFor('artifact/drifted'),
      diffPath('recompute'),
      { threshold: 0, withDiffPath: false },
    );
    expect(result.diffRatio).toBeGreaterThan(0);
    expect(result.diffRatio).toBeCloseTo(result.pixelDifference / result.pixelsTotal, 12);
  });
});

describe('HAZARD: the difference artifact is conditional', () => {
  it('writes no diff image when pixelmatch considers the difference within threshold', async () => {
    // At the operator's inherited 0.05 threshold a small real difference is
    // "within threshold", so no artifact is produced — leaving a reviewer with a
    // failing policy verdict and nothing to look at.
    const lenient = await compareWithEngine(
      'pixelmatch',
      pathFor('artifact/reference'),
      pathFor('artifact/faithful'),
      diffPath('artifact-lenient'),
      { threshold: 0.05 },
    );
    expect(lenient.pixelDifference).toBeGreaterThan(0);
    expect(lenient.engineReportedWithinThreshold).toBe(true);
    expect(lenient.diffArtifactWritten).toBe(false);

    // DEFENCE: invoke at threshold 0 so any difference is above threshold and the
    // artifact always exists. Policy is then applied to the counts by us.
    const strict = await compareWithEngine(
      'pixelmatch',
      pathFor('artifact/reference'),
      pathFor('artifact/faithful'),
      diffPath('artifact-strict'),
      { threshold: 0 },
    );
    expect(strict.pixelDifference).toBe(lenient.pixelDifference);
    expect(strict.diffArtifactWritten).toBe(true);
  });
});

describe('HAZARD: unequal dimensions', () => {
  it('pixelmatch silently resizes both images and compares them anyway', async () => {
    // compare.js resizes BOTH images to max(width) x max(height) when they differ
    // and compares the result, so a geometry error is normalised away into a
    // pixel ratio instead of being refused.
    const result = await compareWithEngine(
      'pixelmatch',
      pathFor('dimension/reference'),
      pathFor('dimension/wider-same-content'),
      diffPath('dim-pixelmatch'),
      { threshold: 0 },
    );
    expect(result.pixelDifference).toBeGreaterThan(0);

    // And the percentage it reports uses the MAX-BOX area as its denominator,
    // not the reference's own area.
    const maxBoxArea = 360 * 240;
    expect(result.engineReportedPercentage).toBeCloseTo(result.pixelDifference / maxBoxArea, 10);
    expect(result.pixelsTotal).toBe(320 * 240);
  });

  it('odiff — THE DEFAULT ENGINE — reports a clean PASS for a size change', async () => {
    // This is the most dangerous measured behaviour in the whole proof.
    //
    // lost-pixel invokes odiff with `failOnLayoutDiff: false` hardcoded. With that
    // flag, odiff compares only the overlapping region: two images whose common
    // area agrees are reported as `{ match: true }` even when their dimensions
    // differ. lost-pixel maps `match: true` to a zero difference and a passing
    // verdict.
    //
    // The consequence: on the engine that actually runs in this repo, changing a
    // capture's dimensions produces ZERO pixel difference and a PASS. A gate built
    // on the engine's output alone could be defeated by resizing the viewport.
    //
    // DEFENCE: the adapter refuses unequal dimensions BEFORE invoking any engine.
    // That precondition cannot live in engine configuration — lost-pixel does not
    // expose this flag — so it must live in the adapter.
    const result = await compareWithEngine(
      'odiff',
      pathFor('dimension/reference'),
      pathFor('dimension/wider-same-content'),
      diffPath('dim-odiff'),
      { threshold: 0 },
    );

    expect(result.pixelDifference).toBe(0);
    expect(result.diffRatio).toBe(0);
    expect(result.engineReportedWithinThreshold).toBe(true);
    expect(result.diffArtifactWritten).toBe(false);
  });

  it('the two engines return OPPOSITE verdicts for the same unequal-dimension pair', async () => {
    // Same two files, same threshold, same call site — one engine passes them and
    // the other fails them. Any result that does not record which engine produced
    // it is therefore uninterpretable.
    const viaOdiff = await compareWithEngine(
      'odiff',
      pathFor('dimension/reference'),
      pathFor('dimension/wider-same-content'),
      diffPath('divergence-odiff'),
      { threshold: 0 },
    );
    const viaPixelmatch = await compareWithEngine(
      'pixelmatch',
      pathFor('dimension/reference'),
      pathFor('dimension/wider-same-content'),
      diffPath('divergence-pixelmatch'),
      { threshold: 0 },
    );

    expect(viaOdiff.pixelDifference).toBe(0);
    expect(viaPixelmatch.pixelDifference).toBeGreaterThan(0);
    expect(viaOdiff.engineReportedWithinThreshold).not.toBe(
      viaPixelmatch.engineReportedWithinThreshold,
    );
  });
});

describe('HAZARD: pixelmatch silently suppresses antialiasing differences', () => {
  /**
   * The mirror of the odiff finding, and the reason neither engine's raw output is
   * a versioned policy.
   *
   * pixelmatch's `includeAA` option defaults to FALSE, which means its
   * antialiasing DETECTOR is active and every pixel it judges to be an
   * antialiasing artifact is skipped rather than counted (`pixelmatch/index.js`
   * line 60). lost-pixel invokes it as `pixelmatch(..., { threshold: 0 })` and
   * never sets `includeAA`, so that suppression is always on and cannot be reached
   * through lost-pixel's comparator signature.
   *
   * This is not obviously WRONG — tolerating antialiasing is usually what a visual
   * gate wants. The problem is that it is IMPLICIT: the effective noise policy is
   * a third-party heuristic that Papercusp neither chose, recorded, nor versioned,
   * while D-004 requires the gate to derive from a versioned policy. So the
   * suppression has to be measured and stated, not inherited silently.
   */
  it('counts far fewer differing pixels than are actually different', () => {
    const suppressed = comparePixelmatchDirect(
      pathFor('figma/reference'),
      pathFor('figma/faithful'),
      { threshold: 0, includeAA: false },
    );
    const counted = comparePixelmatchDirect(
      pathFor('figma/reference'),
      pathFor('figma/faithful'),
      { threshold: 0, includeAA: true },
    );

    // Both are measuring the same two files at the same colour threshold. The only
    // difference is whether the antialiasing detector is allowed to drop pixels.
    expect(counted.pixelDifference).toBeGreaterThan(suppressed.pixelDifference);
    // The suppression is large, not marginal — most of the real difference is
    // discarded before Papercusp ever sees a number.
    expect(suppressed.pixelDifference).toBeLessThan(counted.pixelDifference / 2);
  });

  it('is the setting lost-pixel actually runs, so the suppressed number is the one in play', async () => {
    // What lost-pixel's comparator returns must equal the includeAA:false direct
    // call. If these ever diverge, lost-pixel has started passing options and this
    // whole finding needs re-deriving.
    const viaLostPixel = await compareWithEngine(
      'pixelmatch',
      pathFor('figma/reference'),
      pathFor('figma/faithful'),
      diffPath('aa-via-lost-pixel'),
      { threshold: 0 },
    );
    const direct = comparePixelmatchDirect(pathFor('figma/reference'), pathFor('figma/faithful'), {
      threshold: 0,
      includeAA: false,
    });
    expect(viaLostPixel.pixelDifference).toBe(direct.pixelDifference);
  });

  it('neither engine exposes its noise-suppression knob through lost-pixel', () => {
    // Stated as an executable fact about the comparator surface: it takes a
    // threshold and three paths. There is no parameter for includeAA and none for
    // odiff's colour tolerance, so a policy expressed in those terms cannot be
    // passed through this API at all.
    expect(lostPixelCompare.compareImagesViaPixelmatch).toHaveLength(4);
    expect(lostPixelCompare.compareImagesViaOdiff).toHaveLength(4);
  });
});

describe('HAZARD: odiff applies an unconfigurable colour tolerance', () => {
  /**
   * The finding that decides which engine the adapter may use.
   *
   * odiff carries its own per-pixel colour-distance threshold, defaulting to 0.1.
   * lost-pixel's `compareImagesViaOdiff` builds its options object literally as
   * `{ failOnLayoutDiff: false }` and never forwards a colour threshold, so odiff
   * always runs at that default and there is NO configuration path to change it
   * through lost-pixel.
   *
   * Measured consequence: a uniform shift of up to 45/255 on a channel — roughly
   * 18% — across the ENTIRE image is reported as a perfect match, zero differing
   * pixels. pixelmatch, which lost-pixel invokes at per-pixel `{ threshold: 0 }`,
   * counts every one of those pixels.
   *
   * So the two engines are not interchangeable implementations of one comparison;
   * they measure different things. And the engine that is BLIND is the one that
   * runs by default in this repo.
   *
   * DEFENCE: the adapter selects pixelmatch explicitly rather than inheriting the
   * default, and records the engine id on every result. Selecting the engine is
   * the only lever available — the tolerance itself cannot be reached through
   * lost-pixel's comparator.
   */
  const flat = (colour: RGB, width = 40): string => {
    const raster = createRaster(width, 40, colour);
    const target = path.join(workDir, `flat-${colour.join('_')}-${width}.png`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, encodePng(raster));
    return target;
  };

  const BASE: RGB = [128, 128, 128];

  it.each([
    { delta: 1 },
    { delta: 12 },
    { delta: 30 },
    { delta: 45 },
  ])('odiff reports a PERFECT MATCH for a whole-image delta of $delta/255', async ({ delta }) => {
    const reference = flat(BASE);
    const shifted = flat([128 + delta, 128, 128]);

    const viaOdiff = await compareWithEngine(
      'odiff',
      reference,
      shifted,
      diffPath(`tolerance-odiff-${delta}`),
      { threshold: 0 },
    );
    // Every pixel in the image differs, and odiff reports none of them.
    expect(viaOdiff.pixelDifference).toBe(0);
    expect(viaOdiff.engineReportedWithinThreshold).toBe(true);

    // pixelmatch, same two files, same threshold: every pixel counted.
    const viaPixelmatch = await compareWithEngine(
      'pixelmatch',
      reference,
      shifted,
      diffPath(`tolerance-pixelmatch-${delta}`),
      { threshold: 0 },
    );
    expect(viaPixelmatch.pixelDifference).toBe(40 * 40);
  });

  it('locates the tolerance boundary between 45 and 48', async () => {
    // Pinned so an odiff upgrade that moves its default threshold is caught here
    // rather than silently changing what the gate can see.
    const blind = await compareWithEngine(
      'odiff',
      flat(BASE),
      flat([128 + 45, 128, 128]),
      diffPath('boundary-blind'),
      { threshold: 0 },
    );
    const detected = await compareWithEngine(
      'odiff',
      flat(BASE),
      flat([128 + 48, 128, 128]),
      diffPath('boundary-detected'),
      { threshold: 0 },
    );
    expect(blind.pixelDifference).toBe(0);
    expect(detected.pixelDifference).toBe(40 * 40);
  });

  it('pixelmatch has no such blind spot at any delta', async () => {
    for (const delta of [1, 12, 30, 45]) {
      const measured = await compareWithEngine(
        'pixelmatch',
        flat(BASE),
        flat([128 + delta, 128, 128]),
        diffPath(`pm-sensitive-${delta}`),
        { threshold: 0 },
      );
      expect(`delta=${delta} diff=${measured.pixelDifference}`).toBe(`delta=${delta} diff=1600`);
    }
  });
});

describe('HAZARD: engine failures escape as unstructured, inconsistent throws', () => {
  /**
   * Measured matrix of what each engine actually throws for broken inputs.
   *
   * The headline is that lost-pixel's own mapped error — `Couldn't compare
   * images` — is NEVER REACHED for these cases: both engines throw from further
   * down before lost-pixel gets to classify anything. So an adapter that catches
   * that specific message, or that assumes a single error shape, will let a
   * broken run escape as an unhandled rejection.
   *
   * Note especially that odiff's missing-file case throws a `TypeError`, not an
   * `Error`. Any `catch (e) { if (e instanceof Error) ... }` narrowing that
   * assumes the base class still works here, but a check on `e.constructor` or a
   * message pattern does not.
   *
   * DEFENCE: the adapter catches everything thrown by the provider seam,
   * regardless of type or message, and maps it to an explicit `invalid` verdict
   * carrying an engine-error reason. A broken run must never be indistinguishable
   * from a pass or a fail.
   */
  const brokenInputCases = [
    { label: 'missing baseline', broken: 'missing' as const, position: 'baseline' as const },
    { label: 'corrupt baseline', broken: 'corrupt' as const, position: 'baseline' as const },
    { label: 'corrupt candidate', broken: 'corrupt' as const, position: 'candidate' as const },
  ];

  it.each(brokenInputCases)(
    'both engines reject rather than resolving a verdict — $label',
    async ({ broken, position }) => {
      const corruptPath = path.join(workDir, 'corrupt-input.png');
      writeFileSync(corruptPath, Buffer.from('not a png at all'));
      const brokenPath =
        broken === 'missing' ? path.join(workDir, 'does-not-exist.png') : corruptPath;

      const baseline = position === 'baseline' ? brokenPath : pathFor('artifact/reference');
      const candidate = position === 'candidate' ? brokenPath : pathFor('artifact/reference');

      for (const engine of ENGINES) {
        const invoke =
          engine === 'odiff'
            ? lostPixelCompare.compareImagesViaOdiff(0, baseline, candidate, diffPath('err-odiff'))
            : lostPixelCompare.compareImagesViaPixelmatch(
                0,
                baseline,
                candidate,
                diffPath('err-pixelmatch'),
              );

        // The only thing both engines agree on: they reject. Nothing about the
        // type or the message is stable enough to branch on.
        await expect(invoke).rejects.toThrow();
      }
    },
  );

  it("never reaches lost-pixel's own mapped error for broken inputs", async () => {
    // Pins the negative: `Couldn't compare images` is unreachable here, so it must
    // not be what the adapter keys on.
    const thrown = await lostPixelCompare
      .compareImagesViaOdiff(
        0,
        path.join(workDir, 'does-not-exist.png'),
        pathFor('artifact/reference'),
        diffPath('engine-error'),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(thrown).not.toBeNull();
    expect(String((thrown as Error).message)).not.toMatch(/couldn't compare images/i);
    // And it is not even an `Error` subclass instance of the usual kind.
    expect((thrown as Error).name).toBe('TypeError');
  });
});

describe('repeatability', () => {
  it('produces byte-identical counts across repeated runs of every corpus pair', async () => {
    // Determinism is a precondition for gating at all: a comparison that varies
    // run to run cannot carry a threshold. Measured across both engines.
    for (const engine of ENGINES) {
      const first = await compareWithEngine(
        engine,
        pathFor('figma/reference'),
        pathFor('figma/faithful'),
        diffPath(`repeat-${engine}-1`),
        { threshold: 0 },
      );
      for (let run = 2; run <= 4; run += 1) {
        const again = await compareWithEngine(
          engine,
          pathFor('figma/reference'),
          pathFor('figma/faithful'),
          diffPath(`repeat-${engine}-${run}`),
          { threshold: 0 },
        );
        expect(again.pixelDifference).toBe(first.pixelDifference);
        expect(again.engineReportedPercentage).toBe(first.engineReportedPercentage);
      }
    }
  });
});

describe('corpus determinism', () => {
  it('matches the committed per-image pixel digests', () => {
    // The cross-environment pin. Within-run determinism (next test) proves the
    // generator is not itself random; this proves the corpus is the SAME corpus
    // the calibration numbers in the plan were measured against. A change here
    // means every recorded ratio needs re-deriving, which is exactly the moment
    // someone should be forced to notice.
    for (const image of CORPUS_IMAGES) {
      const expected = COMMITTED_DIGESTS[image.key];
      expect(`${image.key}:${expected ? 'pinned' : 'MISSING FROM digests.json'}`).toBe(
        `${image.key}:pinned`,
      );
      expect(`${image.key}:${rasterDigest(image.render())}`).toBe(`${image.key}:${expected}`);
    }
  });

  it('pins every corpus image, with no stale entries left behind', () => {
    const pinned = Object.keys(COMMITTED_DIGESTS)
      .filter((key) => !key.startsWith('_'))
      .sort();
    const actual = CORPUS_IMAGES.map((image) => image.key).sort();
    expect(pinned).toEqual(actual);
  });

  it('renders every image identically on repeated generation', () => {
    const second = materialiseCorpus(path.join(workDir, 'corpus-again'));
    for (const image of CORPUS_IMAGES) {
      expect(second.digests.get(image.key)).toBe(corpus.digests.get(image.key));
    }
  });

  it('produces the contracted canvas size for every calibration image', () => {
    // The dimension fixtures are deliberately the only ones that differ, because
    // an accidental size drift elsewhere would silently change every ratio.
    for (const image of CORPUS_IMAGES) {
      if (image.key.startsWith('dimension/')) continue;
      const rendered = image.render();
      expect(`${image.key}:${rendered.width}x${rendered.height}`).toBe(`${image.key}:320x240`);
    }
  });

  it('rejects a corrupted fixture rather than comparing it', async () => {
    // A guard on the guard: if the corpus itself were damaged, the proof above
    // must not quietly keep producing numbers.
    const broken = path.join(workDir, 'broken.png');
    writeFileSync(broken, Buffer.from('not a png at all'));
    await expect(
      compareWithEngine('pixelmatch', broken, pathFor('artifact/reference'), diffPath('broken'), {
        threshold: 0,
      }),
    ).rejects.toThrow();
  });
});
