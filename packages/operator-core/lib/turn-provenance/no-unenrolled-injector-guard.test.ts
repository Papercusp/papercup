/** Regression guard for the source-level machine-turn enrollment checker. */
import { describe, expect, it } from 'vitest';
// @ts-ignore — pure JS lint module; imported for its source predicate.
import { ALLOWLIST, findTurnInjectionSites } from '../../../../scripts/check-no-unenrolled-injector.mjs';

function sites(source: string) {
  return findTurnInjectionSites(source, 'subject.ts') as Array<{
    enrolled: boolean;
    mode: string;
    dataText: string;
  }>;
}

describe('no-unenrolled-injector guard predicate (EI-21903660573830465)', () => {
  it('recognizes the enrollment helper on the exact transported payload', () => {
    const found = sites(`
      async function send(raw: string) {
        const tagged = await tagTurnForInjection({ sid: owner, origin: 'fleet-kickoff', text: raw });
        await injectIntoHost(sock, { mode: 'turn', data: tagged.taggedText, ownerId: owner });
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ enrolled: true, mode: 'turn', dataText: 'tagged.taggedText' });
  });

  it('flags an untagged payload even when the same function tags unrelated text', () => {
    // Distinguishing negative control: file-level/helper-presence checks would pass
    // this source even though the delivered `raw` value is never enrolled.
    const found = sites(`
      async function send(raw: string) {
        await tagTurnForInjection({ sid: owner, origin: 'fleet-kickoff', text: 'diagnostic only' });
        await injectIntoHost(sock, { mode: 'turn', data: raw, ownerId: owner });
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]?.enrolled).toBe(false);
  });

  it('follows a tagged payload through the transport options object', () => {
    const found = sites(`
      async function send(raw: string) {
        const tagged = await tagWakeText(raw);
        const injectMsg = { mode: 'carry-respawn', data: tagged, ownerId: owner };
        await injectPsuHost(sock, injectMsg);
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ enrolled: true, mode: 'carry-respawn' });
  });

  it('recognizes enrollment carried through a branded helper parameter and nested closure', () => {
    const found = sites(`
      declare const enrolled: unique symbol;
      type EnrolledWakeText = string & { readonly [enrolled]: true };
      function injectWake(warmText: EnrolledWakeText) {
        const injectWarm = () => injectIntoHost(sock, { mode: 'turn', data: warmText });
        return injectWarm();
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ enrolled: true, dataText: 'warmText' });
  });

  it('does not trust a raw string parameter just because it crosses the same helper boundary', () => {
    const found = sites(`
      function injectWake(warmText: string) {
        const injectWarm = () => injectIntoHost(sock, { mode: 'turn', data: warmText });
        return injectWarm();
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]?.enrolled).toBe(false);
  });

  it('resolves shorthand data after the local variable is enrolled', () => {
    const found = sites(`
      async function send(raw: string) {
        let data = raw;
        data = (await tagTurnForInjection({ sid: owner, origin: 'wake-pump', text: raw })).taggedText;
        await injectIntoHost(sock, { mode: 'turn', data });
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ enrolled: true, dataText: 'data' });
  });

  it('keeps only exact, reasoned owner-authored pass-through exceptions', () => {
    expect(ALLOWLIST.size).toBe(3);
    for (const reason of ALLOWLIST.values()) expect(reason.trim().length).toBeGreaterThan(0);
  });

  it('ignores non-prompt transport modes', () => {
    expect(
      sites(`function sendControl() { injectIntoHost(sock, { mode: 'raw', data: '\\u001b' }); }`),
    ).toEqual([]);
  });

  it('does not treat comments as enrollment evidence', () => {
    const found = sites(`
      async function send(raw: string) {
        // tagTurnForInjection({ sid, origin, text: raw }) was considered here.
        await injectIntoHost(sock, { mode: 'turn', data: raw });
      }
    `);
    expect(found[0]?.enrolled).toBe(false);
  });
});
