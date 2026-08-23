/**
 * The egress allowlist's own behaviour (P-024).
 *
 * The static containment gate in `egress-containment.test.ts` asks a different
 * question — "does any module name a host its row does not declare?" — and it is
 * built ON this decision function. So this suite has to establish that the
 * function itself denies the things it claims to, or the gate above it is
 * measuring with a broken instrument.
 */
import { describe, expect, it } from 'vitest';
import {
  assertSocialEgressAllowed,
  normalizeEgressHost,
  socialEgressDecision,
  SocialEgressDeniedError,
} from './social-egress';
import { listSocialPlatforms } from './platform-registry';
import { aNoEgressHostPlatformId } from './platform-exemplars.fixture';

const denial = (platform: string, url: string, opts?: { connectionHost?: string }) => {
  const d = socialEgressDecision(platform, url, opts ?? {});
  if (d.allowed) throw new Error(`expected a denial, got allow via ${d.via}`);
  return d;
};

describe('fixed-host platforms', () => {
  it('allows a declared API host', () => {
    const d = socialEgressDecision('facebook-pages', 'https://graph.facebook.com/v23.0/me/feed');
    expect(d).toMatchObject({ allowed: true, host: 'graph.facebook.com', via: 'declared-api-host' });
  });

  it('refuses a PERMALINK host — declared, but declared as never-called', () => {
    // The whole point of splitting the two fields. www.facebook.com is a host
    // this platform legitimately puts in payloads; sending a page token to it
    // is a different act entirely.
    expect(denial('facebook-pages', 'https://www.facebook.com/12345').reason).toBe('host-not-declared');
  });

  it('refuses another platform’s host', () => {
    // graph.threads.net is a real declared host — for THREADS. Reaching it as
    // facebook-pages is exactly the cross-platform mistake the separate origin
    // constants exist to prevent.
    expect(denial('facebook-pages', 'https://graph.threads.net/v1.0/me').reason).toBe('host-not-declared');
  });

  it('refuses a SUBDOMAIN of a declared host', () => {
    // No suffix matching for fixed hosts: a subdomain is a host somebody else
    // may control, and every real entry is a single documented name.
    expect(denial('facebook-pages', 'https://evil.graph.facebook.com/x').reason).toBe('host-not-declared');
  });

  it('refuses a host that merely ENDS WITH a declared one', () => {
    expect(denial('facebook-pages', 'https://graph.facebook.com.attacker.test/x').reason).toBe(
      'host-not-declared',
    );
  });

  it('accepts the fully-qualified (trailing-dot) spelling of a declared host', () => {
    expect(socialEgressDecision('reddit', 'https://oauth.reddit.com./api/v1/me')).toMatchObject({
      allowed: true,
      host: 'oauth.reddit.com',
    });
  });

  it('is case-insensitive about the host', () => {
    expect(socialEgressDecision('reddit', 'https://OAuth.Reddit.COM/api/v1/me').allowed).toBe(true);
  });
});

describe('per-connection platforms', () => {
  it('refuses to decide without a connection host, rather than guessing', () => {
    expect(denial('mastodon', 'https://mastodon.test/api/v1/timelines/home').reason).toBe(
      'connection-host-required',
    );
  });

  it('allows the connection host and hosts beneath it', () => {
    expect(
      socialEgressDecision('mastodon', 'https://mastodon.test/api/v1/x', { connectionHost: 'mastodon.test' }),
    ).toMatchObject({ allowed: true, via: 'connection-host' });
    expect(
      socialEgressDecision('mastodon', 'wss://streaming.mastodon.test/api/v1/streaming', {
        connectionHost: 'mastodon.test',
      }).allowed,
    ).toBe(true);
  });

  it('refuses a host that shares a suffix without a label boundary', () => {
    expect(
      denial('mastodon', 'https://evil-mastodon.test/x', { connectionHost: 'mastodon.test' }).reason,
    ).toBe('host-not-declared');
  });

  it('refuses a connection host that is not a bare hostname', () => {
    for (const bad of ['https://mastodon.test', 'mastodon.test/api', 'mastodon.test:443', 'a@b.test']) {
      expect(denial('mastodon', 'https://mastodon.test/x', { connectionHost: bad }).reason).toBe(
        'connection-host-invalid',
      );
    }
  });

  it('refuses a loopback or IP connection host', () => {
    // Without this, `connectionHost: '127.0.0.1'` turns the per-connection
    // branch into an allow-anything branch for anything on the loopback.
    expect(denial('mastodon', 'https://127.0.0.1/x', { connectionHost: '127.0.0.1' }).reason).toBe(
      'ip-literal-host',
    );
    expect(denial('mastodon', 'https://localhost/x', { connectionHost: 'localhost' }).reason).toBe(
      'ip-literal-host',
    );
  });
});

describe('shape-level refusals that apply to every platform', () => {
  it('refuses plaintext and non-web schemes', () => {
    expect(denial('reddit', 'http://oauth.reddit.com/api').reason).toBe('forbidden-scheme');
    expect(denial('reddit', 'ws://oauth.reddit.com/api').reason).toBe('forbidden-scheme');
    expect(denial('reddit', 'file:///etc/passwd').reason).toBe('forbidden-scheme');
  });

  it('refuses userinfo, which can make a denied host read as a declared one', () => {
    const d = denial('reddit', 'https://oauth.reddit.com@attacker.test/api');
    expect(d.reason).toBe('embedded-credentials');
    // And the host it reports is the one that would actually have been reached.
    expect(d.host).toBe('attacker.test');
  });

  it('refuses literal addresses', () => {
    expect(denial('facebook-pages', 'https://169.254.169.254/latest/meta-data/').reason).toBe(
      'ip-literal-host',
    );
    expect(denial('facebook-pages', 'https://[::1]/x').reason).toBe('ip-literal-host');
  });

  it('refuses an unknown platform and an unparseable URL', () => {
    expect(denial('myspace', 'https://graph.facebook.com/x').reason).toBe('unknown-platform');
    expect(denial('reddit', 'not a url').reason).toBe('unparseable-url');
  });
});

describe('unverified rows deny everything', () => {
  // D-005's ruling applied to egress: a row nobody has checked cannot be reached
  // by accident. An empty apiHosts under hostPolicy 'fixed' is a DENY, and the
  // denial says why rather than reading as an ordinary host mismatch.
  // DERIVED, never enumerated. linkedin left this list in P-021 and tiktok in
  // P-022, each because its row became verified and declared real hosts — a
  // hardcoded list turns every such success into an unrelated test failure.
  // Keying on the PROPERTY (fixed policy, zero declared hosts) tracks the
  // registry on its own; see platform-exemplars.fixture.
  it('a platform declaring zero API hosts cannot reach anything yet', () => {
    const platform = aNoEgressHostPlatformId();
    const d = denial(platform, 'https://api.linkedin.com/v2/me');
    expect(d.reason).toBe('host-not-declared');
    expect(d.detail).toContain('declares no API hosts');
  });
});

describe('linkedin egress (P-021)', () => {
  it('allows the API host and the SEPARATE oauth host', () => {
    // The split is the point: most rows here serve both from one host, and
    // assuming that for LinkedIn silently breaks token exchange.
    expect(assertSocialEgressAllowed('linkedin', 'https://api.linkedin.com/rest/posts').hostname).toBe(
      'api.linkedin.com',
    );
    expect(
      assertSocialEgressAllowed('linkedin', 'https://www.linkedin.com/oauth/v2/accessToken').hostname,
    ).toBe('www.linkedin.com');
  });

  it('allows the media-upload URL, which is served from the API host', () => {
    // registerUpload hands back an absolute URL on api.linkedin.com rather than
    // a separate upload host — worth pinning, because a separate upload host is
    // the shape several sibling platforms use.
    expect(
      assertSocialEgressAllowed('linkedin', 'https://api.linkedin.com/mediaUpload/C5522AQ/feedshare/0').hostname,
    ).toBe('api.linkedin.com');
  });

  it('still denies a plausible neighbour host', () => {
    // Anti-vacuity for the two allows above: the row is a FIXED allowlist, not
    // a suffix match on linkedin.com.
    expect(denial('linkedin', 'https://media.licdn-ei.com/dms/image/x').reason).toBe('host-not-declared');
    expect(denial('linkedin', 'https://evil-linkedin.com/rest/posts').reason).toBe('host-not-declared');
  });
});

describe('assertSocialEgressAllowed', () => {
  it('returns the parsed URL it checked', () => {
    const url = assertSocialEgressAllowed('threads', 'https://graph.threads.net/v1.0/me/threads');
    expect(url.hostname).toBe('graph.threads.net');
  });

  it('throws a typed error carrying the reason and host', () => {
    try {
      assertSocialEgressAllowed('threads', 'https://graph.facebook.com/v23.0/me');
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SocialEgressDeniedError);
      const denied = error as SocialEgressDeniedError;
      expect(denied.platformId).toBe('threads');
      expect(denied.reason).toBe('host-not-declared');
      expect(denied.host).toBe('graph.facebook.com');
      expect(denied.message).toMatch(/^social_egress_denied:threads:host-not-declared:/);
    }
  });
});

describe('normalizeEgressHost', () => {
  it('lowercases and drops exactly one trailing dot', () => {
    expect(normalizeEgressHost('  GRAPH.Facebook.COM. ')).toBe('graph.facebook.com');
    expect(normalizeEgressHost('graph.facebook.com')).toBe('graph.facebook.com');
  });
});

describe('the registry’s egress declarations are well-formed', () => {
  const rows = listSocialPlatforms();

  it('covers a non-trivial number of platforms', () => {
    // Anti-vacuity: every it.each below is silently green against an empty list.
    expect(rows.length).toBeGreaterThanOrEqual(7);
  });

  it.each(rows.map((r) => [r.id, r] as const))('%s declares bare, lowercase hosts', (_id, row) => {
    const all = [...row.egress.apiHosts, ...(row.egress.permalinkHosts ?? [])];
    for (const host of all) {
      expect(host, `${host} must be lowercase`).toBe(host.toLowerCase());
      expect(host, `${host} must carry no scheme, port, path or wildcard`).toMatch(
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/,
      );
    }
  });

  it.each(rows.map((r) => [r.id, r] as const))(
    '%s never declares one host as both callable and permalink-only',
    (_id, row) => {
      // Overlap would make the permalink field meaningless: the host would be
      // callable anyway, and a reader would take the separation as real.
      const api = new Set(row.egress.apiHosts);
      for (const host of row.egress.permalinkHosts ?? []) expect(api.has(host)).toBe(false);
    },
  );

  it('every VERIFIED row can actually reach something', () => {
    // The failure this catches: a row gets verified and shipped with an empty
    // fixed host list, which denies every call it is supposed to make — and
    // reads exactly like the deliberate deny-all of an unverified row.
    const verified = rows.filter((r) => r.verifiedAt);
    expect(verified.length).toBeGreaterThanOrEqual(7);
    for (const row of verified) {
      const reachable = row.egress.hostPolicy === 'per-connection' || row.egress.apiHosts.length > 0;
      expect(reachable, `${row.id} is verified but can reach no host`).toBe(true);
    }
  });
});
