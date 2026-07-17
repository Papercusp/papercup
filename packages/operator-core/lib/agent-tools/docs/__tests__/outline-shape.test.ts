/**
 * shapeOutlineResponse — EI-400 (docs:outline at harness:'all' blew the MCP
 * result budget, ~800KB+ in one line). Pure-function unit tests over the
 * (payload, args, surface) → response-body shaping logic, independent of
 * the fs adapters / defineTool plumbing (those stay covered by
 * handlers.test.ts / routing.test.ts).
 */

import { describe, expect, it } from 'vitest';
import type { OutlinePayload } from '@papercusp/docs-engine';
import { shapeOutlineResponse } from '../outline';

function makePayload(overrides: Partial<OutlinePayload> = {}): OutlinePayload {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    sectionCount: 2,
    pageCount: 3,
    sections: [
      {
        slug: 'agent-insights',
        title: 'Agent Insights',
        description: 'Runbooks',
        pages: [
          { slug: 'agent-insights/a', title: 'A', headings: [{ id: 'h1', text: 'H1', depth: 2 }] },
          { slug: 'agent-insights/b', title: 'B', headings: [] },
        ],
      },
      {
        slug: 'design',
        title: 'Design',
        pages: [{ slug: 'design/overview', title: 'Overview', headings: [] }],
      },
    ],
    ...overrides,
  };
}

describe('shapeOutlineResponse — harness surface (unchanged, whole-outline)', () => {
  it('no section arg → full payload passthrough, no brief/hint fields', () => {
    const payload = makePayload();
    const body = shapeOutlineResponse(payload, {}, 'harness');
    expect(body).toEqual(payload);
    expect(body.brief).toBeUndefined();
    expect(body.hint).toBeUndefined();
  });
});

describe('shapeOutlineResponse — engineering/project surface (brief by default)', () => {
  it('no section arg → compact section index, no per-page headings', () => {
    const payload = makePayload();
    const body = shapeOutlineResponse(payload, {}, 'engineering') as {
      brief: boolean;
      hint: string;
      sections: Array<{ slug: string; title: string; pageCount: number }>;
      pageCount: number;
      sectionCount: number;
    };
    expect(body.brief).toBe(true);
    expect(typeof body.hint).toBe('string');
    expect(body.sectionCount).toBe(2);
    expect(body.pageCount).toBe(3);
    expect(body.sections).toEqual([
      { slug: 'agent-insights', title: 'Agent Insights', description: 'Runbooks', pageCount: 2 },
      { slug: 'design', title: 'Design', pageCount: 1 },
    ]);
    // No page-level detail leaked into the brief listing.
    expect(body).not.toHaveProperty('section');
    for (const s of body.sections) expect(s).not.toHaveProperty('pages');
    expect(JSON.stringify(body)).not.toContain('agent-insights/a');
  });

  it('project surface gets the same brief treatment as engineering', () => {
    const payload = makePayload();
    const body = shapeOutlineResponse(payload, {}, 'project') as { brief: boolean };
    expect(body.brief).toBe(true);
  });

  it('section arg → full page list + headings for just that section', () => {
    const payload = makePayload();
    const body = shapeOutlineResponse(payload, { section: 'agent-insights' }, 'engineering') as {
      section: { slug: string; pages: unknown[]; pagesTotal: number; pagesReturned: number };
      brief?: boolean;
    };
    expect(body.brief).toBeUndefined();
    expect(body.section.slug).toBe('agent-insights');
    expect(body.section.pages).toHaveLength(2);
    expect(body.section.pagesTotal).toBe(2);
    expect(body.section.pagesReturned).toBe(2);
    expect((body.section.pages[0] as { headings: unknown[] }).headings).toEqual([
      { id: 'h1', text: 'H1', depth: 2 },
    ]);
  });

  it('section arg is case-insensitive', () => {
    const payload = makePayload();
    const body = shapeOutlineResponse(payload, { section: 'Agent-Insights' }, 'engineering') as {
      section: { slug: string };
    };
    expect(body.section.slug).toBe('agent-insights');
  });

  it('unknown section → section_not_found with the available slugs, not a crash', () => {
    const payload = makePayload();
    const body = shapeOutlineResponse(payload, { section: 'nope' }, 'engineering') as {
      error: string;
      section: string;
      availableSections: string[];
    };
    expect(body.error).toBe('section_not_found');
    expect(body.section).toBe('nope');
    expect(body.availableSections).toEqual(['agent-insights', 'design']);
  });

  it('offset/limit paginate a section\'s pages and report nextOffset when more remain', () => {
    const payload = makePayload();
    const body = shapeOutlineResponse(
      payload,
      { section: 'agent-insights', offset: 0, limit: 1 },
      'engineering',
    ) as { section: { pages: unknown[]; pagesTotal: number; pagesReturned: number; nextOffset?: number } };
    expect(body.section.pages).toHaveLength(1);
    expect(body.section.pagesTotal).toBe(2);
    expect(body.section.pagesReturned).toBe(1);
    expect(body.section.nextOffset).toBe(1);
  });

  it('offset past the end → empty page slice, no nextOffset', () => {
    const payload = makePayload();
    const body = shapeOutlineResponse(
      payload,
      { section: 'agent-insights', offset: 10, limit: 50 },
      'engineering',
    ) as { section: { pages: unknown[]; pagesReturned: number; nextOffset?: number } };
    expect(body.section.pages).toHaveLength(0);
    expect(body.section.pagesReturned).toBe(0);
    expect(body.section.nextOffset).toBeUndefined();
  });

  it('limit above the max is clamped, not rejected', () => {
    const payload = makePayload();
    const body = shapeOutlineResponse(
      payload,
      { section: 'agent-insights', limit: 100000 },
      'engineering',
    ) as { section: { pagesReturned: number } };
    // Only 2 pages exist in the fixture section — clamping never removes real data.
    expect(body.section.pagesReturned).toBe(2);
  });
});
