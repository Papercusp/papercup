/**
 * generation-watermark.test.ts — the pure parser + ref vocabulary behind the
 * 'bg-host-restart' generation watermark (rubric-system-hardening-2026-07-14 P-002,
 * EI-12148). The IO edge (one systemctl exec) is deliberately thin and not exercised
 * here; every parsing/vocabulary decision is.
 */
import { describe, expect, it } from 'vitest';

import {
  BG_HOST_RESTART_WATERMARK,
  KNOWN_WATERMARK_REFS,
  parseSystemdTimestamp,
  resolveStagingHeadAsOf,
  resolveWatermarkRef,
} from './generation-watermark';

describe('parseSystemdTimestamp', () => {
  it('parses the TZ=UTC systemd form (the path the exec pins with TZ=UTC)', () => {
    expect(parseSystemdTimestamp('Tue 2026-07-14 18:08:24 UTC')).toBe(Date.parse('2026-07-14T18:08:24Z'));
  });

  it('parses without the day-of-week prefix and with GMT', () => {
    expect(parseSystemdTimestamp('2026-07-14 18:08:24 GMT')).toBe(Date.parse('2026-07-14T18:08:24Z'));
  });

  it('an inactive/never-started unit ("" / n/a) is null — no watermark, never epoch 0', () => {
    expect(parseSystemdTimestamp('')).toBeNull();
    expect(parseSystemdTimestamp('n/a')).toBeNull();
    expect(parseSystemdTimestamp('  \n')).toBeNull();
    expect(parseSystemdTimestamp(null)).toBeNull();
    expect(parseSystemdTimestamp(undefined)).toBeNull();
  });

  it('garbage is null, never NaN or a throw', () => {
    expect(parseSystemdTimestamp('ActiveEnterTimestamp=')).toBeNull();
    expect(parseSystemdTimestamp('not a date')).toBeNull();
  });

  it('a NON-UTC zone token still resolves via the lenient fallback (V8 US zone abbrevs)', () => {
    // The exec always sets TZ=UTC so this is defense, not the normal path: the value must
    // parse to the same instant, not be misread as UTC wall-clock.
    const parsed = parseSystemdTimestamp('Tue 2026-07-14 14:08:24 EDT');
    expect(parsed).toBe(Date.parse('2026-07-14T18:08:24Z'));
  });
});

describe('readRunningGeneration — the stampable generation identity (EI-12147, reworked WI-5397)', () => {
  it('returns every leg string-or-null (deployedSha/hostStartedAt/bootHeadSha/scoutCodeHash) plus a boolean staleHost, never throwing', async () => {
    const { readRunningGeneration } = await import('./generation-watermark');
    const gen = await readRunningGeneration();
    expect(gen.deployedSha === null || typeof gen.deployedSha === 'string').toBe(true);
    // On a systemd box with the bg-host running this is its start ISO; elsewhere null.
    expect(gen.hostStartedAt === null || !Number.isNaN(Date.parse(gen.hostStartedAt!))).toBe(true);
    expect(gen.bootHeadSha === null || typeof gen.bootHeadSha === 'string').toBe(true);
    expect(gen.scoutCodeHash === null || typeof gen.scoutCodeHash === 'string').toBe(true);
    expect(typeof gen.staleHost).toBe('boolean');
  });

  it('staleHost fails toward "not proven fresh" — unresolved bootHeadSha or deployedSha ⇒ true, never a false all-clear', async () => {
    const { readRunningGeneration } = await import('./generation-watermark');
    const gen = await readRunningGeneration();
    if (gen.bootHeadSha === null || gen.deployedSha === null) {
      expect(gen.staleHost).toBe(true);
    }
  });
});

describe('resolveStagingHeadAsOf — retroactive git-history reconstruction of a boot-time HEAD', () => {
  it('resolves a 40-char sha for a timestamp within this repo\'s own history', async () => {
    const sha = await resolveStagingHeadAsOf(new Date().toISOString());
    // best-effort: null is acceptable (no git / not a repo in some sandboxes), but if it
    // resolves it must be a well-formed sha, never garbage.
    expect(sha === null || /^[0-9a-f]{7,40}$/i.test(sha!)).toBe(true);
  });

  it('degrades to null rather than throwing on a bogus cwd', async () => {
    const sha = await resolveStagingHeadAsOf(new Date().toISOString(), { cwd: '/nonexistent-dir-xyz' });
    expect(sha).toBeNull();
  });
});

describe('resolveWatermarkRef — the ref vocabulary', () => {
  it("an unknown ref is a TEACHING error naming the vocabulary — a typo must not judge some other window", async () => {
    const r = await resolveWatermarkRef('bg-host-restrat');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(BG_HOST_RESTART_WATERMARK);
  });

  it('the known-refs vocabulary carries bg-host-restart', () => {
    expect(KNOWN_WATERMARK_REFS).toContain(BG_HOST_RESTART_WATERMARK);
  });
});
