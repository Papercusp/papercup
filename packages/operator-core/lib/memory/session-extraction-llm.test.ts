import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ExtractionAuthError,
  FallbackExtractionLlm,
  type ExtractionLlm,
} from '@papercusp/memory';
import {
  SessionExtractionLlm,
  extractStrictJson,
  getSessionExtractionLlm,
  sessionExtractionUsage,
  isSessionExtractionDead,
  markSessionExtractionDead,
  _resetSessionExtractionDeadForTest,
  _resetSessionExtractionUsageForTest,
  _resetSessionProbeCacheForTest,
  type SessionTurnRunner,
} from './session-extraction-llm';

// mem0's OSS telemetry reads this at module load — keep tests offline.
process.env.MEM0_TELEMETRY = 'false';

const EXTRACT_MSGS = [
  { role: 'system', content: 'You are a memory extractor.' },
  { role: 'user', content: '## New Messages\nuser prefers tabs' },
];

function okTurn(text: string): SessionTurnRunner {
  return vi.fn(async () => ({ text, tokensIn: 100, tokensOut: 20, costUsd: 0.0001 }));
}

beforeEach(() => {
  _resetSessionExtractionDeadForTest();
  _resetSessionExtractionUsageForTest();
  _resetSessionProbeCacheForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('extractStrictJson', () => {
  it('passes clean JSON through verbatim', () => {
    expect(extractStrictJson('{"memory":[]}')).toBe('{"memory":[]}');
  });
  it('strips code fences and surrounding prose', () => {
    expect(extractStrictJson('Sure! Here it is:\n```json\n{"a":1}\n```\nHope that helps.')).toBe(
      '{"a":1}',
    );
  });
  it('finds the first balanced object amid noise (braces in strings ok)', () => {
    expect(extractStrictJson('note } stray\n{"s":"has } brace","n":2} trailing')).toBe(
      '{"s":"has } brace","n":2}',
    );
  });
  it('handles arrays', () => {
    expect(extractStrictJson('[1,2,3]')).toBe('[1,2,3]');
  });
  it('returns null for non-JSON', () => {
    expect(extractStrictJson('I could not produce JSON, sorry.')).toBeNull();
    expect(extractStrictJson('')).toBeNull();
  });
});

describe('SessionExtractionLlm.generateResponse — strict JSON (D-005)', () => {
  it('happy path: json_object format returns the canonical JSON string', async () => {
    const runTurn = okTurn('```json\n{"memory":[{"id":"m1","text":"likes tabs"}]}\n```');
    const llm = new SessionExtractionLlm({ runTurn, warn: vi.fn() });
    const out = await llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' });
    expect(out).toBe('{"memory":[{"id":"m1","text":"likes tabs"}]}');
    // The system message rode the system slot, not the user turns.
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPromptText: 'You are a memory extractor.',
        messages: [{ role: 'user', content: '## New Messages\nuser prefers tabs' }],
      }),
    );
  });

  it('telemetry fields accumulate per call', async () => {
    const llm = new SessionExtractionLlm({ runTurn: okTurn('{"memory":[]}'), warn: vi.fn() });
    await llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' });
    await llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' });
    const u = sessionExtractionUsage();
    expect(u.calls).toBe(2);
    expect(u.tokensIn).toBe(200);
    expect(u.tokensOut).toBe(40);
    expect(u.costUsd).toBeCloseTo(0.0002);
    expect(u.failures).toBe(0);
    expect(u.model).toBeTruthy();
  });

  it('malformed output → ONE repair retry with a JSON-only nudge → success', async () => {
    const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const runTurn: SessionTurnRunner = vi.fn(async (args) => {
      calls.push(args);
      return calls.length === 1
        ? { text: 'Sorry, here are the facts in prose.', tokensIn: 10, tokensOut: 5, costUsd: 0 }
        : { text: '{"memory":[]}', tokensIn: 10, tokensOut: 5, costUsd: 0 };
    });
    const warn = vi.fn();
    const llm = new SessionExtractionLlm({ runTurn, warn });
    const out = await llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' });
    expect(out).toBe('{"memory":[]}');
    expect(runTurn).toHaveBeenCalledTimes(2);
    // The repair turn carries the bad reply + the nudge.
    const repairMsgs = calls[1].messages;
    expect(repairMsgs.at(-1)?.content).toMatch(/ONLY the JSON/);
    expect(repairMsgs.at(-2)?.role).toBe('assistant');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('repair'));
    expect(sessionExtractionUsage().jsonRepairs).toBe(1);
  });

  it('malformed twice → throws to the cascade (never hands mem0 garbage)', async () => {
    const llm = new SessionExtractionLlm({ runTurn: okTurn('still prose, no json'), warn: vi.fn() });
    await expect(llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' })).rejects.toThrow(
      /non-JSON/,
    );
    expect(sessionExtractionUsage().failures).toBe(1);
  });

  it('no responseFormat → raw text passthrough (no JSON enforcement)', async () => {
    const llm = new SessionExtractionLlm({ runTurn: okTurn('plain prose answer'), warn: vi.fn() });
    await expect(llm.generateResponse(EXTRACT_MSGS)).resolves.toBe('plain prose answer');
  });

  it('tool calls are refused (mem0 additive extraction never sends them)', async () => {
    const llm = new SessionExtractionLlm({ runTurn: okTurn('{}'), warn: vi.fn() });
    await expect(
      llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' }, [{ name: 't' }]),
    ).rejects.toThrow(/tool/);
  });

  it('generateChat returns assistant content', async () => {
    const llm = new SessionExtractionLlm({ runTurn: okTurn('hello'), warn: vi.fn() });
    await expect(llm.generateChat(EXTRACT_MSGS)).resolves.toEqual({
      content: 'hello',
      role: 'assistant',
    });
  });
});

describe('SessionExtractionLlm — 401-driven OAuth refresh (P-004/D-004)', () => {
  const AUTH_ERR = 'anthropic-direct error: 401 {"type":"error","error":{"type":"authentication_error"}}';

  it('401 → invalidate cache → re-read → retry once → success', async () => {
    let attempts = 0;
    const runTurn: SessionTurnRunner = vi.fn(async () => {
      if (attempts++ === 0) throw new Error(AUTH_ERR);
      return { text: '{"memory":[]}', tokensIn: 5, tokensOut: 2, costUsd: 0 };
    });
    const invalidateTokenCache = vi.fn();
    const markDead = vi.fn();
    const warn = vi.fn();
    const llm = new SessionExtractionLlm({ runTurn, invalidateTokenCache, markDead, warn });

    const out = await llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' });
    expect(out).toBe('{"memory":[]}');
    expect(invalidateTokenCache).toHaveBeenCalledTimes(1);
    expect(markDead).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('retrying once'));
    expect(sessionExtractionUsage().authRetries).toBe(1);
  });

  it('persistent 401 → marks the rung dead + throws ExtractionAuthError', async () => {
    const runTurn: SessionTurnRunner = vi.fn(async () => {
      throw new Error(AUTH_ERR);
    });
    const invalidateTokenCache = vi.fn();
    const markDead = vi.fn();
    const llm = new SessionExtractionLlm({ runTurn, invalidateTokenCache, markDead, warn: vi.fn() });

    await expect(llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' })).rejects.toThrow(
      ExtractionAuthError,
    );
    expect(invalidateTokenCache).toHaveBeenCalledTimes(1); // once per protocol, not per attempt
    expect(markDead).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledTimes(2); // original + the single retry
  });

  it('non-auth failure → rethrown untouched, no cache invalidation', async () => {
    const runTurn: SessionTurnRunner = vi.fn(async () => {
      throw new Error('anthropic-direct error: 529 overloaded, exhausted retries');
    });
    const invalidateTokenCache = vi.fn();
    const llm = new SessionExtractionLlm({ runTurn, invalidateTokenCache, warn: vi.fn() });
    await expect(llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' })).rejects.toThrow(
      /529/,
    );
    expect(invalidateTokenCache).not.toHaveBeenCalled();
  });
});

describe('getSessionExtractionLlm — the probe-gated factory (P-003)', () => {
  it('resolves the adapter when a token is present and the probe passes', async () => {
    const llm = await getSessionExtractionLlm({
      readToken: () => 'oauth-token-ok',
      probe: async () => true,
    });
    expect(llm).toBeInstanceOf(SessionExtractionLlm);
  });

  it('no Claude session → null (silent; the shipped-product case)', async () => {
    await expect(
      getSessionExtractionLlm({ readToken: () => null, probe: async () => true }),
    ).resolves.toBeNull();
  });

  it('probe auth-rejects → null (key rungs unchanged) + a loud once-warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        getSessionExtractionLlm({ readToken: () => 'oauth-stale', probe: async () => false }),
      ).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('auth-rejected'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('PAPERCUSP_MEM0_SESSION_EXTRACTION=0 escape hatch → null', async () => {
    vi.stubEnv('PAPERCUSP_MEM0_SESSION_EXTRACTION', '0');
    await expect(
      getSessionExtractionLlm({ readToken: () => 'oauth-token-ok', probe: async () => true }),
    ).resolves.toBeNull();
  });

  it('rung marked dead earlier this process → null until next boot', async () => {
    markSessionExtractionDead();
    expect(isSessionExtractionDead()).toBe(true);
    await expect(
      getSessionExtractionLlm({ readToken: () => 'oauth-token-ok', probe: async () => true }),
    ).resolves.toBeNull();
  });
});

/**
 * Hermetic, pure-JS port of mem0's `MemoryVectorStore` (the 'memory' provider),
 * backed by a Map instead of `better-sqlite3`. Injected below via
 * `VectorStoreFactory.create` so the loudness test never loads the native
 * `better_sqlite3.node`.
 *
 * WHY: that native addon is compiled for the operator's Node ABI (Node 25 /
 * NODE_MODULE_VERSION 141), but the green-checkpoint gate runs the suite under
 * Node 22 (ABI 127). Loading it there throws `ERR_DLOPEN_FAILED`, and this is
 * the ONLY test in the package that instantiates a real `oss.Memory` / touches
 * the native store. The add() path under test (LLM cascade → embed → search →
 * insert) is storage-agnostic, so a faithful in-memory port keeps the exact
 * behavior while removing the brittle native dependency. (Port mirrors
 * mem0ai/dist/oss MemoryVectorStore; keywordSearch is unused by add().)
 */
class InMemoryVectorStore {
  private readonly dimension: number;
  private readonly rows = new Map<string, { vector: number[]; payload: Record<string, unknown> }>();
  private userId: string | null = null;
  private static readonly CAMEL_TO_SNAKE: Record<string, string> = {
    userId: 'user_id',
    agentId: 'agent_id',
    runId: 'run_id',
  };
  constructor(config?: { dimension?: number }) {
    this.dimension = config?.dimension || 1536;
  }
  private normalizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    for (const [camel, snake] of Object.entries(InMemoryVectorStore.CAMEL_TO_SNAKE)) {
      if (camel in payload && !(snake in payload)) {
        payload[snake] = payload[camel];
        delete payload[camel];
      }
    }
    return payload;
  }
  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
  private matchFieldCondition(payload: Record<string, unknown>, key: string, value: unknown): boolean {
    const pv = payload[key];
    if (typeof value !== 'object' || value === null) {
      if (value === '*') return true;
      return pv === value;
    }
    if (Array.isArray(value)) return value.includes(pv);
    const v = value as Record<string, unknown>;
    if ('eq' in v) return pv === v.eq;
    if ('ne' in v) return pv !== v.ne;
    if ('gt' in v) return (pv as number) > (v.gt as number);
    if ('gte' in v) return (pv as number) >= (v.gte as number);
    if ('lt' in v) return (pv as number) < (v.lt as number);
    if ('lte' in v) return (pv as number) <= (v.lte as number);
    if ('in' in v) return Array.isArray(v.in) && v.in.includes(pv);
    if ('nin' in v) return !Array.isArray(v.nin) || !v.nin.includes(pv);
    if ('contains' in v) return typeof pv === 'string' && pv.includes(v.contains as string);
    if ('icontains' in v)
      return typeof pv === 'string' && pv.toLowerCase().includes(String(v.icontains).toLowerCase());
    return pv === value;
  }
  private filterVector(
    entry: { payload: Record<string, unknown> },
    filters?: Record<string, unknown>,
  ): boolean {
    if (!filters || Object.keys(filters).length === 0) return true;
    const keyMap: Record<string, string> = { $and: 'AND', $or: 'OR', $not: 'NOT' };
    const normalized: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(filters)) {
      const nk = keyMap[k] || k;
      if (!(nk in normalized)) normalized[nk] = val;
    }
    for (const [k, val] of Object.entries(normalized)) {
      if (k === 'AND') {
        if (!(val as Record<string, unknown>[]).every((s) => this.filterVector(entry, s))) return false;
      } else if (k === 'OR') {
        if (!(val as Record<string, unknown>[]).some((s) => this.filterVector(entry, s))) return false;
      } else if (k === 'NOT') {
        if (!(val as Record<string, unknown>[]).every((s) => !this.filterVector(entry, s))) return false;
      } else if (!this.matchFieldCondition(entry.payload, k, val)) {
        return false;
      }
    }
    return true;
  }
  async insert(vectors: number[][], ids: string[], payloads: Record<string, unknown>[]): Promise<void> {
    for (let i = 0; i < vectors.length; i++) {
      if (vectors[i].length !== this.dimension) {
        throw new Error(`Vector dimension mismatch. Expected ${this.dimension}, got ${vectors[i].length}`);
      }
      // float32 round-trip + JSON snapshot mirror the real sqlite-backed store.
      this.rows.set(ids[i], {
        vector: Array.from(new Float32Array(vectors[i])),
        payload: JSON.parse(JSON.stringify(payloads[i])),
      });
    }
  }
  async search(
    query: number[],
    topK = 10,
    filters?: Record<string, unknown>,
  ): Promise<Array<{ id: string; payload: Record<string, unknown>; score: number }>> {
    if (query.length !== this.dimension) {
      throw new Error(`Query dimension mismatch. Expected ${this.dimension}, got ${query.length}`);
    }
    const out: Array<{ id: string; payload: Record<string, unknown>; score: number }> = [];
    for (const [id, row] of this.rows) {
      const payload = this.normalizePayload({ ...row.payload });
      if (this.filterVector({ payload }, filters)) {
        out.push({ id, payload, score: this.cosineSimilarity(query, row.vector) });
      }
    }
    out.sort((a, b) => (b.score || 0) - (a.score || 0));
    return out.slice(0, topK);
  }
  async keywordSearch(): Promise<Array<{ id: string; payload: Record<string, unknown>; score: number }>> {
    return [];
  }
  async get(vectorId: string): Promise<{ id: string; payload: Record<string, unknown> } | null> {
    const row = this.rows.get(vectorId);
    if (!row) return null;
    return { id: vectorId, payload: this.normalizePayload({ ...row.payload }) };
  }
  async update(vectorId: string, vector: number[], payload: Record<string, unknown>): Promise<void> {
    if (vector.length !== this.dimension) {
      throw new Error(`Vector dimension mismatch. Expected ${this.dimension}, got ${vector.length}`);
    }
    this.rows.set(vectorId, {
      vector: Array.from(new Float32Array(vector)),
      payload: JSON.parse(JSON.stringify(payload)),
    });
  }
  async delete(vectorId: string): Promise<void> {
    this.rows.delete(vectorId);
  }
  async deleteCol(): Promise<void> {
    this.rows.clear();
  }
  async list(
    filters?: Record<string, unknown>,
    topK = 100,
  ): Promise<[Array<{ id: string; payload: Record<string, unknown> }>, number]> {
    const out: Array<{ id: string; payload: Record<string, unknown> }> = [];
    for (const [id, row] of this.rows) {
      const payload = this.normalizePayload({ ...row.payload });
      if (this.filterVector({ payload }, filters)) out.push({ id, payload });
    }
    return [out.slice(0, topK), out.length];
  }
  async getUserId(): Promise<string> {
    if (this.userId) return this.userId;
    this.userId =
      Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    return this.userId;
  }
  async setUserId(userId: string): Promise<void> {
    this.userId = userId;
  }
  async initialize(): Promise<void> {
    /* no-op: the Map is the store */
  }
}

/**
 * THE LOUDNESS TEST (P-006 — the point of the plan): an expired/garbage
 * OAuth token must yield (a) writes that still land via the next rung
 * and (b) a fired demotion warning. Never a silent no-op.
 *
 * Composed exactly like tryLoad() wires production: the REAL
 * SessionExtractionLlm (401-ing transport, real refresh+retry protocol)
 * inside the REAL FallbackExtractionLlm, driving a REAL mem0 Memory via
 * the 'custom' LLM provider. The key rung is a stub "openai" extractor.
 */
describe('loudness: dead OAuth token → writes land via next rung + warning (P-006)', () => {
  it('mem0.add() stores the fact through the fallback while warning loudly', async () => {
    const oss = (await import('mem0ai/oss')) as unknown as {
      LLMFactory: { create: (p: string, c: Record<string, unknown>) => unknown };
      EmbedderFactory: { create: (p: string, c: Record<string, unknown>) => unknown };
      VectorStoreFactory: { create: (p: string, c: Record<string, unknown>) => unknown };
      Memory: new (config: Record<string, unknown>) => {
        add: (
          messages: string,
          config: Record<string, unknown>,
        ) => Promise<{ results: Array<{ memory: string }> }>;
      };
    };

    const fact = 'User keeps the staging operator on port 3170';

    // The dead-session rung: every transport call 401s, even after the
    // token re-read — the real adapter runs its full refresh protocol.
    const invalidateTokenCache = vi.fn();
    const markDead = vi.fn();
    const warn = vi.fn();
    const deadSession = new SessionExtractionLlm({
      runTurn: async () => {
        throw new Error('anthropic-direct error: 401 authentication_error: OAuth token expired');
      },
      invalidateTokenCache,
      markDead,
      warn,
    });

    // The next rung: a working "key" extractor.
    const keyRung: ExtractionLlm = {
      generateResponse: vi.fn(async () =>
        JSON.stringify({ memory: [{ id: 'k1', text: fact }] }),
      ),
      generateChat: vi.fn(async () => ({ content: '', role: 'assistant' })),
    };
    const cascadeWarn = vi.fn();
    const cascade = new FallbackExtractionLlm(deadSession, async () => keyRung, {
      warn: cascadeWarn,
      primaryLabel: 'claude-session extraction',
    });

    // Patch the factories in-test (the patch mechanism itself is pinned by
    // the @papercusp/memory conformance suite; getMemoryClient() can't run
    // under vitest — its dynamicImport trick has no import callback here).
    const origLlm = oss.LLMFactory.create.bind(oss.LLMFactory);
    const origEmb = oss.EmbedderFactory.create.bind(oss.EmbedderFactory);
    const origVec = oss.VectorStoreFactory.create.bind(oss.VectorStoreFactory);
    oss.LLMFactory.create = (p, c) => (p === 'custom' ? cascade : origLlm(p, c));
    // Inject the hermetic JS store for the 'memory' provider so the native
    // better_sqlite3.node is never loaded (see InMemoryVectorStore above).
    oss.VectorStoreFactory.create = (p, c) =>
      p === 'memory' ? new InMemoryVectorStore(c as { dimension?: number }) : origVec(p, c);
    const embed = async (text: string) =>
      Array.from({ length: 8 }, (_, i) => (((i + 1) * text.length) % 97) / 97);
    oss.EmbedderFactory.create = (p, c) =>
      p === 'custom'
        ? { embed, embedBatch: (ts: string[]) => Promise.all(ts.map(embed)) }
        : origEmb(p, c);

    try {
      const memory = new oss.Memory({
        embedder: { provider: 'custom', config: {} },
        vectorStore: {
          provider: 'memory',
          config: { collectionName: 'loudness', dimension: 8, dbPath: ':memory:' },
        },
        llm: { provider: 'custom', config: {} },
        disableHistory: true,
      });

      const res = await memory.add('fyi the staging operator lives on 3170', {
        userId: 'loudness',
      });

      // (a) The write LANDED — served by the next rung.
      expect(res.results.some((r) => r.memory === fact)).toBe(true);
      expect(keyRung.generateResponse).toHaveBeenCalled();

      // (b) The demotion was LOUD — adapter warned through its refresh
      // protocol, cascade warned on demotion, rung marked dead.
      expect(invalidateTokenCache).toHaveBeenCalled();
      expect(markDead).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('retrying once'));
      expect(cascadeWarn).toHaveBeenCalledWith(expect.stringContaining('demoting'));
      expect(cascade.isDemoted).toBe(true);
    } finally {
      oss.LLMFactory.create = origLlm;
      oss.EmbedderFactory.create = origEmb;
      oss.VectorStoreFactory.create = origVec;
    }
  });
});
