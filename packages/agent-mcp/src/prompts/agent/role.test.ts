/**
 * `agent:role` — the read-side role-prompt PROJECTION: external clients fetch the
 * exact persona md Papercusp dispatches its own agents with
 * (libs/papercusp/packages/harness/prompts/<role>.md). `__tests__/prompts.test.ts`
 * exercises tooldef's prompt *registry* with fixtures; this is the only coverage
 * of the real `agent:role` resolver itself:
 *   - the id guard (rejects empty + path-traversal — the only auth boundary here)
 *   - on-disk-as-source-of-truth resolution (a real persona returned as one
 *     system message; distinct roles → distinct content)
 *   - the not-found throw for a well-formed-but-unknown role.
 *
 * `@papercusp/host-platform` is mocked, but backed by real `node:fs`, so the
 * resolver walks to the actual prompts dir and reads the real files — an honest
 * end-to-end check of the projection, not a stub of it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/host-platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/host-platform')>();
  const { existsSync, readFileSync } = await import('node:fs');
  return {
    ...actual,
    getHostPlatform: () => ({
      fileExistsSync: (p: string) => existsSync(p),
      readTextFileSync: (p: string) => {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return null;
        }
      },
    }),
  };
});

import prompt from './role';

describe('agent:role prompt projection', () => {
  it('declares the agent:role prompt with a required `role` argument', () => {
    expect(prompt.name).toBe('agent:role');
    const arg = prompt.arguments?.find((a) => a.name === 'role');
    expect(arg?.required).toBe(true);
  });

  it('returns the canonical persona for a known role as a single system message', async () => {
    const r = await prompt.render({ role: 'architect' }, {} as never);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].role).toBe('system');
    expect(r.messages[0].content.type).toBe('text');
    // the real on-disk persona, not an empty/placeholder body
    expect((r.messages[0].content as { text: string }).text.length).toBeGreaterThan(0);
    expect(r.description).toMatch(/architect/i);
  });

  it('resolves role-specific personas (distinct roles → distinct content)', async () => {
    const a = await prompt.render({ role: 'architect' }, {} as never);
    const w = await prompt.render({ role: 'worker' }, {} as never);
    const aText = (a.messages[0].content as { text: string }).text;
    const wText = (w.messages[0].content as { text: string }).text;
    expect(aText.length).toBeGreaterThan(0);
    expect(wText.length).toBeGreaterThan(0);
    // proves the resolver reads <role>.md, not one shared blob
    expect(aText).not.toBe(wText);
  });

  it('rejects an empty or path-traversing role id (the id guard is the auth boundary)', async () => {
    for (const bad of ['', '../secrets', 'foo/bar', 'a.b', '.hidden']) {
      await expect(prompt.render({ role: bad }, {} as never)).rejects.toThrow(/Invalid role id/);
    }
  });

  it('throws not-found for a well-formed but unknown role', async () => {
    await expect(
      prompt.render({ role: 'definitely-not-a-real-role' }, {} as never),
    ).rejects.toThrow(/not found/i);
  });
});
