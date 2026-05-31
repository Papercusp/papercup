/**
 * Prompt registration + dispatch tests.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { definePrompt } from '@papercusp/tooldef';
import {
  _resetPromptCatalogForTests,
  getPromptCatalog,
  lookupPrompt,
} from '@papercusp/tooldef';

describe('prompt registry', () => {
  beforeEach(() => {
    _resetPromptCatalogForTests();
  });

  it('registers a prompt with explicit name', () => {
    const p = definePrompt({
      name: 'fixture:hello',
      description: 'A simple hello prompt',
      async render() {
        return {
          messages: [{ role: 'system', content: { type: 'text', text: 'hi' } }],
        };
      },
    });
    expect(lookupPrompt('fixture:hello')).toBe(p);
    // No capability → low tier by default.
    expect(p.tier).toBe('low');
  });

  it('renders a prompt with arguments', async () => {
    const p = definePrompt({
      name: 'fixture:greet',
      description: 'Greet a name',
      arguments: [{ name: 'name', required: true }],
      async render(args) {
        return {
          messages: [
            { role: 'user', content: { type: 'text', text: `hi ${args.name}` } },
          ],
        };
      },
    });
    const r = await p.render({ name: 'world' }, {} as any);
    expect(r.messages[0].content.text).toBe('hi world');
  });

  it('rejects collision on duplicate name with a different capability', () => {
    // registerPrompt's contract (tooldef/src/prompt-registry.ts): a duplicate
    // name with the SAME capability is treated as HMR re-evaluation and
    // replaced silently; only a DIFFERENT capability is a real authoring
    // collision that throws. Exercise the throw path with mismatched caps.
    definePrompt({
      name: 'fixture:dup',
      capability: 'fixture:a',
      async render() {
        return { messages: [] };
      },
    });
    expect(() =>
      definePrompt({
        name: 'fixture:dup',
        capability: 'fixture:b',
        async render() {
          return { messages: [] };
        },
      }),
    ).toThrow(/Prompt name collision/);
  });

  it('re-registering the same name + same capability is a silent HMR replace', () => {
    definePrompt({
      name: 'fixture:hmr',
      capability: 'fixture:a',
      async render() {
        return { messages: [] };
      },
    });
    expect(() =>
      definePrompt({
        name: 'fixture:hmr',
        capability: 'fixture:a',
        async render() {
          return { messages: [{ role: 'user', content: { type: 'text', text: 'v2' } }] };
        },
      }),
    ).not.toThrow();
  });

  it('catalog returns all registered prompts', () => {
    definePrompt({
      name: 'fixture:a',
      async render() {
        return { messages: [] };
      },
    });
    definePrompt({
      name: 'fixture:b',
      async render() {
        return { messages: [] };
      },
    });
    expect(getPromptCatalog().map((p) => p.name).sort()).toEqual([
      'fixture:a',
      'fixture:b',
    ]);
  });

  it('capability-gated prompt inherits its tier from the capability', () => {
    const p = definePrompt({
      name: 'fixture:secret-prompt',
      capability: 'secrets:read:OPENAI_KEY',
      async render() {
        return { messages: [] };
      },
    });
    expect(p.tier).toBe('high');
  });

  it('arguments schema is preserved on the definition', () => {
    const p = definePrompt({
      name: 'fixture:has-args',
      arguments: [
        { name: 'role', required: true },
        { name: 'context', required: true },
        { name: 'feature', required: false },
      ],
      async render() {
        return { messages: [] };
      },
    });
    expect(p.arguments).toHaveLength(3);
    expect(p.arguments?.[0].required).toBe(true);
    expect(p.arguments?.[2].required).toBe(false);
  });
});
