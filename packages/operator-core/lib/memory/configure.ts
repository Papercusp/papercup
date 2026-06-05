/**
 * Operator host binding for `@papercusp/memory`.
 *
 * Wires the seams the store core needs: where the embedded-pg lives, the
 * LLM credentials for mem0's fact-extraction, the resolved embedder (the
 * operator owns the openai → local → disabled cascade and hands back a
 * pre-built embed fn), an explicit-mode embedder builder for the re-embed
 * pass, and the optional adaptive-instruction feed from the learning loop.
 *
 * Imported for its side-effect by `./index` and the deep-path shims
 * (`./mem0-client`, `./mem0-connection`, `./reembed`) so `configureMemory()`
 * runs before any store API is touched, regardless of entry point.
 *
 * The embedder cascade mirrors `lib/agent-tools/search/embedder.ts`
 * (search uses the same OpenAI-or-local resolution). They're deliberately
 * kept separate for now — search returns just `(text)=>number[]|null`,
 * while memory also needs the resolved `mode` to pick the per-model vec
 * table. A future share could lift the common core; not worth blocking
 * the extraction on it.
 *
 * Part of papercusp-systems-abstraction-2026-05-29 (P-021).
 */

import os from 'node:os';
import path from 'node:path';
import {
  configureMemory,
  buildLocalEmbedder,
  registerMemoryBackend,
  ClaudeFileMemoryBackend,
  CLAUDE_FILE_BACKEND_NAME,
  claudeProjectMemoryDir,
  type EmbedFn,
  type ResolvedEmbedder,
} from '@papercusp/memory';
import { readCredentials } from '../credentials';
import { loadVoicePrefs } from '../voice-prefs';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import { buildLearningInstructions } from './learning';

const EMBEDDER_DIM = 384;
const OPENAI_EMBEDDER_MODEL = 'text-embedding-3-small';
const TRANSFORMERS_PACKAGE = '@huggingface/transformers';

// Dodge bundler static analysis — @huggingface/transformers is an
// optional, lazily-resolved dependency (only present when local mode is
// in play).
const dynamicImport = new Function(
  'specifier',
  'return import(specifier)',
) as <T>(specifier: string) => Promise<T>;

/** Resolve the OpenAI key: operator credentials first, env fallback. */
async function resolveOpenAiKey(): Promise<string> {
  let key = process.env.OPENAI_API_KEY ?? '';
  try {
    const creds = await readCredentials();
    if (creds.openai_api_key) key = creds.openai_api_key;
  } catch {
    /* PG creds unavailable — fall back to env */
  }
  return key;
}

/** OpenAI text-embedding-3-small, truncated to 384 dims via the API. */
function buildOpenAiEmbedder(apiKey: string): EmbedFn {
  return async (text: string): Promise<number[]> => {
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_EMBEDDER_MODEL,
        input: text,
        dimensions: EMBEDDER_DIM,
      }),
    });
    if (!r.ok) {
      throw new Error(`openai_embed_failed_${r.status}: ${await r.text().catch(() => '')}`);
    }
    const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
    return j.data[0].embedding;
  };
}

/** Is the local transformers package installed? */
async function localAvailable(): Promise<boolean> {
  try {
    await dynamicImport(TRANSFORMERS_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

async function readEmbedderPreference(): Promise<'auto' | 'openai' | 'local' | 'disabled'> {
  try {
    const prefs = await loadVoicePrefs();
    return prefs.memoryEmbedderMode;
  } catch {
    return 'auto';
  }
}

/**
 * Build an embedder for an explicit mode. Throws if that mode's
 * credentials/packages aren't available (the re-embed pass surfaces it).
 */
async function buildEmbedderForMode(mode: 'openai' | 'local'): Promise<EmbedFn> {
  if (mode === 'openai') {
    const key = await resolveOpenAiKey();
    if (!key) throw new Error('openai_api_key not configured');
    return buildOpenAiEmbedder(key);
  }
  // local — worker-thread isolated, inline fallback.
  return buildLocalEmbedder();
}

/**
 * Resolve the embedder for the current user preference. 'disabled' is a
 * hard stop; 'auto' cascades openai → local → disabled.
 */
async function resolveEmbedder(): Promise<ResolvedEmbedder> {
  const preference = await readEmbedderPreference();
  if (preference === 'disabled') {
    return { mode: 'disabled', reason: 'user_disabled' };
  }

  const key = await resolveOpenAiKey();

  if (preference === 'openai') {
    if (key) return { mode: 'openai', dims: EMBEDDER_DIM, embed: buildOpenAiEmbedder(key) };
    return { mode: 'disabled', reason: 'openai_forced_but_no_key' };
  }

  if (preference === 'local') {
    if (await localAvailable()) {
      return { mode: 'local', dims: EMBEDDER_DIM, embed: await buildLocalEmbedder() };
    }
    return { mode: 'disabled', reason: 'local_forced_but_not_installed' };
  }

  // 'auto' — openai first, then local, then disabled.
  if (key) return { mode: 'openai', dims: EMBEDDER_DIM, embed: buildOpenAiEmbedder(key) };
  if (await localAvailable()) {
    return { mode: 'local', dims: EMBEDDER_DIM, embed: await buildLocalEmbedder() };
  }
  return { mode: 'disabled', reason: 'no_openai_key_and_local_not_installed' };
}

// The Claude Code topic-file bridge (generalize-memory-backend-swappable
// D-005 / claude-memory-projection-integration P-004): select with
// PAPERCUSP_MEMORY_BACKEND=claude-file to read/write the owner's native
// Claude file memory through the neutral seam. The store location is the
// Claude project derived from $HOME (where the owner runs Claude Code) —
// override the dir with PAPERCUSP_CLAUDE_MEMORY_DIR or the project with
// PAPERCUSP_CLAUDE_PROJECT_DIR. Never creates the dir: a box without a
// Claude store reports unavailable rather than inventing one. MEMORY.md
// (the auto-generated index) is never touched; the SessionStart
// memory-compact hook projects new topic files into it.
registerMemoryBackend(CLAUDE_FILE_BACKEND_NAME, () => new ClaudeFileMemoryBackend({
  memoryDir:
    process.env.PAPERCUSP_CLAUDE_MEMORY_DIR ||
    claudeProjectMemoryDir(
      process.env.PAPERCUSP_CLAUDE_PROJECT_DIR || os.homedir(),
      path.join(os.homedir(), '.claude'),
    ),
}));

configureMemory({
  getAdminUrl: getHarnessAdminUrl,
  // The operator's memory tables live in the harness_shared schema
  // (migration 081); the embedded-pg database is `papercusp`; the SQLite
  // event-history log persists under ~/.papercusp.
  schema: 'harness_shared',
  defaultDbName: 'papercusp',
  localStoreDir: path.join(os.homedir(), '.papercusp'),
  // The swappable-store selector (generalize-memory-backend-swappable
  // D-004): which MemoryBackend getMemoryBackend() serves. A config
  // flip — 'mem0' (default) | 'noop' | any name registered via
  // registerMemoryBackend(). An unknown name fails loud at first use.
  backend: process.env.PAPERCUSP_MEMORY_BACKEND || 'mem0',
  getCredentials: async () => {
    const c = await readCredentials();
    return { openai_api_key: c.openai_api_key, anthropic_api_key: c.anthropic_api_key };
  },
  resolveEmbedder,
  buildEmbedderForMode,
  // Optional: adaptive extraction instructions from the operator's
  // learning loop. Best-effort — the package treats it as a black box.
  getLearningInstructions: async () => (await buildLearningInstructions()) ?? undefined,
});
