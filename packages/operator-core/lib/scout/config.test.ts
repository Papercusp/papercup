/**
 * config.test.ts — P-009 scout-config seam (domain-generic-hive-architecture-2026-06-18).
 * Pins: (1) the defaults can't drift from the engine constants, (2) resolution is a
 * per-field merge that never silences the ideators, (3) the raw-block parser is fully
 * defensive (a typo'd blueprint block degrades to defaults, never throws).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SCOUT_CONFIG,
  DEFAULT_SCOUT_FRAMING,
  resolveScoutConfig,
  parseScoutConfigBlock,
} from './config';
import { CREATIVE_LENSES } from './types';
import { DEFAULT_BUCKET_OPTIONS, DEFAULT_CORPUS_NOVELTY_OPTIONS } from './critique-core';
import { DEFAULT_ROUTING_RAIL, WHOLE_SYSTEM_MARKERS } from './router';
import { DEFAULT_IDEATOR_MISSION } from './lenses';
import { DEFAULT_CRITIC_MISSION } from './critics';

describe('DEFAULT_SCOUT_CONFIG — anti-drift binding to the engine constants', () => {
  it('is built FROM the engine defaults (byte-identical, no copy that can drift)', () => {
    expect(DEFAULT_SCOUT_CONFIG.lenses).toBe(CREATIVE_LENSES);
    expect(DEFAULT_SCOUT_CONFIG.novelty).toBe(DEFAULT_CORPUS_NOVELTY_OPTIONS);
    expect(DEFAULT_SCOUT_CONFIG.buckets).toBe(DEFAULT_BUCKET_OPTIONS);
    expect(DEFAULT_SCOUT_CONFIG.routing.defaultRail).toBe(DEFAULT_ROUTING_RAIL);
    expect(DEFAULT_SCOUT_CONFIG.routing.wholeSystemMarkers).toBe(WHOLE_SYSTEM_MARKERS);
    // P-010 framing: bound to the prompt builders' exported missions (no copy that can drift).
    expect(DEFAULT_SCOUT_CONFIG.framing).toBe(DEFAULT_SCOUT_FRAMING);
    expect(DEFAULT_SCOUT_FRAMING.ideatorMission).toBe(DEFAULT_IDEATOR_MISSION);
    expect(DEFAULT_SCOUT_FRAMING.criticMission).toBe(DEFAULT_CRITIC_MISSION);
  });

  it('carries the documented default values', () => {
    expect(DEFAULT_SCOUT_CONFIG.buckets.noveltyFloor).toBe(0.34);
    expect(DEFAULT_SCOUT_CONFIG.buckets.feasibilityFloor).toBe(0.5);
    expect(DEFAULT_SCOUT_CONFIG.buckets.moonshotNoveltyFloor).toBe(0.66);
    expect(DEFAULT_SCOUT_CONFIG.buckets.maxMoonshots).toBe(2);
    expect(DEFAULT_SCOUT_CONFIG.novelty.matchFloor).toBe(0.5);
    expect(DEFAULT_SCOUT_CONFIG.novelty.decidedPenalty).toBe(0.15);
    expect(DEFAULT_SCOUT_CONFIG.routing.defaultRail).toBe('improvement');
  });
});

describe('resolveScoutConfig', () => {
  it('returns the defaults for null/undefined/empty override', () => {
    expect(resolveScoutConfig()).toEqual(DEFAULT_SCOUT_CONFIG);
    expect(resolveScoutConfig(null)).toEqual(DEFAULT_SCOUT_CONFIG);
    expect(resolveScoutConfig({})).toEqual(DEFAULT_SCOUT_CONFIG);
  });

  it('merges per-field — tune one bucket threshold, the rest stay default', () => {
    const cfg = resolveScoutConfig({ buckets: { moonshotNoveltyFloor: 0.8 } });
    expect(cfg.buckets.moonshotNoveltyFloor).toBe(0.8);
    expect(cfg.buckets.noveltyFloor).toBe(DEFAULT_BUCKET_OPTIONS.noveltyFloor);
    expect(cfg.buckets.maxMoonshots).toBe(DEFAULT_BUCKET_OPTIONS.maxMoonshots);
    expect(cfg.lenses).toEqual(CREATIVE_LENSES);
  });

  it('overrides lenses + routing markers', () => {
    const cfg = resolveScoutConfig({
      lenses: ['analogical', 'reframing'],
      routing: { wholeSystemMarkers: ['deliverable'] },
    });
    expect(cfg.lenses).toEqual(['analogical', 'reframing']);
    expect(cfg.routing.wholeSystemMarkers).toEqual(['deliverable']);
    // defaultRail untouched
    expect(cfg.routing.defaultRail).toBe(DEFAULT_ROUTING_RAIL);
  });

  it('ignores an empty lenses array (D-004 floor — never silence the ideators)', () => {
    expect(resolveScoutConfig({ lenses: [] }).lenses).toEqual(CREATIVE_LENSES);
  });

  it('an undefined nested value does not clobber the default', () => {
    const cfg = resolveScoutConfig({ buckets: { maxMoonshots: undefined } });
    expect(cfg.buckets.maxMoonshots).toBe(DEFAULT_BUCKET_OPTIONS.maxMoonshots);
  });

  it('does not mutate DEFAULT_SCOUT_CONFIG', () => {
    const before = JSON.parse(JSON.stringify(DEFAULT_SCOUT_CONFIG));
    resolveScoutConfig({ buckets: { noveltyFloor: 0.1 }, routing: { defaultRail: 'plan' } });
    expect(JSON.parse(JSON.stringify(DEFAULT_SCOUT_CONFIG))).toEqual(before);
  });
});

describe('parseScoutConfigBlock — defensive', () => {
  it('returns {} for non-object / garbage input', () => {
    expect(parseScoutConfigBlock(undefined)).toEqual({});
    expect(parseScoutConfigBlock(null)).toEqual({});
    expect(parseScoutConfigBlock('nope')).toEqual({});
    expect(parseScoutConfigBlock([1, 2])).toEqual({});
    expect(parseScoutConfigBlock(42)).toEqual({});
  });

  it('parses a valid full block', () => {
    const override = parseScoutConfigBlock({
      lenses: ['analogical', 'first-principles'],
      novelty: { matchFloor: 0.6, decidedPenalty: 0.2, decidedStates: ['dropped'] },
      buckets: { noveltyFloor: 0.4, maxMoonshots: 3 },
      routing: { defaultRail: 'plan', wholeSystemMarkers: ['Genome', 'WAKE'] },
    });
    expect(override.lenses).toEqual(['analogical', 'first-principles']);
    expect(override.novelty).toEqual({ matchFloor: 0.6, decidedPenalty: 0.2, decidedStates: ['dropped'] });
    expect(override.buckets).toEqual({ noveltyFloor: 0.4, maxMoonshots: 3 });
    expect(override.routing?.defaultRail).toBe('plan');
    // markers are lowercased for the case-insensitive isWholeSystemProposal match
    expect(override.routing?.wholeSystemMarkers).toEqual(['genome', 'wake']);
  });

  it('drops unknown lenses and invalid rails', () => {
    const override = parseScoutConfigBlock({
      lenses: ['analogical', 'bogus-lens'],
      routing: { defaultRail: 'nonsense' },
    });
    expect(override.lenses).toEqual(['analogical']);
    expect(override.routing).toBeUndefined();
  });

  it('drops non-numeric thresholds', () => {
    const override = parseScoutConfigBlock({
      buckets: { noveltyFloor: 'high', maxMoonshots: 3, feasibilityFloor: NaN },
    });
    expect(override.buckets).toEqual({ maxMoonshots: 3 });
  });

  it('round-trips parse → resolve to a usable config', () => {
    const cfg = resolveScoutConfig(parseScoutConfigBlock({ buckets: { maxMoonshots: 5 } }));
    expect(cfg.buckets.maxMoonshots).toBe(5);
    expect(cfg.buckets.noveltyFloor).toBe(DEFAULT_BUCKET_OPTIONS.noveltyFloor);
    expect(cfg.lenses).toEqual(CREATIVE_LENSES);
  });
});

describe('scout framing (P-010 prompt-overlay seam)', () => {
  const WORK_FRAMING = {
    ideatorMission: 'You are a SCOUT for a WORK hive that ships deliverables — leap, do not iterate.',
    criticMission: 'You are TWO critics judging an idea proposed for a WORK hive. Pull against each other:',
  };

  it('resolve: a framing override replaces the missions, defaults untouched elsewhere', () => {
    const cfg = resolveScoutConfig({ framing: WORK_FRAMING });
    expect(cfg.framing).toEqual(WORK_FRAMING);
    // the structured config (P-009) is untouched by a framing-only override
    expect(cfg.lenses).toEqual(CREATIVE_LENSES);
    expect(cfg.buckets).toEqual(DEFAULT_BUCKET_OPTIONS);
  });

  it('resolve: a partial framing override keeps the other mission at default', () => {
    const cfg = resolveScoutConfig({ framing: { ideatorMission: WORK_FRAMING.ideatorMission } });
    expect(cfg.framing.ideatorMission).toBe(WORK_FRAMING.ideatorMission);
    expect(cfg.framing.criticMission).toBe(DEFAULT_CRITIC_MISSION);
  });

  it('resolve: a blank/whitespace mission falls back to the default (never silence the framing)', () => {
    const cfg = resolveScoutConfig({ framing: { ideatorMission: '   ', criticMission: '' } });
    expect(cfg.framing.ideatorMission).toBe(DEFAULT_IDEATOR_MISSION);
    expect(cfg.framing.criticMission).toBe(DEFAULT_CRITIC_MISSION);
  });

  it('resolve: an empty override keeps the default framing', () => {
    expect(resolveScoutConfig({}).framing).toEqual(DEFAULT_SCOUT_FRAMING);
    // the no-arg path short-circuits to the shared default (same reference)
    expect(resolveScoutConfig().framing).toBe(DEFAULT_SCOUT_FRAMING);
  });

  it('parse: a valid framing block is parsed', () => {
    const override = parseScoutConfigBlock({ framing: WORK_FRAMING });
    expect(override.framing).toEqual(WORK_FRAMING);
  });

  it('parse: blank / non-string missions are dropped', () => {
    expect(parseScoutConfigBlock({ framing: { ideatorMission: '  ', criticMission: 42 } }).framing).toBeUndefined();
    const onlyIdeator = parseScoutConfigBlock({ framing: { ideatorMission: WORK_FRAMING.ideatorMission, criticMission: '' } });
    expect(onlyIdeator.framing).toEqual({ ideatorMission: WORK_FRAMING.ideatorMission });
  });

  it('parse: a non-object framing block is ignored', () => {
    expect(parseScoutConfigBlock({ framing: 'nope' }).framing).toBeUndefined();
    expect(parseScoutConfigBlock({ framing: ['a'] }).framing).toBeUndefined();
  });

  it('round-trips parse → resolve to the work framing', () => {
    const cfg = resolveScoutConfig(parseScoutConfigBlock({ framing: WORK_FRAMING }));
    expect(cfg.framing).toEqual(WORK_FRAMING);
  });
});
