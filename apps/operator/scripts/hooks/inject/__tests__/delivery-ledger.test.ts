/**
 * delivery-ledger.mjs — the hook half of turn-start ACK-ON-PROOF
 * (owner-directive-delivery-redesign-2026-09-22 P-005). The end-to-end
 * "printed, then recorded" property is driven through the real CLI in
 * dispatcher.test.ts; these pin the module's own edges.
 */

import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { ledgerDir, openDeliveryLedger } = await import(path.join(HERE, '..', 'delivery-ledger.mjs'));

const home = () => ({ PAPERCUSP_HOME: mkdtempSync(path.join(tmpdir(), 'ledger-unit-')) });

describe('delivery ledger', () => {
  it('confirms only what was offered AND committed', () => {
    const env = home();
    const ledger = openDeliveryLedger('su-1', env);
    expect(ledger.confirmed()).toBeNull();
    // Commit before any offer records nothing.
    expect(ledger.commit()).toBe(false);
    ledger.offer('tok-1');
    // Offered is not proven: a fresh process still reads nothing.
    expect(openDeliveryLedger('su-1', env).confirmed()).toBeNull();
    expect(ledger.commit()).toBe(true);
    expect(openDeliveryLedger('su-1', env).confirmed()).toBe('tok-1');
  });

  it('keeps one token per session and leaves no temp file behind', () => {
    const env = home();
    const a = openDeliveryLedger('su-a', env);
    const b = openDeliveryLedger('su-b', env);
    a.offer('tok-a');
    b.offer('tok-b');
    a.commit();
    b.commit();
    expect(openDeliveryLedger('su-a', env).confirmed()).toBe('tok-a');
    expect(readdirSync(ledgerDir(env)).sort()).toEqual(['su-a.token', 'su-b.token']);
  });

  it('cannot be steered outside its directory by the session id', () => {
    const env = home();
    const ledger = openDeliveryLedger('../../escape', env);
    ledger.offer('tok-x');
    ledger.commit();
    expect(readdirSync(ledgerDir(env))).toEqual(['.._.._escape.token']);
  });

  it('opens nothing without a session id', () => {
    expect(openDeliveryLedger('', home())).toBeNull();
    expect(openDeliveryLedger(undefined, home())).toBeNull();
  });
});
