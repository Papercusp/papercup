/**
 * knowledge-pack-settings-2026-07-19 — the settings shape, the vetted cadence
 * preset→cron maps, and the stored → env → default knob precedence (D-002).
 * Pure: no PG (resolveKnobsFrom is the exported pure leg).
 */
import { describe, expect, it } from 'vitest';
import { computeNextFireAt } from '../harness/routines/cron';
import {
  DEFAULT_KNOWLEDGE_PACK_KNOBS,
  DELIVERY_CADENCE_CRON,
  HYGIENE_CADENCE_CRON,
  knowledgePackSettingsPatchSchema,
  knowledgePackSettingsSchema,
  resolveKnobsFrom,
} from './config';

describe('knowledge-pack settings schema', () => {
  it('accepts a full valid record', () => {
    const r = knowledgePackSettingsSchema.safeParse({
      deliveryCadence: '6h',
      hygieneCadence: 'weekly',
      adoptionPolicy: 'owner-approval',
      minAgeDays: 14,
      pruneDismissedDays: 30,
      pendingCandidateCap: 50,
      maxReviewsPerTick: 5,
      hygieneMaxHivesPerTick: 2,
      deliveryMaxHivesPerTick: 4,
    });
    expect(r.success).toBe(true);
  });

  it('is strict — an unknown key is rejected, never silently ignored', () => {
    expect(knowledgePackSettingsSchema.safeParse({ cadence: 'daily' }).success).toBe(false);
  });

  it('rejects out-of-range knobs (cap 0, negative age)', () => {
    expect(knowledgePackSettingsSchema.safeParse({ pendingCandidateCap: 0 }).success).toBe(false);
    expect(knowledgePackSettingsSchema.safeParse({ minAgeDays: -1 }).success).toBe(false);
  });

  it('patch schema accepts null (= clear the override) on every field', () => {
    const r = knowledgePackSettingsPatchSchema.safeParse({
      deliveryCadence: null,
      adoptionPolicy: null,
      minAgeDays: null,
    });
    expect(r.success).toBe(true);
  });
});

describe('cadence preset → cron maps (D-003)', () => {
  it('every delivery + hygiene preset cron parses to a real next fire', () => {
    for (const cron of [...Object.values(DELIVERY_CADENCE_CRON), ...Object.values(HYGIENE_CADENCE_CRON)]) {
      expect(computeNextFireAt(cron, new Date('2026-07-19T12:00:00Z'))).not.toBeNull();
    }
  });

  it('the default presets reproduce the seeded crons exactly (seed-improvement-routines parity)', () => {
    expect(DELIVERY_CADENCE_CRON['6h']).toBe('0 30 */6 * * *');
    expect(HYGIENE_CADENCE_CRON.daily).toBe('0 0 5 * * *');
  });
});

describe('knob precedence: stored → env → default (D-002)', () => {
  it('defaults when nothing is stored and env is empty', () => {
    expect(resolveKnobsFrom({}, {})).toEqual(DEFAULT_KNOWLEDGE_PACK_KNOBS);
  });

  it('env beats default (the pre-settings env names keep working)', () => {
    const k = resolveKnobsFrom({}, {
      PAPERCUSP_KNOWLEDGE_HYGIENE_MIN_AGE_DAYS: '7',
      PAPERCUSP_KNOWLEDGE_DELIVERY_MAX_HIVES: '25',
      PAPERCUSP_LEARNING_CANDIDATE_CAP: '99',
    });
    expect(k.minAgeDays).toBe(7);
    expect(k.deliveryMaxHivesPerTick).toBe(25);
    expect(k.pendingCandidateCap).toBe(99);
    expect(k.pruneDismissedDays).toBe(90); // untouched → default
  });

  it('stored beats env beats default', () => {
    const k = resolveKnobsFrom(
      { minAgeDays: 3, adoptionPolicy: 'owner-approval' },
      { PAPERCUSP_KNOWLEDGE_HYGIENE_MIN_AGE_DAYS: '7' },
    );
    expect(k.minAgeDays).toBe(3);
    expect(k.adoptionPolicy).toBe('owner-approval');
  });

  it('garbage env falls back to the default; mins are clamped', () => {
    const k = resolveKnobsFrom({}, { PAPERCUSP_KNOWLEDGE_HYGIENE_PRUNE_DAYS: 'soon' });
    expect(k.pruneDismissedDays).toBe(90);
    expect(resolveKnobsFrom({ pruneDismissedDays: 1 }, {}).pruneDismissedDays).toBe(1);
  });

  it('adoptionPolicy defaults to auto (the shipped WI-5414 behavior)', () => {
    expect(resolveKnobsFrom({}, {}).adoptionPolicy).toBe('auto');
  });
});
