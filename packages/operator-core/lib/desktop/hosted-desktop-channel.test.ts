import { describe, expect, it } from 'vitest';
import {
  HOSTED_DESKTOP_USERS,
  HostedDesktopEndpointError,
  assertLoopbackDesktopEndpoint,
  desktopViewersHold,
  hostedDesktopGrant,
  type HostedDesktopAttachment,
} from './hosted-desktop-channel';
import {
  DEFAULT_DESKTOP_LIFECYCLE_POLICY,
  DESKTOP_LIFECYCLE_POLICY,
  DESKTOP_VIEWER_HEARTBEAT_DIVISOR,
  desktopViewerHeartbeatMs,
  type DesktopLifecyclePolicy,
} from './desktop-lifecycle';
import { KASMVNC_CONTROL_USER, KASMVNC_LOOPBACK_INTERFACE, KASMVNC_VIEW_USER } from './x-server-backend';

const credentials = {
  view: { user: KASMVNC_VIEW_USER, secret: 'view-secret-aaa' },
  control: { user: KASMVNC_CONTROL_USER, secret: 'control-secret-bbb' },
};

describe('hostedDesktopGrant', () => {
  it('maps observer to the view-only user with input refused', () => {
    const grant = hostedDesktopGrant('observer', credentials);
    expect(grant.action).toBe('watch');
    expect(grant.user).toBe(KASMVNC_VIEW_USER);
    expect(grant.secret).toBe('view-secret-aaa');
    expect(grant.inputAllowed).toBe(false);
    expect(grant.auditAction).toBe('desktop_watch_started');
  });

  it('maps controller to the control user with input allowed', () => {
    const grant = hostedDesktopGrant('controller', credentials);
    expect(grant.action).toBe('takeover');
    expect(grant.user).toBe(KASMVNC_CONTROL_USER);
    expect(grant.secret).toBe('control-secret-bbb');
    expect(grant.inputAllowed).toBe(true);
    expect(grant.auditAction).toBe('desktop_takeover_started');
  });

  /**
   * The privilege boundary of the whole hosted viewer. A watcher's grant must not
   * carry the control secret ANYWHERE — not in an unread field, not nested. This
   * asserts over the serialised value rather than named properties, so a future
   * field that happens to carry the secret through fails here rather than shipping.
   */
  it('never lets the control secret appear anywhere in an observer grant', () => {
    const grant = hostedDesktopGrant('observer', credentials);
    expect(JSON.stringify(grant)).not.toContain('control-secret-bbb');
    expect(Object.values(grant)).not.toContain(credentials.control.secret);
  });

  it('never lets the view secret stand in for control access', () => {
    const grant = hostedDesktopGrant('controller', credentials);
    expect(JSON.stringify(grant)).not.toContain('view-secret-aaa');
  });

  it('exposes the two kasmvncpasswd users under their product-facing names', () => {
    expect(HOSTED_DESKTOP_USERS.watch).toBe(KASMVNC_VIEW_USER);
    expect(HOSTED_DESKTOP_USERS.takeover).toBe(KASMVNC_CONTROL_USER);
    expect(HOSTED_DESKTOP_USERS.watch).not.toBe(HOSTED_DESKTOP_USERS.takeover);
  });
});

describe('assertLoopbackDesktopEndpoint', () => {
  it('accepts the loopback endpoint the kasmvnc backend publishes', () => {
    expect(assertLoopbackDesktopEndpoint({ host: KASMVNC_LOOPBACK_INTERFACE, port: 6901 })).toEqual({
      host: KASMVNC_LOOPBACK_INTERFACE,
      port: 6901,
    });
  });

  it.each(['0.0.0.0', '10.0.0.4', '::', 'workspace-host.internal', 'localhost'])(
    'refuses to dial non-loopback host %s',
    (host) => {
      try {
        assertLoopbackDesktopEndpoint({ host, port: 6901 });
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(HostedDesktopEndpointError);
        expect((error as HostedDesktopEndpointError).code).toBe('endpoint_not_loopback');
      }
    },
  );

  it('reports an absent endpoint distinctly from a wrong one', () => {
    try {
      assertLoopbackDesktopEndpoint(null);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as HostedDesktopEndpointError).code).toBe('endpoint_absent');
    }
  });

  it.each([0, -1, 1.5, 70_000])('rejects invalid port %s', (port) => {
    try {
      assertLoopbackDesktopEndpoint({ host: KASMVNC_LOOPBACK_INTERFACE, port });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as HostedDesktopEndpointError).code).toBe('endpoint_port_invalid');
    }
  });
});

describe('desktopViewerHeartbeatMs', () => {
  it('fits at least the required number of beats inside every idle window', () => {
    const interval = desktopViewerHeartbeatMs();
    const windows = [...Object.values(DESKTOP_LIFECYCLE_POLICY), DEFAULT_DESKTOP_LIFECYCLE_POLICY];
    for (const policy of windows) {
      expect(policy.idleAfterSec * 1000).toBeGreaterThanOrEqual(interval * DESKTOP_VIEWER_HEARTBEAT_DIVISOR);
    }
  });

  /**
   * Falsifiability: the value must be DERIVED from the policy table, not a constant
   * that happens to equal today's answer. Shrinking the shortest idle window must
   * shrink the interval; a hardcoded return would survive the test above but fails
   * this one.
   */
  it('tracks the policy table when the shortest idle window changes', () => {
    const tighter: Record<string, DesktopLifecyclePolicy> = {
      onlyKind: { idleAfterSec: 60, freezeAfterSec: 3600, reapAfterFrozenSec: 7200 },
    };
    const fallback: DesktopLifecyclePolicy = { idleAfterSec: 600, freezeAfterSec: 3600, reapAfterFrozenSec: 7200 };
    expect(desktopViewerHeartbeatMs(tighter, fallback)).toBe((60 * 1000) / DESKTOP_VIEWER_HEARTBEAT_DIVISOR);
    expect(desktopViewerHeartbeatMs(tighter, fallback)).toBeLessThan(desktopViewerHeartbeatMs());
  });

  it('takes the minimum across kinds AND the conservative fallback', () => {
    const policy: Record<string, DesktopLifecyclePolicy> = {
      slow: { idleAfterSec: 1800, freezeAfterSec: 3600, reapAfterFrozenSec: 7200 },
    };
    const fastFallback: DesktopLifecyclePolicy = { idleAfterSec: 120, freezeAfterSec: 3600, reapAfterFrozenSec: 7200 };
    expect(desktopViewerHeartbeatMs(policy, fastFallback)).toBe((120 * 1000) / DESKTOP_VIEWER_HEARTBEAT_DIVISOR);
  });
});

describe('desktopViewersHold', () => {
  const attachment = (channelId: string): HostedDesktopAttachment => ({
    channelId,
    desktopSessionId: 'ds-1',
    action: 'watch',
    endpoint: { host: KASMVNC_LOOPBACK_INTERFACE, port: 6901 },
  });

  it('holds while any viewer is attached', () => {
    expect(desktopViewersHold(new Map([['a', attachment('a')]]))).toBe(true);
  });

  it('keeps holding when one of two tabs detaches', () => {
    const attached = new Map([
      ['a', attachment('a')],
      ['b', attachment('b')],
    ]);
    attached.delete('a');
    expect(desktopViewersHold(attached)).toBe(true);
  });

  it('releases only when the last viewer detaches', () => {
    expect(desktopViewersHold(new Map())).toBe(false);
  });
});
