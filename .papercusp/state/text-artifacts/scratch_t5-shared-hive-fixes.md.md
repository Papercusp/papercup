---
rel_path: "scratch/t5-shared-hive-fixes.md"
updated_at: 1782163382568
_body: "content"
---

# T5 shared-hive-guide.mdx — 2 code-grounded fixes (from su-7ac18 → su-b331a)

File: `apps/operator-docs/src/content/docs/system/shared-hive-guide.mdx`

---

## FIX 1 (correctness) — §8 "Being removed (ban / revocation)"

**Problem:** the current bullet "Read access is cut off at the next re-key." reads as if re-key happens today. It does NOT — the re-key FEATURE is flag-dark / not yet enabled.

**Grounding:**
- Plan `shared-hive-rekey-2026-06-19` is status `active` but: "IMPLEMENTATION-COMPLETE + COMMITTED + REVIEWED + backbone-green ... on origin/staging ... flag-dark." (i.e. built but the flag `papercusp-hive-rekey` is OFF).
- `packages/operator-core/lib/agent-tools/hive/ban_member.ts` lines 8-11: "the C-001 re-key turns it into a READ cut-off at the next epoch ... So `revoke.live` is false until the re-key lands — the ban + rejoin-deny are effective immediately; the read cut-off follows."

**Replacement for the second bullet** (the "Read access is cut off at the next re-key." bullet):

```
- **Read access cut-off ships with re-key (not yet live).** A true read cut-off —
  where removed devices can no longer *decrypt* new content — is the re-key feature
  (`shared-hive-rekey-2026-06-19`): on removal the hive advances a key **epoch** and
  re-wraps the new key to the *remaining* members only, so the removed device has no
  key for epoch N+1. That work is **implementation-complete but flag-dark**
  (`papercusp-hive-rekey`), so until the owner enables it, `ban_member`'s
  `revoke.live` is `false` and removal is a **write-block + re-join-deny only** —
  content already shared with the member stays readable to them.
```

(Optionally tighten the summary sentence after it accordingly: "So today removal = no more writes / no re-join; the read cut-off arrives when re-key is enabled.")

---

## FIX 2 (coverage) — §2 "Share it", add the live status beacon

**Grounding:** `packages/operator-core/lib/agent-tools/hive/beacon_consent.ts` — owner-consent, DEFAULT-OFF (D-002); "only rides a PUBLISHED (public/invite) hive's re-announce — enabling it on a private hive has no effect until the hive is published."

**Drop-in Aside** (place right after the visibility table in §2):

```mdx
<Aside type="note" title="Optional: a live status beacon">
A published hive can additionally broadcast a **live status beacon** (active
agents, queue depth, focus) onto the directory gossip. It is **owner-consent,
default-OFF**: `hive:beacon_consent { hive, consent: true }` to opt in (`false`
to stop; omit `consent` to read). It only rides a **published** (public/invite)
hive — enabling it on a private hive does nothing until you publish.
</Aside>
```

**Tool-map row** to add (in the "At a glance" table, under Share):

```
| Share | Live status beacon (opt-in) | `hive:beacon_consent` |
```

---

## OPTIONAL extras (only if you want them) — exact HTTP contracts

Grounded in `packages/operator-core/lib/endpoint-route/routes/discovery/*`:

- `POST /api/discovery/set-hive` — body `{ hiveId, title?, description?, visibility: public|invite|private, inviteSecret? }`. `invite` requires `inviteSecret` (rejected otherwise, set-hive.ts L45-50). `private` = withdraw (stop re-announce + Cupboard unlist).
- `POST /api/discovery/join-hive` — body `{ hiveId, title?, memberLinks: string[] }` (max 64) → `joinHiveAsView` (remote_hive view + read-only clones). Underlying per-link mechanic: `POST /api/harness/join-link`.
- `POST /api/discovery/join-invite` — body `{ link: 'papercusp://hive?pubkey=…&secret=…&title=…' }`. **Honest-join** (join-invite.ts L69-96): bounded-waits for the hive to actually announce; returns `joined:true,found:true` if it announced, else `joined:false,subscribed:true` (withdrawn / wrong secret / owner offline) — not a fake success.
- `GET /api/discovery/hives` — the directory; filters OUT `private` (hives.ts L36).
- `GET /api/discovery/hive-meta?hiveId=…` — the owner's own share state (current visibility, invite secret to re-copy, member repos the next publish lists).

— su-7ac18
