/**
 * Canonical model-window + launch-budget resolver shared by PSU bootstrap,
 * launcher preflight, and session-port preparation. Keep policy here: callers
 * provide facts (model/backend/live override), then consume the returned
 * versioned budget instead of independently guessing 200k vs 1M.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MODEL_CONTEXT_BUDGET_VERSION = 1;
export const RUNTIME_OVERHEAD_TOKENS = Object.freeze({ full: 152_000, trimmed: 50_000 });
export const DEFAULT_CONTEXT_WINDOWS = Object.freeze({ claude: 200_000, codex: 272_000, omp: 200_000 });

const POSITIVE = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

export function bareModelId(model) {
  return String(model ?? '')
    .trim()
    .replace(/:(?:minimal|low|medium|high|xhigh|max|ultra)$/i, '')
    .replace(/^(?:ollama|ollama-cc|local|llamacpp|llama\.cpp|lmstudio|localai)\//i, '');
}

function jsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function findModelRecord(node, id) {
  if (Array.isArray(node)) {
    for (const value of node) {
      const hit = findModelRecord(value, id);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  if ([node.id, node.slug, node.model].some((v) => String(v ?? '') === id)) return node;
  for (const value of Object.values(node)) {
    const hit = findModelRecord(value, id);
    if (hit) return hit;
  }
  return null;
}

function recordWindow(record) {
  if (!record) return null;
  return POSITIVE(
    record.contextWindow ??
      record.context_window ??
      record.max_context_window ??
      record.nCtx ??
      record.n_ctx,
  );
}

function codexDefaultModel(home) {
  try {
    const text = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    return text.match(/^model\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

function ompDefaultModel(home) {
  try {
    const text = readFileSync(join(home, '.omp', 'agent', 'config.yml'), 'utf8');
    return text.match(/modelRoles:[\s\S]*?\n[ \t]+default:[ \t]*([^\s#]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function installedModelContextWindow({ agent, model, home = homedir() }) {
  const backend = String(agent ?? '').toLowerCase();
  if (backend === 'codex') {
    const root = jsonFile(join(home, '.codex', 'models_cache.json'));
    const id = bareModelId(model || codexDefaultModel(home));
    const exact = id ? findModelRecord(root, id) : null;
    if (recordWindow(exact)) return { window: recordWindow(exact), source: 'codex-model-cache' };
    const visible = Array.isArray(root?.models) ? root.models.find((m) => recordWindow(m)) : null;
    if (recordWindow(visible)) return { window: recordWindow(visible), source: 'codex-model-cache-default' };
  }
  if (backend === 'omp') {
    const id = bareModelId(model || ompDefaultModel(home));
    const root = jsonFile(join(home, '.omp', 'agent', 'models.json'));
    const exact = id ? findModelRecord(root, id) : null;
    if (recordWindow(exact)) return { window: recordWindow(exact), source: 'omp-model-registry' };
    if (id) {
      try {
        const yml = readFileSync(join(home, '.omp', 'agent', 'models.yml'), 'utf8');
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = yml.match(
          new RegExp(`^[ \\t]*-[ \\t]+id:[ \\t]*["']?${escaped}["']?[ \\t]*$([\\s\\S]*?)(?=^[ \\t]*-[ \\t]+id:|\\z)`, 'm'),
        );
        const n = POSITIVE(match?.[1]?.match(/^[ \t]*contextWindow:[ \t]*(\d+)/m)?.[1]);
        if (n) return { window: n, source: 'omp-models-yml' };
      } catch {
        /* registry is optional */
      }
    }
  }
  return null;
}

export function resolveModelContextWindow({ agent, model, home = homedir(), declaredWindow, liveWindow } = {}) {
  const declared = POSITIVE(declaredWindow);
  const live = POSITIVE(liveWindow);
  if (declared || live) {
    const window = declared && live ? Math.min(declared, live) : declared ?? live;
    return { window, source: declared && live ? 'declared-live-min' : declared ? 'declared' : 'live' };
  }

  const installed = installedModelContextWindow({ agent, model, home });
  if (installed) return installed;

  const backend = String(agent || 'claude').toLowerCase();
  const spec = String(model ?? '');
  if (backend === 'claude' && (/\[1m\]/i.test(spec) || /fable|opus|sonnet-?5/i.test(spec) || /^sonnet(?::|$)/i.test(spec))) {
    return { window: 1_000_000, source: 'claude-1m-selector' };
  }
  return {
    window: DEFAULT_CONTEXT_WINDOWS[backend] ?? DEFAULT_CONTEXT_WINDOWS.claude,
    source: `${backend || 'claude'}-conservative-default`,
  };
}

export function estimatePromptTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / 3.7);
}

export function buildContextBudget({
  agent,
  model,
  home = homedir(),
  contextSize,
  promptText,
  estimatedPromptTokens,
  declaredWindow,
  liveWindow,
} = {}) {
  const resolved = resolveModelContextWindow({ agent, model, home, declaredWindow, liveWindow });
  const variant = contextSize === 'full' ? 'full' : 'trimmed';
  const promptTokens = POSITIVE(estimatedPromptTokens) ?? estimatePromptTokens(promptText);
  const runtimeOverheadTokens = RUNTIME_OVERHEAD_TOKENS[variant];
  const baselineTokens = promptTokens + runtimeOverheadTokens;
  const reserveTokens = Math.min(15_000, Math.max(8_000, Math.floor(resolved.window / 26)));
  const availableInputTokens = Math.max(0, resolved.window - baselineTokens - reserveTokens);
  const pct = baselineTokens / resolved.window;
  return {
    version: MODEL_CONTEXT_BUDGET_VERSION,
    agent: String(agent || 'claude'),
    model: model ? String(model) : null,
    window: resolved.window,
    windowSource: resolved.source,
    variant,
    promptTokens,
    runtimeOverheadTokens,
    baselineTokens,
    reserveTokens,
    availableInputTokens,
    level: pct >= 0.6 ? 'refuse' : pct >= 0.35 ? 'warn' : 'ok',
    pct,
    estimator: 'utf8-bytes/3.7-v1',
  };
}
