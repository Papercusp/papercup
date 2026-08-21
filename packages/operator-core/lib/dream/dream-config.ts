import { DEFAULT_SCOUT_CRITIC_MODEL } from '../scout/models';

export const DREAM_FRAGMENT_KINDS = ['observation', 'work_item', 'memory', 'stat'] as const;

export type DreamFragmentKind = (typeof DREAM_FRAGMENT_KINDS)[number];

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export interface DreamSamplerConfig {
  recentWindowMs: number;
  remoteMinAgeMs: number;
  maxTextChars: number;
  maxFragmentsPerKind: number;
  randomPartnerRate: number;
  minSimilarity: number;
  maxSimilarity: number;
}

export interface DreamPassConfig {
  model: string;
  maxInsightChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface DreamReviewConfig {
  model: string;
  duplicateSimilarityThreshold: number;
  minTotalScore: number;
  maxNoteChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export const DEFAULT_DREAM_SAMPLER_CONFIG: Readonly<DreamSamplerConfig> = Object.freeze({
  recentWindowMs: 48 * HOUR_MS,
  remoteMinAgeMs: 7 * DAY_MS,
  maxTextChars: 1_200,
  maxFragmentsPerKind: 64,
  randomPartnerRate: 0.15,
  minSimilarity: 0.35,
  maxSimilarity: 0.8,
});

export const DEFAULT_DREAM_PASS_CONFIG: Readonly<DreamPassConfig> = Object.freeze({
  model: 'claude-haiku-4-5',
  maxInsightChars: 600,
  maxOutputTokens: 1_024,
  timeoutMs: 60_000,
});

export const DEFAULT_DREAM_REVIEW_CONFIG: Readonly<DreamReviewConfig> = Object.freeze({
  model: DEFAULT_SCOUT_CRITIC_MODEL,
  duplicateSimilarityThreshold: 0.85,
  minTotalScore: 5,
  maxNoteChars: 600,
  maxOutputTokens: 1_024,
  timeoutMs: 180_000,
});

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function requireProbability(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}

function requireNonEmptyString(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new RangeError(`${name} must be a non-empty string`);
  }
}

export function resolveDreamSamplerConfig(override: Partial<DreamSamplerConfig> = {}): DreamSamplerConfig {
  const config = { ...DEFAULT_DREAM_SAMPLER_CONFIG, ...override };

  requirePositiveInteger('recentWindowMs', config.recentWindowMs);
  requirePositiveInteger('remoteMinAgeMs', config.remoteMinAgeMs);
  requirePositiveInteger('maxTextChars', config.maxTextChars);
  requirePositiveInteger('maxFragmentsPerKind', config.maxFragmentsPerKind);
  requireProbability('randomPartnerRate', config.randomPartnerRate);
  requireProbability('minSimilarity', config.minSimilarity);
  requireProbability('maxSimilarity', config.maxSimilarity);

  if (config.remoteMinAgeMs <= config.recentWindowMs) {
    throw new RangeError('remoteMinAgeMs must be greater than recentWindowMs');
  }
  if (config.minSimilarity >= config.maxSimilarity) {
    throw new RangeError('minSimilarity must be less than maxSimilarity');
  }

  return config;
}

export function resolveDreamPassConfig(override: Partial<DreamPassConfig> = {}): DreamPassConfig {
  const config = { ...DEFAULT_DREAM_PASS_CONFIG, ...override };

  requireNonEmptyString('model', config.model);
  requirePositiveInteger('maxInsightChars', config.maxInsightChars);
  requirePositiveInteger('maxOutputTokens', config.maxOutputTokens);
  requirePositiveInteger('timeoutMs', config.timeoutMs);

  return { ...config, model: config.model.trim() };
}

export function resolveDreamReviewConfig(override: Partial<DreamReviewConfig> = {}): DreamReviewConfig {
  const config = { ...DEFAULT_DREAM_REVIEW_CONFIG, ...override };

  requireNonEmptyString('model', config.model);
  requireProbability('duplicateSimilarityThreshold', config.duplicateSimilarityThreshold);
  requirePositiveInteger('minTotalScore', config.minTotalScore);
  requirePositiveInteger('maxNoteChars', config.maxNoteChars);
  requirePositiveInteger('maxOutputTokens', config.maxOutputTokens);
  requirePositiveInteger('timeoutMs', config.timeoutMs);

  if (config.duplicateSimilarityThreshold === 0) {
    throw new RangeError('duplicateSimilarityThreshold must be greater than 0');
  }
  if (config.minTotalScore > 6) {
    throw new RangeError('minTotalScore must be at most 6');
  }

  return { ...config, model: config.model.trim() };
}
