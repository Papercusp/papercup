/**
 * Unit tests for the per-desktop accessibility bus bootstrap (P-007 / D-010(c)).
 *
 * The interesting assertions here are all about ISOLATION, because the failure this
 * module can produce is silent: a well-formed bus address for the WRONG desktop makes
 * every consumer downstream work correctly against the operator's own session.
 */
import { describe, it, expect } from 'vitest';
import {
  busBelongsToDisplay,
  minimalSessionBusConfig,
  publishBusPropertyCommand,
  sessionBusCommand,
  A11Y_APP_ENV,
} from './a11y-bus';

describe('minimalSessionBusConfig', () => {
  it('advertises ONLY the service directory we control — the portal cascade guard', () => {
    const conf = minimalSessionBusConfig('/tmp/pc-a11y-x/services');
    expect(conf).toContain('<servicedir>/tmp/pc-a11y-x/services</servicedir>');
    // Exactly one servicedir: a second one (e.g. the system's) would readmit
    // xdg-desktop-portal, which is the measured cause of blank screenshots.
    expect(conf.match(/<servicedir>/g)).toHaveLength(1);
    expect(conf).not.toContain('/usr/share/dbus-1/services');
    expect(conf).toContain('<type>session</type>');
  });
});

describe('sessionBusCommand', () => {
  it('forks and prints the address, so the caller can pin apps to it', () => {
    const cmd = sessionBusCommand('/tmp/x/session.conf');
    expect(cmd.bin).toBe('dbus-daemon');
    expect(cmd.args).toContain('--fork');
    expect(cmd.args).toContain('--print-address');
    expect(cmd.args).toContain('--config-file=/tmp/x/session.conf');
  });
});

describe('publishBusPropertyCommand', () => {
  it('writes AT_SPI_BUS on the sandbox root so the binding is discoverable cross-process', () => {
    const cmd = publishBusPropertyCommand(':110', 'unix:path=/run/user/1000/at-spi/bus_110');
    expect(cmd.bin).toBe('xprop');
    expect(cmd.args).toEqual([
      '-display', ':110', '-root', '-f', 'AT_SPI_BUS', '8s', '-set', 'AT_SPI_BUS',
      'unix:path=/run/user/1000/at-spi/bus_110',
    ]);
  });
});

describe('busBelongsToDisplay', () => {
  it('accepts a bus named for its own display', () => {
    expect(busBelongsToDisplay('unix:path=/run/user/1000/at-spi/bus_110', ':110')).toBe(true);
  });

  it('REJECTS the host bus — the exact leak measured on the first live run', () => {
    // A desktop provisioned at :110 came back bound to bus_0 because the daemon
    // inherited DISPLAY=:0. Well-formed address, completely wrong session.
    expect(busBelongsToDisplay('unix:path=/run/user/1000/at-spi/bus_0', ':110')).toBe(false);
  });

  it('rejects any other display\'s bus, not just :0', () => {
    expect(busBelongsToDisplay('unix:path=/run/user/1000/at-spi/bus_111', ':110')).toBe(false);
  });

  it('accepts an address carrying no display suffix rather than disabling accessibility', () => {
    expect(busBelongsToDisplay('unix:abstract=/tmp/dbus-Ab12', ':110')).toBe(true);
  });

  it('refuses a malformed display instead of guessing', () => {
    expect(busBelongsToDisplay('unix:path=/run/user/1000/at-spi/bus_110', 'not-a-display')).toBe(false);
  });
});

describe('A11Y_APP_ENV', () => {
  it('is re-exported here so the provisioner has one import for the whole recipe', () => {
    expect(A11Y_APP_ENV.GTK_A11Y).toBe('atspi');
  });
});
