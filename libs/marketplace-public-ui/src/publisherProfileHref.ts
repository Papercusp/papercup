/**
 * publisherProfileHref — P-072f.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 *
 * The marketplace `publishedBy` field is a GitHub *login*. Per P-072f the
 * publisher link target switches from a GitHub-direct profile URL to the
 * in-app Papercusp profile page. The profile route is keyed on the numeric
 * github_user_id (`/users/github/<id>`); the `/users/<login>` username
 * route redirects login → numeric, so linking by login is sufficient and
 * avoids a per-card id lookup.
 *
 * PURE so it's trivially unit-testable. The GitHub link itself is NOT
 * removed from the product — it stays in the user-profile header
 * (UserProfile.tsx), which is where "go to their GitHub" now lives.
 */

/** Build the Papercusp profile href for a publisher's GitHub login. */
export function publisherProfileHref(login: string): string {
  return `/users/${encodeURIComponent(login)}`;
}
