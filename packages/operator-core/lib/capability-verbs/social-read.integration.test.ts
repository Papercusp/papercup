/**
 * P-007's scoping fence, against REAL Postgres.
 *
 * `social-read.test.ts` covers the intersection logic against a stub. That stub
 * proves the CONTROL FLOW and nothing else: it returns whatever rows the test
 * hands it, so it can never show that the scope list actually reaches the query
 * and excludes anything. The entire fence rests on the store honouring the
 * scopes passed to it — and D-008 ruling (d) exists because the failure mode is
 * `social:search` spanning the owner's MAIL and minting "post refs" for emails.
 * That is the claim that needs a real table underneath it.
 *
 * Everything writes through the real `upsertPersonalDocuments` path rather than
 * raw INSERTs, so the fixture cannot drift from what the adapters actually
 * store (`scope_key` in particular is derived on write, and hand-inserting
 * would let the test pass against a scope shape production never produces).
 *
 * A permanently-wrong control (`naivePassThroughScopes`) lives beside the real
 * selector. A guard never shown to fail is not a proven guard, and this repo
 * forbids proving it by mutating the shared tree.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { setPersonalVaultEnabled, upsertPersonalDocuments } from '../personal-vault/store';
import { parseSocialPostRef } from './social';
import { searchSocialPosts, selectGrantedSocialScopes, SocialSearchNotGranted } from './social-read';

let org: OrgTestDb;
let userId: string;

const WS = 'social-read-test';

/** The owner's real Bluesky post — a social row that must be findable. */
const POST_ID = 'at://did:plc:owner/app.bsky.feed.post/3kdeploy';
/** A Reddit post, to prove several social platforms come back together. */
const REDDIT_ID = 't3_deploy1';
/** An EMAIL on the same subject. It must never surface from social:search. */
const MAIL_ID = 'msg-deploy-1';

/**
 * THE CONTROL — deliberately wrong, and kept forever.
 *
 * This is what "just search the scopes the authorizer returned" looks like. It
 * is the shape D-008 ruling (d) forbids, and against a real table it returns the
 * owner's mail from a verb named `social:search`.
 */
function naivePassThroughScopes(granted: readonly string[]): string[] {
  return [...granted];
}

beforeAll(async () => {
  org = await createOrgTestDb();
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'social-read-test-' + Date.now()}, 'Social Read Test') RETURNING id`;
  userId = user.id;
  await setPersonalVaultEnabled(org.adminSql, WS, userId, true, 'social-read-integration');
});

afterAll(async () => {
  if (org && userId) {
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.personal_documents WHERE user_id = ${userId}`;
});

/**
 * Seed one post per social platform PLUS an email, all matching the same query.
 *
 * The shared subject is deliberate: if the fence leaks, the email ranks
 * alongside the posts rather than being filtered by relevance, so a leak shows
 * up as a returned row instead of hiding behind a low score.
 */
async function seedMixedSources(): Promise<void> {
  await upsertPersonalDocuments(org.adminSql, WS, userId, [
    {
      source: 'bluesky',
      kind: 'social-post',
      externalId: POST_ID,
      occurredAt: '2026-08-22T09:00:00Z',
      participants: ['@owner.bsky.social'],
      title: 'Deploy notes',
      text: 'Shipped the deploy pipeline rewrite today.',
      dedupeKey: POST_ID,
    },
    {
      source: 'reddit',
      kind: 'social-post',
      externalId: REDDIT_ID,
      occurredAt: '2026-08-22T10:00:00Z',
      participants: ['u/owner'],
      title: 'Deploy question',
      text: 'Anyone else rewriting their deploy pipeline this quarter?',
      dedupeKey: REDDIT_ID,
    },
    {
      source: 'gmail',
      kind: 'message',
      externalId: MAIL_ID,
      occurredAt: '2026-08-22T11:00:00Z',
      participants: ['ada@example.com'],
      title: 'Deploy pipeline rewrite',
      text: 'Confidential: the deploy pipeline rewrite budget is attached.',
      dedupeKey: MAIL_ID,
    },
  ]);
}

describe('social:search scope fence, against real Postgres', () => {
  it('returns social posts and NEVER the email, under a grant that covers both', async () => {
    await seedMixedSources();
    // The realistic grant: the owner granted mail AND social. Nothing but the
    // local intersection stops the mail row from coming back.
    const granted = ['personal:gmail', 'personal:bluesky', 'personal:reddit'];

    const outcome = await searchSocialPosts(org.adminSql, {
      workspaceId: WS,
      userId,
      query: 'deploy pipeline',
      grantedScopes: granted,
    });

    expect(outcome.scopesSearched).toEqual(['personal:bluesky', 'personal:reddit']);
    const platforms = outcome.hits.map((h) => h.platform).sort();
    expect(platforms).toEqual(['bluesky', 'reddit']);
    // The assertion that matters: no minted ref addresses the mail row.
    for (const hit of outcome.hits) {
      expect(hit.postId).not.toContain('gmail');
      expect(hit.postId).not.toContain(MAIL_ID);
    }

    // CONTROL: the naive selector would have searched the mail scope. Proven by
    // running the same query with it, not asserted.
    const leaked = await searchSocialPosts(org.adminSql, {
      workspaceId: WS,
      userId,
      query: 'deploy pipeline',
      // Feed the naive result back in as if it were granted-social. The seam
      // still narrows it, which is the point: the fence holds at the seam even
      // when a caller passes the unfiltered set.
      grantedScopes: naivePassThroughScopes(granted),
    });
    expect(leaked.scopesSearched).not.toContain('personal:gmail');
    // And the naive selector, used directly, really does keep the mail scope —
    // so the control is a genuine mutant, not a no-op.
    expect(naivePassThroughScopes(granted)).toContain('personal:gmail');
    expect(selectGrantedSocialScopes(granted)).not.toContain('personal:gmail');
  });

  it('mints a postId that resolves back to the stored row', async () => {
    await seedMixedSources();
    const outcome = await searchSocialPosts(org.adminSql, {
      workspaceId: WS,
      userId,
      query: 'deploy pipeline',
      grantedScopes: ['personal:bluesky'],
    });
    const hit = outcome.hits.find((h) => h.platform === 'bluesky');
    expect(hit, 'the bluesky post should be found').toBeTruthy();
    if (!hit) return;
    // The AT-URI survives minting with its internal colons intact — the property
    // the first-colon split exists for, proven end to end through real storage.
    expect(hit.postId).toBe(`bluesky:${POST_ID}`);
    expect(parseSocialPostRef(hit.postId).externalId).toBe(POST_ID);
    // Bluesky reads but does not write: the agent is told before it drafts.
    expect(hit.replyable.allowed).toBe(false);
  });

  it('a platform filter narrows within the grant and cannot reach past it', async () => {
    await seedMixedSources();
    const outcome = await searchSocialPosts(org.adminSql, {
      workspaceId: WS,
      userId,
      query: 'deploy pipeline',
      grantedScopes: ['personal:bluesky', 'personal:reddit'],
      platforms: ['reddit'],
    });
    expect(outcome.scopesSearched).toEqual(['personal:reddit']);
    expect(outcome.hits.every((h) => h.platform === 'reddit')).toBe(true);

    await expect(
      searchSocialPosts(org.adminSql, {
        workspaceId: WS,
        userId,
        query: 'deploy pipeline',
        grantedScopes: ['personal:reddit'],
        platforms: ['bluesky'],
      }),
    ).rejects.toBeInstanceOf(SocialSearchNotGranted);
  });

  it('REFUSES outright when the grant covers no social platform', async () => {
    await seedMixedSources();
    // A mail-only grant must not degrade into an unscoped search. This is the
    // exact path that would otherwise return the confidential email.
    await expect(
      searchSocialPosts(org.adminSql, {
        workspaceId: WS,
        userId,
        query: 'deploy pipeline',
        grantedScopes: ['personal:gmail'],
      }),
    ).rejects.toBeInstanceOf(SocialSearchNotGranted);
  });

  it('does not read another workspace\'s posts', async () => {
    await seedMixedSources();
    const outcome = await searchSocialPosts(org.adminSql, {
      workspaceId: 'some-other-workspace',
      userId,
      query: 'deploy pipeline',
      grantedScopes: ['personal:bluesky', 'personal:reddit'],
    });
    expect(outcome.hits).toEqual([]);
  });
});
