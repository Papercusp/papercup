import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));

import { knowledgePacksEnabled, FLAG_OFF, text } from './_shared';
import { getFlag } from '@papercusp/flags/server';

const mockedGetFlag = vi.mocked(getFlag);

describe('knowledgePacksEnabled', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when the KNOWLEDGE_PACKS flag is on', async () => {
    mockedGetFlag.mockResolvedValue(true);
    expect(await knowledgePacksEnabled()).toBe(true);
  });

  it('returns false when the flag is off', async () => {
    mockedGetFlag.mockResolvedValue(false);
    expect(await knowledgePacksEnabled()).toBe(false);
  });

  it('defaults to true (resilient) when the flag infra throws (default-ON flag)', async () => {
    mockedGetFlag.mockRejectedValue(new Error('flag store down'));
    expect(await knowledgePacksEnabled()).toBe(true);
  });
});

describe('FLAG_OFF envelope', () => {
  it('is a feature-disabled refusal naming the flag', () => {
    expect(FLAG_OFF.ok).toBe(false);
    expect(FLAG_OFF.reason).toBe('feature-disabled');
    expect(FLAG_OFF.flag).toBe('papercusp-knowledge-packs');
    expect(FLAG_OFF.hint).toMatch(/papercusp-knowledge-packs/);
  });
});

describe('text() MCP envelope', () => {
  it('wraps a payload as a JSON text content block', () => {
    expect(text({ a: 1, b: 'x' })).toEqual({
      content: [{ type: 'text', text: '{"a":1,"b":"x"}' }],
    });
  });
});
