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

/**
 * plan codex-1m-context-window-2026-08-17 D-007. The load-bearing property is
 * not "big number goes in" — it is that a model with NO extended window emits
 * NOTHING, so a launch argv for gpt-5.5 stays byte-identical to before this
 * feature existed. A policy that fell back to a default on that path would
 * declare a window the model does not have.
 */
describe('codex extended-window launch config', () => {
  const {
    CODEX_MAX_CONFIGURED_WINDOW,
    codexContextConfigArgs,
    codexContextConfigToml,
    codexContextWindowConfig,
  } = modelContextBudget;

  /** A codex home whose models_cache.json carries exactly `models`. */
  const codexHome = (models: unknown[], label = 'cfg') => {
    const home = mkdtempSync(join(tmpdir(), `psu-codex-${label}-`));
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'models_cache.json'), JSON.stringify({ models }));
    return home;
  };

  const SOL = { slug: 'gpt-5.6-sol', context_window: 272_000, max_context_window: 872_000 };
  const GPT55 = { slug: 'gpt-5.5', context_window: 272_000, max_context_window: 272_000 };
  const MINI = { slug: 'gpt-5.4-mini', context_window: 400_000, max_context_window: 400_000 };
  const NANO = { slug: 'gpt-5.4-nano', context_window: 400_000, max_context_window: 400_000 };

  it('respects the runtime record max for an official 1M-class model', () => {
    const home = codexHome([SOL, GPT55], 'sol');
    expect(codexContextWindowConfig('gpt-5.6-sol', { home })).toEqual({
      model: 'gpt-5.6-sol',
      window: 872_000,
      autoCompactLimit: 784_800,
      source: 'codex-model-cache-max',
    });
  });

  it('resolves a psu alias + effort suffix to the same config as the native id', () => {
    const home = codexHome([SOL], 'alias');
    expect(codexContextWindowConfig('sol:high', { home })).toEqual(
      codexContextWindowConfig('gpt-5.6-sol', { home }),
    );
  });

  it('emits NOTHING for sub-1M models whose max equals their default window', () => {
    const home = codexHome([SOL, GPT55, MINI, NANO], 'flat');
    for (const model of ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano']) {
      expect(codexContextWindowConfig(model, { home }), model).toBeNull();
      expect(codexContextConfigArgs(model, { home }), model).toEqual([]);
      expect(codexContextConfigToml(model, { home }), model).toBe('');
    }
  });

  it('does not bypass a readable flat runtime record with the official fallback', () => {
    const home = codexHome([{ slug: 'gpt-5.6-sol', context_window: 272_000, max_context_window: 272_000 }], 'shrink');
    expect(codexContextWindowConfig('gpt-5.6-sol', { home })).toBeNull();
  });

  it('does not use the official fallback when the runtime record lacks a usable max', () => {
    const home = codexHome([{ slug: 'gpt-5.6-sol', context_window: 272_000 }], 'missing-max');
    expect(codexContextWindowConfig('gpt-5.6-sol', { home })).toBeNull();
  });

  it('caps a registry ceiling above 1M at exactly 1M', () => {
    const home = codexHome([{ slug: 'gpt-future', context_window: 272_000, max_context_window: 4_000_000 }], 'cap');
    const cfg = codexContextWindowConfig('gpt-future', { home })!;
    expect(cfg.window).toBe(CODEX_MAX_CONFIGURED_WINDOW);
    expect(cfg.window).toBe(1_000_000);
    expect(cfg.autoCompactLimit).toBe(900_000);
  });

  it('uses the official 1M table when the registry is missing or lacks the model', () => {
    const noRegistry = mkdtempSync(join(tmpdir(), 'psu-codex-bare-'));
    expect(codexContextWindowConfig('gpt-5.6-sol', { home: noRegistry })).toMatchObject({
      window: 1_000_000,
      source: 'codex-official-1m-policy',
    });
    // A registry that simply does not carry this model is the same case.
    const other = codexHome([GPT55], 'partial');
    expect(codexContextWindowConfig('gpt-5.4', { home: other })).toMatchObject({
      window: 1_000_000,
      source: 'codex-official-1m-policy',
    });
    // ...and an unknown model gets nothing rather than a guess.
    expect(codexContextWindowConfig('gpt-unknown-model', { home: noRegistry })).toBeNull();
  });

  it('preserves registry-derived sub-1M extended-window behavior for unrecognised models', () => {
    const home = codexHome([
      { slug: 'gpt-registered-extended', context_window: 272_000, max_context_window: 400_000 },
    ], 'registered-sub-1m');
    expect(codexContextWindowConfig('gpt-registered-extended', { home })).toEqual({
      model: 'gpt-registered-extended',
      window: 400_000,
      autoCompactLimit: 360_000,
      source: 'codex-model-cache-max',
    });
  });

  it('emits the CLI override pair and the config.toml fragment from one policy', () => {
    const home = codexHome([SOL], 'emit');
    expect(codexContextConfigArgs('sol', { home })).toEqual([
      '-c',
      'model_context_window=872000',
      '-c',
      'model_auto_compact_token_limit=784800',
    ]);
    expect(codexContextConfigToml('sol', { home })).toBe(
      'model_context_window = 872000\nmodel_auto_compact_token_limit = 784800\n',
    );
  });

  it('reports the window we LAUNCH with, not the registry default, to the budget math', () => {
    // Without this, a preflight would size the launch context against 272k while
    // the session actually runs the configured runtime-record max.
    const home = codexHome([SOL], 'budget');
    expect(resolveModelContextWindow({ agent: 'codex', model: 'sol:high', home })).toEqual({
      window: 872_000,
      source: 'codex-model-cache-max',
    });
  });
});
