/**
 * Tests for the capability-map (dynamic-tool-surface D-011). Importing the tool files
 * registers them into the projected registry, so groupToolsByCategory / capabilityMapText
 * see a populated catalog (at least the tools:* verbs).
 */
import { describe, it, expect } from 'vitest';

// Register some tools so the registry isn't empty (side-effect imports).
import './find';
import './invoke';
import { capabilityMapText, groupToolsByCategory } from './capability-map';

describe('groupToolsByCategory', () => {
  it('groups exposed tools by namespace prefix', () => {
    const byCat = groupToolsByCategory();
    // tools:find + tools:invoke both live under the "tools" category.
    expect(byCat.has('tools')).toBe(true);
    expect(byCat.get('tools')).toEqual(expect.arrayContaining(['tools:find', 'tools:invoke']));
  });
});

describe('capabilityMapText', () => {
  it('renders the dynamic-surface directive + the tools:find / tools:invoke front doors', () => {
    const map = capabilityMapText();
    expect(map).toContain('DYNAMIC');
    expect(map).toContain('tools:find');
    expect(map).toContain('tools:invoke');
    // It tells the model to SEARCH rather than expect everything loaded.
    expect(map.toLowerCase()).toContain('search');
  });

  it('includes a category menu with the tools category + example names', () => {
    const map = capabilityMapText();
    expect(map).toMatch(/- \*\*tools\*\* \(\d+\):/);
    expect(map).toContain('tools:find');
  });

  it('is cached (same string instance across calls until the catalog drifts)', () => {
    expect(capabilityMapText()).toBe(capabilityMapText());
  });

  it('stays compact — a capability MAP, not the full descriptions (well under the ~165k it replaces)', () => {
    // Rough token proxy: chars/4. The whole point is ~1-2k tokens, not 165k.
    const approxTokens = capabilityMapText().length / 4;
    expect(approxTokens).toBeLessThan(8000);
  });
});
