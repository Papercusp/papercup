import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { publishEventToCupboard, type PublishEventDeps } from './publish-event-core';
import { writeEventPackageDir, type EventExportSource } from './event-store';

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'publish-event-'));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

// Colon-delimited on purpose: an event key is NOT a kebab slug, which is the one
// structural difference from the datatype path this suite exists to cover.
const SETTLED_KEY = 'bet:settled';

const SETTLED: EventExportSource = {
  eventKey: SETTLED_KEY,
  title: 'Bet settled',
  description: 'fires when a wager reaches a settlement outcome',
  keyPattern: 'bet:settled',
  tags: ['bet'],
};

function deps(over: Partial<PublishEventDeps> = {}): PublishEventDeps {
  return {
    listEventKeys: async () => [SETTLED],
    writePackage: (input, opts) => writeEventPackageDir(input, { ...opts, targetDir: scratch() }),
    fetchRepo: vi.fn(async () => ({ id: 42, html_url: 'https://github.com/papercup/events' })) as never,
    publish: vi.fn(async () => ({ ok: true, data: { review_status: 'pending' } })) as never,
    ...over,
  };
}

describe('publishEventToCupboard', () => {
  it('publishes under the ONE Cupboard surface as listing_kind event', async () => {
    const d = deps();
    const result = await publishEventToCupboard(
      { eventKey: SETTLED_KEY, github_url: 'https://github.com/papercup/events' },
      d,
    );
    expect(result.ok).toBe(true);
    // P-029 (D-010/D-011): one publish path, kind='event', which REVIEW_POLICY_KINDS
    // then holds at pending — an event vocabulary is moderated, never auto-approved.
    expect(d.publish).toHaveBeenCalledWith(
      expect.objectContaining({ listing_kind: 'event', github_repository_id: 42 }),
    );
  });

  it('files the listing under the SANITIZED package ref, never the raw colon key', async () => {
    // The divergence the datatype path can never see: datatype ids are already kebab
    // slugs, so its sanitizer is a no-op. An event key is colon-delimited, so
    // publishing under the requested ref would file the listing under an identity
    // that does not match the package dir it points at.
    const d = deps();
    const result = await publishEventToCupboard(
      { eventKey: SETTLED_KEY, github_url: 'https://github.com/papercup/events' },
      d,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const publishedRef = (d.publish as unknown as { mock: { calls: [{ listing_ref: string }][] } }).mock
      .calls[0][0].listing_ref;
    expect(publishedRef).toBe(result.export.ref);
    expect(publishedRef).not.toBe(SETTLED_KEY);
    expect(publishedRef).not.toContain(':');
  });

  it('resolves the definition from the injected registry, never from the package layer', async () => {
    const result = await publishEventToCupboard(
      { eventKey: 'bet:never-registered', github_url: 'https://github.com/papercup/events' },
      deps(),
    );
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it('exportOnly materializes the package without contacting the storefront', async () => {
    const d = deps();
    const result = await publishEventToCupboard(
      { eventKey: SETTLED_KEY, github_url: 'https://github.com/papercup/events', exportOnly: true },
      d,
    );
    expect(result).toMatchObject({ ok: true, exportedOnly: true });
    expect(d.publish).not.toHaveBeenCalled();
    expect(d.fetchRepo).not.toHaveBeenCalled();
  });

  it('refuses a row carrying the DERIVED half rather than dropping it silently (D-058)', async () => {
    // `EventExportSource` excludes the derived fields by TYPE, but a type is erased at
    // runtime and the manifest is built by explicit field pick — so without this guard
    // an over-full row publishes MINUS those fields, and the publisher keeps believing
    // their attestation shipped. The silent-drop is the worse failure, so it is the
    // one pinned here.
    const d = deps({
      listEventKeys: async () => [{ ...SETTLED, emitter: 'packages/operator-core/lib/x.ts' } as EventExportSource],
    });
    const result = await publishEventToCupboard(
      { eventKey: SETTLED_KEY, github_url: 'https://github.com/papercup/events' },
      d,
    );
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(d.publish).not.toHaveBeenCalled();
  });

  it('rejects a malformed github_url before writing anything', async () => {
    const result = await publishEventToCupboard({ eventKey: SETTLED_KEY, github_url: 'not-a-url' }, deps());
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});
