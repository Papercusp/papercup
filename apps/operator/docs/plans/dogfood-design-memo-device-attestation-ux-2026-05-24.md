---
title: Papercusp dogfood — design memo — device attestation UX
slug: dogfood-design-memo-device-attestation-ux-2026-05-24
created: 2026-05-24
updated: 2026-05-25
status: ready
---

# Design memo — device attestation UX

> One of three design memos required before Phase 1b implementation begins. Sibling memos: `dogfood-design-memo-two-channel-binding-ux-2026-05-24.md`, `dogfood-design-memo-binding-service-api-2026-05-24.md`.
>
> **Note on location:** this memo lives in `apps/operator/docs/plans/` for now so it stays discoverable alongside the rest of the dogfood corpus. When picked up for implementation, move to `apps/operator/content/internal-docs/design/dogfood-device-attestation.mdx` and convert frontmatter to fumadocs/Starlight format.

## Now

**State:** draft for review. Covers the user-facing flow for §0.2 device binding via GitHub-Gist attestation (D-001 in v5).

**Next action:** user reviews; on accept, gets promoted to a D-decision in `papercusp-dogfood-phase1b-oauth-clone-attestation-2026-05-24.md`.

## Background

§0.2 of v5 specifies the device-binding mechanism: each device generates an Ed25519 keypair, stores it in the OS keychain, then publishes a public gist in the user's GitHub account that contains the device pubkey. Peers verify by fetching the gist and confirming `gist.owner.id == claimed github_user_id`. This memo covers the **user-facing flow** that makes this work without scaring users away in the first 30 seconds.

The flow fires:
- On first use of a new device (most common).
- On joining the first shared harness (deferred from "first use" — many users will create private harnesses first, never hitting attestation, then hit it the day they paste a harness link).
- On user-requested device rotation (rare; advanced setting).

## Design

### Entry point: where does the user first see attestation?

**Not on first app launch.** Attestation requires GitHub OAuth which requires both `gist` and `read:user` scopes. Asking for those on first launch — before the user has done anything — is high-friction and the wrong moment. The user is still evaluating whether to use Papercusp at all.

**Defer to the first shared-harness join.** Specifically: step 1 of Entry 4 (`papercusp://harness?...` link paste). The user has already decided to join a shared harness; OAuth + attestation is the obvious cost. Surface as a modal in the join flow, not a settings detour.

### The modal — three screens

**Screen 1 — "Set up your Papercusp identity"** (the why)

> To join shared harnesses, Papercusp needs to bind this device to your GitHub identity. This lets other contributors verify that commits and reviews are really from you.
>
> Papercusp will:
> 1. Generate a signing key on this device (stored in your OS keychain — never leaves this machine).
> 2. Open GitHub to authorize Papercusp with two permissions: `read:user` (so we can read your GitHub username) and `gist` (so we can publish a small public gist containing this device's public key).
> 3. The gist contains your device's public key. Anyone joining a Papercusp harness with you can verify the gist proves this device is yours.
>
> [Continue]  [Learn more (opens GitHub doc)]  [Cancel]

**Why this copy:** explains the asymmetry that makes the design work (only the real GitHub account holder can publish gists in their account) without using the words "asymmetric trust." A user who reads it understands the gesture; a user who skims sees "GitHub identity" + "device" + "two permissions" and clicks Continue.

**Screen 2 — OAuth completion** (the action)

Browser opens to GitHub's OAuth consent page. The modal in Papercusp shows:

> Waiting for GitHub authorization…
>
> [Open GitHub again]  [Cancel]

After OAuth completes (the operator listens on a loopback callback per existing OAuth pattern), the modal updates to:

> ✓ Authorized as `@<github_login>`. Publishing device binding to GitHub…

**Screen 3 — Confirmation** (the trust gesture)

> ✓ Device "alice-macbook-pro" bound to `@<github_login>`.
>
> Gist published: `https://gist.github.com/<github_login>/<gist_id>`.
>
> Other Papercusp contributors will verify this gist when they see your activity. You can delete the gist at any time to revoke this device (Settings → Identity).
>
> [Continue to join harness]

The gist URL is **prominent and clickable** — clicking opens GitHub so the user can verify with their own eyes what was published. This is the trust-building moment; do not hide it.

### Default device label

`<system-hostname>-<system-username>` if both are available; fall back to `<system-hostname>`; fall back to `papercusp-<random-6-char>`. User can edit before publishing.

### Error states

| Error | Copy |
|---|---|
| User declined `gist` scope in OAuth (granted `read:user` only) | "Papercusp needs the `gist` permission to publish your device binding. [Try again]" — re-prompts OAuth with explicit scope request. |
| GitHub API down at publish time | "Couldn't reach GitHub to publish the device binding. We saved your device key locally; we'll retry when GitHub comes back. [Retry now]" |
| Gist creation succeeded but Hyperbee row write failed | "Saved to GitHub but couldn't sync with Papercusp's local store. This is unexpected — please report. [Open report]" — should never happen; if it does it's a bug. |
| Existing device on this machine (re-attestation request) | "This device is already bound as `<existing label>`. Rebinding will revoke the old key. [Continue]  [Cancel]" |

### Revocation flow

Settings → Identity surfaces:
- This device's binding (label, pubkey-short, gist URL link, "rotate"/"revoke" buttons).
- Other devices bound to my GitHub identity (read-only list, with "revoke" gated by current device).

Revoke fires: delete the gist via Octokit; emit a Hyperbee `revoked_pubkeys` event; remove from local keychain.

Note: GitHub gist deletion is **not instant from peers' view** — peers' 24h cache of the verification will continue trusting the old gist URL until it expires. Spec the staleness window in the revoke confirmation:

> Revoking this device deletes the gist immediately. Other contributors who have already verified this device may continue trusting it for up to 24 hours (their local cache). For urgent revocation (compromised device), also rotate your GitHub OAuth token at https://github.com/settings/tokens.

### Multi-device cross-trust

When the user binds a *second* device under the same GitHub identity, peers see two gists for the same `github_user_id`. v5 §0.2 step 5-6 says new devices for a trusted human are auto-trusted (the OAuth + gist combination is the trust gesture). The UI on the second device should make this clear:

> ✓ Device "alice-laptop" bound to `@<github_login>`.
>
> This is your 2nd device on this GitHub account. Other Papercusp contributors who trust @<github_login> will auto-trust this device (no extra approval needed).

This screen is shown only on second-device-binding-onward; first device shows the Screen 3 copy above.

## Decisions (proposed; promote to v5 / Phase 1b D-NNN on accept)

### D-A — Defer attestation to first shared-harness join

Do not prompt on first app launch. Only fires when the user pastes a harness link.

### D-B — Make the gist URL prominent on success

Confirmation screen shows the gist URL as a clickable link, encouraging the user to verify with their own eyes. Trust-building > UI tidiness.

### D-C — Auto-trust for additional devices under the same GitHub identity

When the second device's gist appears for the same `github_user_id`, peers auto-trust per §0.2 step 5-6. UI on the second device explains this so users understand they don't need to re-trust.

### D-D — Revocation copy explicitly mentions the 24h cache staleness

Don't hide the cache window — the user needs to know that "revoke" is fast for new joiners but slow for existing ones, and that rotating the OAuth token is the harder gesture for compromised-device scenarios.

## Open questions

### Q-1 — Should the OAuth scope request be one-shot or progressive?

One-shot: ask for both `read:user` and `gist` up front. Progressive: ask for `read:user` first (lower friction), then `gist` only when actually publishing. Suggested: one-shot. Two OAuth round-trips for one binding gesture is worse UX than one consent screen with two checkboxes.

### Q-2 — Where does the per-harness Contributors tab show the device's gist URL?

§9.2 Contributors row includes "devices section (collapsed by default)" per v5. Each device entry shows `device_pubkey + machine label + attestation gist URL (link out)`. Confirmed by addendum 3.

### Q-3 — What happens if the user revokes a device that is currently the only device for that identity?

Two options: (a) refuse — "you must bind another device first"; (b) allow but warn — "you'll lose access to all your shared harnesses until you re-bind from another device." Suggested: (b) with prominent warning, because (a) is paternalistic and someone with a compromised device may genuinely want to revoke immediately even at the cost of being locked out.

## Cross-references

- `papercusp-dogfood-phase1b-oauth-clone-attestation-2026-05-24.md` — implements this memo via P-011.
- `papercusp-dogfood-v5-2026-05-23.md` — §0.2 device binding, D-001.
- Sibling memos: `dogfood-design-memo-two-channel-binding-ux-2026-05-24.md` (the second-channel verifier UX), `dogfood-design-memo-binding-service-api-2026-05-24.md` (the binding service API).

## For the implementing agent

When P-011 implementation begins:
- Convert this memo to `apps/operator/content/internal-docs/design/dogfood-device-attestation.mdx`.
- Promote the four D-A through D-D decisions into the Phase 1b plan's `## Decisions` section.
- The three-screen modal flow is the primary UX surface; build it as `apps/operator/app/_components/AttestationWizard.tsx` (new) and wire into the Entry 4 join flow from Phase 1b P-009.
