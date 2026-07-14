/**
 * Catalog-wide guard for the canonical alpha-stage semantic argument vocabulary.
 *
 * P-005 / EI-11400: related tools had drifted between rubricId/rubricRef,
 * itemId/item, body/content, and owner/ownerEmail. That forced schema lookups and
 * retry calls even when the caller knew the underlying concept. Alpha policy is
 * a breaking rename, not a compatibility-alias layer: one public spelling, strict
 * rejection, and define-tool's did-you-mean hint teaches callers the correction.
 */
import { describe, expect, it } from 'vitest';
import '../agent-tools/index';
import { listAllProjectedTools } from '@papercusp/tooldef';

type JsonSchema = {
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  maximum?: number;
};

const catalog = new Map(
  listAllProjectedTools()
    .filter((tool) => tool.expose?.mcp?.name)
    .map((tool) => [tool.expose.mcp!.name, tool.inputSchema as JsonSchema]),
);

function schema(name: string): JsonSchema {
  const found = catalog.get(name);
  expect(found, `${name} must be registered`).toBeTruthy();
  return found!;
}

function keys(name: string): string[] {
  return Object.keys(schema(name).properties ?? {});
}

describe('canonical semantic argument vocabulary', () => {
  it.each(['rubrics:get', 'rubrics:ratify'])(
    '%s uses rubricRef/rubricRefs and exposes no rubricId aliases',
    (name) => {
      expect(keys(name)).toEqual(expect.arrayContaining(['rubricRef', 'rubricRefs']));
      expect(keys(name)).not.toEqual(expect.arrayContaining(['rubricId', 'rubricIds']));
    },
  );

  it.each(['rubrics:propose', 'rubrics:amend'])(
    '%s uses singular rubricRef and exposes no rubricId alias',
    (name) => {
      expect(keys(name)).toContain('rubricRef');
      expect(keys(name)).not.toContain('rubricId');
    },
  );

  it.each([
    'plans:get-item',
    'plans:set-status',
    'plans:set-item-blocked-by',
    'plans:set-item-phase',
    'plans:set-importance',
  ])('%s uses item for singular and heterogeneous entries', (name) => {
    const root = schema(name);
    expect(Object.keys(root.properties ?? {})).toContain('item');
    expect(Object.keys(root.properties ?? {})).not.toContain('itemId');
    const entry = root.properties?.items?.items;
    expect(entry, `${name}.items[] schema must be projected`).toBeTruthy();
    expect(Object.keys(entry?.properties ?? {})).toContain('item');
    expect(Object.keys(entry?.properties ?? {})).not.toContain('itemId');
  });

  it('plans:new shares content with plans:set-content and names the email constraint', () => {
    expect(keys('plans:new')).toEqual(expect.arrayContaining(['content', 'ownerEmail']));
    expect(keys('plans:new')).not.toEqual(expect.arrayContaining(['body', 'description', 'owner']));
  });

  it('code:run keeps script as its sole code-body field', () => {
    expect(keys('code:run')).toContain('script');
    expect(keys('code:run')).not.toContain('code');
  });

  it('sessions:timeline advertises its 300-row upper bound', () => {
    expect(schema('sessions:timeline').properties?.limit?.maximum).toBe(300);
  });
});
