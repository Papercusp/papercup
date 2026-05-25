/**
 * /users/github/[id] — numeric canonical route for user profile.
 *
 * Plan: papercusp-dogfood-phase8 P-072e + D-028.
 *
 * Shell wiring — data fetch is a follow-up. For now renders an
 * "unknown user" stub when no profile is available; the real
 * implementation will resolve `params.id` through PG (contributors
 * + harness_features + contributor_usage_events) and pass the
 * assembled UserProfileData.
 */

import { UserProfile, type UserProfileData } from './UserProfile';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

function emptyProfile(github_user_id: number): UserProfileData {
  return {
    github_user_id,
    github_login: `user-${github_user_id}`,
    display_name: null,
    avatar_url: null,
    binding_status: 'unverified',
    harnesses: [],
    recent_activity: [],
    claimed_harnesses: [],
  };
}

export default async function UserProfilePage({ params }: PageProps) {
  const { id } = await params;
  const numericId = parseInt(id, 10);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return (
      <div style={{ padding: 32 }}>
        <p>Invalid user id: {id}</p>
      </div>
    );
  }
  // TODO follow-up: replace with real resolution via PG + privacy filter (Q-2).
  const data = emptyProfile(numericId);
  return <UserProfile data={data} />;
}
