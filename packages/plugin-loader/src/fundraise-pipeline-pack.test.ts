/**
 * Acceptance for the fundraise-pipeline trigger pack
 * (fundraise-automation-2026-08-23 P-004..P-008).
 *
 * The starter-pack suite next door is parameterized over three one-target packs and asserts a
 * rigid single-binding shape. This pack is the first multi-target, edge-stitched one, so it gets
 * its own acceptance rather than loosening that suite's shape assertions — which are load-bearing
 * for the packs they cover.
 *
 * The most important test here is `cannot send mail`. The pack's no-auto-send property is a
 * consequence of the OAuth scopes it requests, not of the plan text asking nicely, and a future
 * edit that adds `gmail.send` to make some flow "work end to end" would silently convert every
 * draft path into a send path. That edit must fail a test, loudly, with a reason.
 */
import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { loadPluginFromDir } from './index';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACK_DIR = resolve(REPO_ROOT, 'libs/papercusp/plugins/fundraise-pipeline');

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function loadPack() {
  const result = await loadPluginFromDir(PACK_DIR, 'global');
  expect('error' in result ? result.error : null).toBeNull();
  expect('skipped' in result ? result.skipped : null).toBeNull();
  if (!('plugin' in result)) throw new Error('pack failed to load');
  return result;
}

describe('fundraise-pipeline trigger pack', () => {
  it('loads as a manifest-only plugin with the declared graph', async () => {
    const result = await loadPack();
    expect((result.plugin as unknown as { __runtime?: string }).__runtime).toBe('manifest-only');

    const pack = result.triggerPack;
    expect(pack).toBeTruthy();
    expect(pack?.targets.map((t) => t.id).sort()).toEqual([
      'classify-and-draft-reply',
      'fund-research-brief',
      'investor-meeting-prep',
      'no-reply-follow-up',
      'post-meeting-followup',
    ]);
    expect(pack?.bindings.map((b) => b.id).sort()).toEqual([
      'follow-up-ladder',
      'investor-reply-to-pipeline',
      'meeting-to-investor-prep',
      'meeting-to-post-followup',
      'research-enrichment',
    ]);
  });

  it('cannot send mail: no send scope is requested anywhere in the manifest', async () => {
    const result = await loadPack();
    const declared = result.plugin.oauth?.flatMap((entry) => entry.scopes ?? []) ?? [];
    const inline = Object.values(object(object(result.plugin.configSchema).properties))
      .flatMap((field) => {
        const scopes = object(object(field).oauth).scopes;
        return Array.isArray(scopes) ? (scopes as string[]) : [];
      });

    expect(declared.length).toBeGreaterThan(0);
    for (const scope of [...declared, ...inline]) {
      expect(scope).not.toContain('gmail.send');
      expect(scope).not.toContain('mail.google.com');
    }
    // compose is what makes drafting possible, and is the boundary we intend to sit at.
    expect(declared).toContain('https://www.googleapis.com/auth/gmail.compose');
  });

  it('every plan ends at a draft, never a send', () => {
    const planFiles = [
      'plan-classify-reply.md',
      'plan-follow-up.md',
      'plan-meeting-prep.md',
      'plan-post-meeting.md',
      'plan-fund-research.md',
    ];
    for (const file of planFiles) {
      const path = resolve(PACK_DIR, file);
      expect(existsSync(path), `${file} is declared by the manifest and must exist`).toBe(true);
      const body = readFileSync(path, 'utf8');
      expect(body).not.toMatch(/gmail:send|gmail:send-message|sendMessage\(/);
    }
  });

  it('declares every plan target path on disk as a safe relative .md file', async () => {
    const result = await loadPack();
    for (const target of result.triggerPack?.targets ?? []) {
      expect(target.kind).toBe('plan');
      if (target.kind !== 'plan') continue;
      expect(target.path).toMatch(/^[a-z0-9-]+\.md$/);
      expect(existsSync(resolve(PACK_DIR, target.path))).toBe(true);
    }
  });

  it('uses no schedule-source binding, which has no runtime consumer', async () => {
    const result = await loadPack();
    for (const binding of result.triggerPack?.bindings ?? []) {
      expect(binding.source.kind).not.toBe('schedule');
    }
  });

  it('gives every internal binding an incoming correlation-preserving edge', async () => {
    const result = await loadPack();
    const pack = result.triggerPack;
    const internal = (pack?.bindings ?? []).filter((b) => b.source.kind === 'internal');
    expect(internal.length).toBeGreaterThan(0);
    for (const binding of internal) {
      const incoming = (pack?.edges ?? []).filter((e) => e.to === binding.id);
      expect(incoming.length).toBeGreaterThan(0);
      for (const edge of incoming) {
        expect(edge.correlation).toBe('inherit');
        expect(edge.event).toBe(
          (binding.source as { kind: 'internal'; event: string }).event,
        );
      }
    }
  });

  it('binds plan targets to canonical registry datatypes rather than pack-local shapes', async () => {
    const result = await loadPack();
    const seen = new Set<string>();
    for (const target of result.triggerPack?.targets ?? []) {
      if (target.kind !== 'plan') continue;
      const props = object(target.inputSchema.properties);
      const trigger = object(object(props.trigger).properties);
      const payloadDatatype = object(trigger.payload).datatype;
      if (typeof payloadDatatype === 'string') seen.add(payloadDatatype);
      const dealDatatype = object(props.deal).datatype;
      if (typeof dealDatatype === 'string') seen.add(dealDatatype);
    }
    expect([...seen].sort()).toEqual(['calendar-event', 'email-message', 'pipeline-deal']);
  });

  it('bounds the follow-up ladder so outreach cannot become unbounded', async () => {
    const result = await loadPack();
    const inputs = object(result.triggerPack?.inputs);
    const maxFollowUps = object(object(inputs.properties).maxFollowUps);
    expect(maxFollowUps.maximum).toBe(4);
    expect(maxFollowUps.default).toBe(2);

    const target = result.triggerPack?.targets.find((t) => t.id === 'no-reply-follow-up');
    expect(target?.kind).toBe('plan');
    if (target?.kind !== 'plan') return;
    const ladder = object(object(target.inputSchema.properties).maxFollowUps);
    expect(ladder.maximum).toBe(4);
  });

  it('declares a storm policy on the pack and on the broad inbound-mail binding', async () => {
    const result = await loadPack();
    expect(Number(result.triggerPack?.defaultStormPolicy?.maxRuns)).toBeGreaterThan(0);
    expect(Number(result.triggerPack?.defaultStormPolicy?.windowSeconds)).toBeGreaterThan(0);
    const inbound = result.triggerPack?.bindings.find(
      (b) => b.id === 'investor-reply-to-pipeline',
    );
    expect(Number(inbound?.stormPolicy?.maxRuns)).toBeGreaterThan(0);
  });

  it('ships every binding disarmed', async () => {
    const result = await loadPack();
    expect(result.triggerPack?.bindings.every((b) => !('armed' in b))).toBe(true);
  });
});
