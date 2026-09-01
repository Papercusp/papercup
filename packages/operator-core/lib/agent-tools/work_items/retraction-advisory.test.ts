/**
 * Claim-time retraction advisory coverage (EI-20027532687512023).
 *
 * The advisory is intentionally a bounded, fail-open read: it must surface a
 * real retraction on an open item without turning thread-store trouble into a
 * claim failure, and it must stay silent for terminal items.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ getWorkItemThreadWindow: vi.fn() }));

vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-items')>()),
  getWorkItemThreadWindow: io.getWorkItemThreadWindow,
}));

import { getWorkItemThreadWindow } from '../../work-items';
import {
  getClaimTimeRetractionAdvisory,
  RETRACTION_STATE_HINT,
  RETRACTION_LIKE_RE,
  scanCheckpointRetractions,
} from './retraction-advisory';

const threadM = vi.mocked(getWorkItemThreadWindow);

const thread = (posts: Array<{ body: string }>) =>
  ({
    posts,
    total: posts.length,
    topics: [],
    createdAt: '2026-08-12T00:00:00.000Z',
  }) as never;

beforeEach(() => vi.clearAllMocks());

describe('claim-time retraction advisory (EI-20027532687512023)', () => {
  it('reads the bounded recent thread and surfaces the measured retraction shape', async () => {
    threadM.mockResolvedValue(
      thread([
        { body: "## ⚠⚠ RETRACTION BY THE FILER — this item's central premise is WRONG. Do not act on it as written." },
      ]),
    );

    const advisory = await getClaimTimeRetractionAdvisory(
      { id: 'EI-1', state: 'open', harness: 'papercusp' },
      'papercusp',
    );

    expect(threadM).toHaveBeenCalledWith('EI-1', 10, 'papercusp');
    expect(advisory).toEqual({ retractionWarning: RETRACTION_STATE_HINT });
  });

  it('does not read a terminal item, even when its old thread contains a retraction', async () => {
    const advisory = await getClaimTimeRetractionAdvisory({ id: 'EI-2', state: 'dropped', harness: 'papercusp' });

    expect(advisory).toBeNull();
    expect(threadM).not.toHaveBeenCalled();
  });

  it('stays silent for ordinary thread chatter', async () => {
    threadM.mockResolvedValue(thread([{ body: 'Correction: the timeout is 480s, not 240s. Rest stands.' }]));

    await expect(getClaimTimeRetractionAdvisory({ id: 'EI-3', state: 'open' }, 'papercusp')).resolves.toBeNull();
  });

  it('fails open when the thread read is unavailable', async () => {
    threadM.mockRejectedValue(new Error('thread store unavailable'));

    await expect(getClaimTimeRetractionAdvisory({ id: 'EI-4', state: 'open' }, 'papercusp')).resolves.toBeNull();
  });
});

describe('scanCheckpointRetractions (EI-19454477695046958)', () => {
  // CALIBRATION, and the reason this matcher exists at all. These are the real
  // strings from the filing item: WI-6980's actual retraction plus the four
  // self-labelling markers the item names. The claim-time RETRACTION_LIKE_RE
  // misses EVERY one of them, so a detector that merely reused it would have
  // shipped as a guard that cannot catch the failure it was built for.
  const REAL_CASES: ReadonlyArray<readonly [string, string]> = [
    ['WI-6980 actual', '## ⚠ RETRACTION — the original attribution was wrong; the claim does not hold.'],
    ['marker RETRACT', '### RETRACTED (was stated as fact at 03:56Z; it is FALSE)'],
    ['marker PREMISE CORRECTED', '- ⛔ **PREMISE CORRECTED:** the driver is not per-agent-turn.'],
    ['marker WRONG', '**WRONG and is disproved by the ledger query below.**'],
    ['marker SUPERSEDED', '> SUPERSEDED by the measurement in the next block.'],
  ];

  it.each(REAL_CASES)('detects the %s case that the claim-time matcher misses', (_name, line) => {
    expect(scanCheckpointRetractions(line)?.count).toBe(1);
    // Non-vacuous: assert the OLD matcher really does miss it, so this test fails
    // loudly if someone "simplifies" the two matchers back into one.
    expect(RETRACTION_LIKE_RE.test(line)).toBe(false);
  });

  it('COUNTS independent retractions rather than reporting presence', () => {
    // The measured failure: a reader finds the first retraction, treats it as THE
    // correction, and acts on a claim the second one withdraws. 35 of 159
    // retraction-bearing checkpoints carry two or more.
    const checkpoint = [
      '## Did',
      'Traced the caller and landed the fix.',
      '',
      '## ⚠ CORRECTION — the payload/TOAST theory above is wrong.',
      'It is not row size.',
      '',
      '### RETRACTED — the per-agent-turn attribution is also withdrawn.',
      'Scaling arithmetic fit by coincidence.',
    ].join('\n');

    const scan = scanCheckpointRetractions(checkpoint);
    expect(scan?.count).toBe(2);
    expect(scan?.excerpts).toHaveLength(2);
    expect(scan?.excerpts[1]).toContain('per-agent-turn attribution is also withdrawn');
  });

  it('does NOT fire on prose ABOUT a retraction — the line-start anchor is the precision', () => {
    // This is the discrimination the whole design rests on, and the exact sentence
    // shape from the filing item's own narrative.
    const prose = [
      'I read the checkpoint and quoted its first retraction because it matched mine.',
      'The earlier finding was superseded later, which I missed at the time.',
      'Nothing here is a self-label; it is narrative describing corrections.',
    ].join('\n');

    expect(scanCheckpointRetractions(prose)).toBeNull();
  });

  it('returns null rather than a zero-count object, so a clean read omits the field', () => {
    expect(scanCheckpointRetractions('## Did\nOrdinary progress, nothing withdrawn.')).toBeNull();
    expect(scanCheckpointRetractions('')).toBeNull();
    expect(scanCheckpointRetractions(null)).toBeNull();
    expect(scanCheckpointRetractions(undefined)).toBeNull();
  });

  it('bounds excerpts and reports the remainder so a pathological note cannot dominate', () => {
    const checkpoint = Array.from({ length: 5 }, (_, i) => `## RETRACTED ${i + 1} — withdrawn.`).join('\n');

    const scan = scanCheckpointRetractions(checkpoint);
    expect(scan?.count).toBe(5);
    expect(scan?.excerpts).toHaveLength(3);
    expect(scan?.more).toBe(2);
  });

  it('truncates a long retraction line instead of inlining the whole block', () => {
    const scan = scanCheckpointRetractions(`## RETRACTED — ${'x'.repeat(400)}`);

    expect(scan?.count).toBe(1);
    expect(scan?.excerpts[0].length).toBeLessThanOrEqual(141);
    expect(scan?.excerpts[0].endsWith('…')).toBe(true);
  });
});
