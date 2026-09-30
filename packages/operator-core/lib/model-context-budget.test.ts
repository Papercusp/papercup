import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as modelContextBudget from './model-context-budget.mjs';

const {
  buildContextBudget,
  CODEX_DENIED_MODEL_IDS,
  CODEX_SAFE_DEFAULT_MODEL,
  codexModelConfigToml,
  formatCodexLaunchContextSection,
  isCodexModelDenied,
  listCodexInstalledModels,
  normalizeCodexCliModel,
  readLaunchContextText,
  resolveCodexModel,
  resolveCodexModelSelection,
  resolveModelContextWindow,
} = modelContextBudget;

describe('managed Codex model policy', () => {
  it('rejects unresolved model input with a stable missing_model code', () => {
    for (const input of [undefined, null, '', '  ']) {
      try {
        resolveCodexModel(input);
        throw new Error(`expected ${JSON.stringify(input)} to be rejected`);
      } catch (error) {
        expect(error).toMatchObject({ code: 'missing_model' });
      }
    }
  });

  it('resolves Sol xhigh only through an explicit configured-default selection', () => {
    expect(CODEX_SAFE_DEFAULT_MODEL).toBe('gpt-5.6-sol:xhigh');
    expect(resolveCodexModelSelection(undefined, { source: 'configured-default' })).toEqual({
      model: 'gpt-5.6-sol:xhigh',
      source: 'configured-default',
    });
    expect(codexModelConfigToml(CODEX_SAFE_DEFAULT_MODEL)).toEqual([
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "xhigh"',
      '',
    ]);
  });

  it('preserves explicit and inherited source provenance', () => {
    expect(resolveCodexModelSelection('terra:high', { source: 'explicit' })).toEqual({
      model: 'gpt-5.6-terra:high',
      source: 'explicit',
    });
    expect(resolveCodexModelSelection('gpt-5.5:xhigh', { source: 'inherited' })).toEqual({
      model: 'gpt-5.5:xhigh',
      source: 'inherited',
    });
  });

  it('denies Spark across provider prefixes, effort suffixes, and case', () => {
    for (const spec of [
      'gpt-5.3-codex-spark',
      'GPT-5.3-CODEX-SPARK:high',
      'openai-codex/gpt-5.3-codex-spark:xhigh',
      'papercusp-gateway/gpt-5.3-codex-spark',
      'chatgpt:5.3-codex-spark',
      'chatgpt:5.3-codex-spark:turbo',
    ]) {
      expect(isCodexModelDenied(spec), spec).toBe(true);
      expect(() => resolveCodexModel(spec), spec).toThrow(/denied/i);
    }
    expect(CODEX_DENIED_MODEL_IDS).toContain('gpt-5.3-codex-spark');
  });

  it('renders an explicit model and reasoning effort for resume-safe CODEX_HOME config', () => {
    expect(codexModelConfigToml('sol:high')).toEqual([
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "high"',
      '',
    ]);
  });

  it('preserves GPT-6.1 Sol selection and max effort in the resume config', () => {
    expect(resolveCodexModelSelection('chatgpt:6.1-sol:max')).toEqual({
      model: 'gpt-6.1-sol:max',
      source: 'explicit',
    });
    expect(codexModelConfigToml('gpt-6.1-sol:max')).toEqual([
      'model = "gpt-6.1-sol"',
      'model_reasoning_effort = "max"',
      '',
    ]);
  });
});

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

  it('reads a direct CODEX_HOME registry when no HOME override is supplied', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'psu-budget-codex-home-'));
    writeFileSync(
      join(codexHome, 'models_cache.json'),
      JSON.stringify({
        models: [{ slug: 'gpt-6-astra', context_window: 272_000, max_context_window: 872_000 }],
      }),
    );
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      expect(modelContextBudget.codexContextWindowConfig('gpt-6-astra')).toEqual({
        model: 'gpt-6-astra',
        window: 872_000,
        autoCompactLimit: 784_800,
        source: 'codex-model-cache-max',
      });
      expect(modelContextBudget.codexContextWindowConfig('gpt-6-astra', { codexHome })).toEqual(
        modelContextBudget.codexContextWindowConfig('gpt-6-astra'),
      );
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
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
 * plan codex-1m-context-window-2026-08-17 D-008. The load-bearing property is
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

  it('keeps the exact 1M opt-in for an official model despite an 872k runtime record max', () => {
    const home = codexHome([SOL, GPT55], 'sol');
    expect(codexContextWindowConfig('gpt-5.6-sol', { home })).toEqual({
      model: 'gpt-5.6-sol',
      window: 1_000_000,
      autoCompactLimit: 900_000,
      source: 'codex-official-1m-policy',
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

  it('does not let a stale flat runtime record disable the explicit 1M opt-in', () => {
    const home = codexHome([{ slug: 'gpt-5.6-sol', context_window: 272_000, max_context_window: 272_000 }], 'shrink');
    expect(codexContextWindowConfig('gpt-5.6-sol', { home })).toMatchObject({
      window: 1_000_000,
      autoCompactLimit: 900_000,
      source: 'codex-official-1m-policy',
    });
  });

  it('does not guess for an unrecognised runtime record that lacks a usable max', () => {
    const home = codexHome([{ slug: 'gpt-unrecognised', context_window: 272_000 }], 'missing-max');
    expect(codexContextWindowConfig('gpt-unrecognised', { home })).toBeNull();
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

  it('uses Astra\'s 1M fresh-home fallback but honors a direct registry max on resume', () => {
    const noRegistry = mkdtempSync(join(tmpdir(), 'psu-codex-astra-bare-'));
    expect(codexContextWindowConfig('gpt-6-astra', { home: noRegistry })).toMatchObject({
      window: 1_000_000,
      autoCompactLimit: 900_000,
      source: 'codex-official-1m-policy',
    });
    const sessionHome = mkdtempSync(join(tmpdir(), 'psu-codex-astra-session-'));
    writeFileSync(
      join(sessionHome, 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'gpt-6-astra', context_window: 272_000, max_context_window: 872_000 }] }),
    );
    expect(codexContextWindowConfig('gpt-6-astra', { codexHome: sessionHome })).toMatchObject({
      window: 872_000,
      autoCompactLimit: 784_800,
      source: 'codex-model-cache-max',
    });
  });

  it.each(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'])('%s uses the 1M fresh-home fallback and a registry max after discovery', (model) => {
    const noRegistry = mkdtempSync(join(tmpdir(), `psu-codex-${model}-bare-`));
    expect(codexContextWindowConfig(model, { home: noRegistry })).toMatchObject({
      model,
      window: 1_000_000,
      autoCompactLimit: 900_000,
      source: 'codex-official-1m-policy',
    });
    const sessionHome = mkdtempSync(join(tmpdir(), `psu-codex-${model}-session-`));
    writeFileSync(
      join(sessionHome, 'models_cache.json'),
      JSON.stringify({ models: [{ slug: model, context_window: 272_000, max_context_window: 872_000 }] }),
    );
    expect(codexContextWindowConfig(model, { codexHome: sessionHome })).toMatchObject({
      model,
      window: 872_000,
      autoCompactLimit: 784_800,
      source: 'codex-model-cache-max',
    });
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
      'model_context_window=1000000',
      '-c',
      'model_auto_compact_token_limit=900000',
    ]);
    expect(codexContextConfigToml('sol', { home })).toBe(
      'model_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n',
    );
  });

  it('reports the window we LAUNCH with, not the registry default, to the budget math', () => {
    // Without this, a preflight would size the launch context against 272k while
    // the session actually runs the configured runtime-record max.
    const home = codexHome([SOL], 'budget');
    expect(resolveModelContextWindow({ agent: 'codex', model: 'sol:high', home })).toEqual({
      window: 1_000_000,
      source: 'codex-official-1m-policy',
    });
  });
});

/**
 * WI-126377 — LISTING the same registry `codexModelRecord` has been reading one
 * model at a time. psu's resume picker could offer only three hardcoded aliases
 * until this existed, so an installed gpt-5.5 had to be typed from memory.
 */
describe('listCodexInstalledModels', () => {
  const home = (models: unknown[], label: string) => {
    const dir = mkdtempSync(join(tmpdir(), `psu-codex-list-${label}-`));
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(join(dir, '.codex', 'models_cache.json'), JSON.stringify({ models }));
    return dir;
  };

  it('drops the registry\'s own hidden entries rather than a hand-kept exclusion list', () => {
    // Measured on this box 2026-08-27: gpt-reserve and codex-auto-review ship
    // with visibility 'hide'. They are real models, but not what a human means
    // by "the model list".
    const dir = home(
      [
        { slug: 'gpt-5.5', visibility: 'list', priority: 7 },
        { slug: 'gpt-reserve', visibility: 'hide', priority: 3 },
      ],
      'hidden',
    );
    expect(listCodexInstalledModels({ home: dir }).map((m) => m.id)).toEqual(['gpt-5.5']);
  });

  it('orders by the registry\'s OWN priority, so a new model needs no code change to rank', () => {
    const dir = home(
      [
        { slug: 'gpt-5.4', priority: 16 },
        { slug: 'gpt-5.6-sol', priority: 1 },
        { slug: 'gpt-5.5', priority: 7 },
      ],
      'priority',
    );
    expect(listCodexInstalledModels({ home: dir }).map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4']);
  });

  it('flattens each model\'s supported reasoning levels to bare effort strings', () => {
    const dir = home(
      [
        {
          slug: 'gpt-5.5',
          display_name: 'GPT-5.5',
          default_reasoning_level: 'medium',
          context_window: 272_000,
          max_context_window: 272_000,
          supported_reasoning_levels: [
            { effort: 'low', description: 'Fast responses' },
            { effort: 'high', description: 'Greater depth' },
          ],
        },
      ],
      'efforts',
    );
    expect(listCodexInstalledModels({ home: dir })[0]).toEqual({
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      description: null,
      efforts: ['low', 'high'],
      defaultEffort: 'medium',
      contextWindow: 272_000,
      maxContextWindow: 272_000,
    });
  });

  it('returns [] — never throws — when the cache is missing or unparseable', () => {
    // The caller must degrade to its alias rows, not lose the picker.
    const missing = mkdtempSync(join(tmpdir(), 'psu-codex-list-missing-'));
    expect(listCodexInstalledModels({ home: missing })).toEqual([]);

    const broken = mkdtempSync(join(tmpdir(), 'psu-codex-list-broken-'));
    mkdirSync(join(broken, '.codex'), { recursive: true });
    writeFileSync(join(broken, '.codex', 'models_cache.json'), '{ not json');
    expect(listCodexInstalledModels({ home: broken })).toEqual([]);
  });

  it('skips a record with no usable id instead of emitting a blank row', () => {
    const dir = home([{ display_name: 'nameless' }, { slug: 'gpt-5.5' }], 'blank');
    expect(listCodexInstalledModels({ home: dir }).map((m) => m.id)).toEqual(['gpt-5.5']);
  });
});
