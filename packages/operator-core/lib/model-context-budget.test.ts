import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as modelContextBudget from './model-context-budget.mjs';

const {
  buildContextBudget,
  formatCodexLaunchContextSection,
  normalizeCodexCliModel,
  readLaunchContextText,
  resolveModelContextWindow,
} = modelContextBudget;

describe('model-context-budget', () => {
  it('normalizes user-facing Codex families while preserving native ids and effort', () => {
    expect(normalizeCodexCliModel('sol')).toBe('gpt-5.6-sol');
    expect(normalizeCodexCliModel('terra:xhigh')).toBe('gpt-5.6-terra:xhigh');
    expect(normalizeCodexCliModel('luna:max')).toBe('gpt-5.6-luna:max');
    expect(normalizeCodexCliModel('chatgpt:5.5:high')).toBe('gpt-5.5:high');
    expect(normalizeCodexCliModel('gpt-5.6-sol:high')).toBe('gpt-5.6-sol:high');
  });

  it('reads the selected Codex model window from the installed cache', () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-budget-codex-'));
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'gpt-test', context_window: 272_000 }] }),
    );
    expect(resolveModelContextWindow({ agent: 'codex', model: 'gpt-test:high', home })).toEqual({
      window: 272_000,
      source: 'codex-model-cache',
    });
  });

  it('reads OMP contextWindow and clamps declared configuration to a live backend', () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-budget-omp-'));
    mkdirSync(join(home, '.omp', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.omp', 'agent', 'models.json'),
      JSON.stringify({ models: [{ id: 'ornith-test', contextWindow: 200_000 }] }),
    );
    expect(resolveModelContextWindow({ agent: 'omp', model: 'ollama-cc/ornith-test:xhigh', home })).toEqual({
      window: 200_000,
      source: 'omp-model-registry',
    });
    expect(resolveModelContextWindow({ agent: 'omp', declaredWindow: 200_000, liveWindow: 180_000 })).toEqual({
      window: 180_000,
      source: 'declared-live-min',
    });
  });

  it('reads a YAML-only OMP registry record through end-of-file', () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-budget-omp-yaml-'));
    mkdirSync(join(home, '.omp', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.omp', 'agent', 'models.yml'),
      ['- id: first', '  contextWindow: 64000', '- id: target-last', '  contextWindow: 131072', ''].join('\n'),
    );
    expect(resolveModelContextWindow({ agent: 'omp', model: 'target-last', home })).toEqual({
      window: 131_072,
      source: 'omp-models-yml',
    });
  });

  it('counts the exact bounded launch-context bytes in the shared budget', () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-budget-context-'));
    const path = join(home, 'brief.md');
    writeFileSync(path, 'mission context');
    const context = readLaunchContextText(path);
    const without = buildContextBudget({ agent: 'codex', promptText: 'base', declaredWindow: 200_000 });
    const withContext = buildContextBudget({
      agent: 'codex',
      promptText: 'base',
      additionalPromptText: formatCodexLaunchContextSection(context),
      declaredWindow: 200_000,
    });
    expect(withContext.promptTokens).toBeGreaterThan(without.promptTokens);
    expect(withContext.availableInputTokens).toBeLessThan(without.availableInputTokens);
  });

  it('returns one versioned budget used by bootstrap, preflight, and port fitting', () => {
    const budget = buildContextBudget({
      agent: 'claude',
      model: 'opus[1m]:high',
      contextSize: 'trimmed',
      estimatedPromptTokens: 20_000,
    });
    expect(budget).toMatchObject({
      version: 1,
      window: 1_000_000,
      promptTokens: 20_000,
      runtimeOverheadTokens: 50_000,
      baselineTokens: 70_000,
      reserveTokens: 15_000,
      availableInputTokens: 915_000,
      level: 'ok',
    });
  });
});
