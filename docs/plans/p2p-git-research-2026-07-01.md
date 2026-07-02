# P2P Git for Papercusp Shared Hives — Research Report (D-009 → D-010)

**Plan:** `cross-machine-coord-parity-and-trust-2026-07-01` · **Date:** 2026-07-01
**Method:** deep-research workflow (5 search angles → 18 sources → 90 extracted claims →
adversarial 3-vote verification: 12 confirmed 3-0/2-0, 2 refuted 0-3) + in-session primary-source
completion of the 11 vote-starved claims (rate-limit casualties) against radicle.dev/2025/08/12
(canonical-references), git-scm.com/docs/gitprotocol-v2, pijul.org/model. All load-bearing claims
below are verified against primary sources; the two refuted claims are noted where relevant.

---

## 1. How Radicle (Heartwood) actually works — verified

**Replication (✓3-0, three independent sources).** Native **git wire protocol with pack
negotiation — not bundles** — multiplexed over the same framed, Noise-encrypted connection as
gossip; multiple concurrent fetches share one physical connection. Implemented via gitoxide in
`radicle-fetch`.

**Storage (✓3-0).** One **bare repo per repository ID**; every peer's refs live under a git
namespace keyed by their Node ID (`refs/namespaces/<NID>/refs/…`); **all namespaces share one
object database** (each object stored once). **Each namespace has exactly one writer.**

**Signed refs (✓3-0).** Every node re-signs its **entire ref set on every change**; the signature
+ show-ref listing live as a git blob at `refs/rad/sigrefs` *inside the namespace* — ref-authority
metadata replicates through the same object store as code. Verification model modeled on TUF:
given a repo ID + sigrefs, anyone can authenticate all updates with no trusted third party.

**Gossip (✓3-0).** Exactly three signed, timestamped message types: Node (addresses), Inventory
(who hosts what → routing), **Reference Announcements** (`{NodeID, OID-of-sigrefs}`) — relayed
only to interested (seeding) nodes; an announcement **triggers** the fetch.

**Canonical refs (completed in-session from the primary post).** Peers never push top-level refs.
`refs/heads/main` etc. are **synthesized**: the identity document's `defaultBranch` + `delegates`
+ `threshold` define canonicity for the default branch — canonical when a threshold of delegates
"decide on a commit". The **Aug 2025 release generalized this** via the `xyz.radicle.crefs`
identity payload: rules keyed by **git reference patterns** (e.g. `refs/tags/releases/*`), each
rule = `{ allow: [did:key…], threshold }`. Crucially: *"any time you push or fetch a reference
that matches a rule, it will compute the canonical form"* — **canonicity is a deterministic
LOCAL function over namespaced refs, evaluated at push/fetch time; never a separately gossiped or
negotiated object.** Identity-document changes themselves need a majority quorum of delegates.
(The workflow's two REFUTED claims were subtly-wrong variants of this — e.g. "applies only to the
defaultBranch", stale since Aug 2025.)

**Identity (✓3-0).** Plain Ed25519 keypairs (OpenSSH format on disk), Node ID derived from the
key; `did:key` is just the encoding. Fully compatible with papercusp's device keys.

**CoBs.** Issues/patches are CRDT-ish "Collaborative Objects" stored as git objects, replicated
the same way.

## 2. Comparative lessons (verified where load-bearing)

- **git-ssb:** commits/issues encoded into each participant's append-only SSB log; propagation by
  background gossip, not a git transport. Lesson: piggy-backing git *content* on a personal-log
  substrate couples code availability to log replication — the design papercusp already rejected.
- **hypergit (hypercore-native git):** remote helper writes the object store into HyperDB; sync =
  append-only log replication. Abandoned; and loose-object replication measured **git.git 118 MB
  packed vs 2.8 GB unpacked (~24×)** — per-object P2P replication (hypergit, IPFS remotes,
  git-ssb) is a storage/transfer anti-pattern. **Packfiles or nothing.**
- **git bundle-uri (primary doc):** bundles are a *bootstrap/offload* mechanism — client unbundles
  then does a normal incremental fetch. Even git upstream treats bundles as clone acceleration,
  not the sync protocol.
- **git remote helpers (primary doc):** a helper advertising the **`connect` capability** tunnels
  native `git-upload-pack`/`git-receive-pack` over ANY bidirectional full-duplex stream — a
  Hyperswarm/Protomux stream qualifies directly.
- **git protocol v2 (primary doc):** **stateless** (every command one round-trip, no server-side
  session state); **no automatic ref advertisement** — client runs `ls-refs` with `ref-prefix`
  scoping (advisory), so a peer can list just one device's namespace; activated out-of-band via
  `GIT_PROTOCOL=version=2` — spawn `git-upload-pack` with that env and pipe pkt-lines over our
  stream.
- **Pijul (primary doc):** state = **unordered set of patches** (order-independence ⇒ replicas
  with the same patch set converge); conflicts are first-class states (pushout completion), not
  failures. Lesson for us: order-independent convergence is what Radicle's
  namespaces-plus-computed-canonicity *approximates on top of git* — we get the property without
  leaving git by making the shared branch a computed function of single-writer inputs.

## 3. The five open questions, answered

1. **Bundles vs native protocol-v2 fetch over a custom duplex stream → native v2 fetch.**
   Radicle proves it in production over exactly our style of framed/Noise connection; v2 is
   stateless and transport-agnostic; the `connect` remote-helper capability makes stock git do the
   work. Bundles only later, as cold-clone bootstrap (bundle-uri semantics).
2. **Per-machine namespaced heads vs a single contended branch → namespaces, unequivocally.**
   Radicle's single-writer-per-namespace + shared ODB eliminates push contention *by construction*
   — no rebase races, no push serialization, no lock needed at the replication layer. Our earlier
   pull-rebase-push shared-branch design should be REPLACED at the replication layer: each machine
   publishes only `refs/namespaces/<device>/…`; **staging becomes a computed canonical ref**, not
   a pushed one.
3. **Signed refs when membership is already device-gated → yes, a lite version.** The channel is
   authenticated, but transitive fetch is not: when machine C fetches machine A's namespace *via*
   machine B, only a per-namespace signature stops B from lying about A's head. We already own the
   signing idiom (presence-gossip frames); one signed show-ref blob per device namespace
   (sigrefs-lite) is cheap at 2–256 members and closes the relay-tamper hole.
4. **Ref flapping/split-brain → solved structurally, and their quorum maps onto our gates.**
   Radicle avoids flapping because top-level refs are never contended — canonicity is a
   deterministic local function. Mapping: our **integrator (lock-authority-elected) computes and
   publishes the staging canonical ref in its own namespace after the green gate**; the crefs-style
   `{pattern, allow, threshold}` rule model maps DIRECTLY onto release-class refs (allow = the
   green-checkpoint bot key + owner key, threshold 2 = "green AND ratified").
5. **Partial clone/shallow for large repos →** v2 filters + shallow are available over the same
   transport; default full clone within a hive (members seed everything — membership IS the
   seeding policy), shallow/backfill as a joiner optimization later.

## 4. ADOPT / ADAPT / DROP for papercusp

**ADOPT**
- Native git wire protocol v2 over Protomux streams (`papercusp/hive-git` channel on the existing
  hive-swarm connections; spawn `git-upload-pack` with `GIT_PROTOCOL=version=2`, or a remote
  helper with `connect`).
- One bare repo per hive under papercusp storage; `refs/namespaces/<device-pubkey>/…`
  single-writer namespaces; shared ODB.
- Announcement-driven fetch: ref announcements as **P-009 federated events** on the coord plane
  (already built, signed, membership-gated, budget-capped) — `{device, sigrefsOid}`; receivers
  fetch. Interest scoping = hive membership (already ours).
- Canonicity-as-computed-ref for release-class refs with crefs-style `{pattern, allow, threshold}`
  rules carried in the **owner-signed hive policy** (our identity document analog — already
  signed, versioned, federated, quorum-free by design since the owner signs).

**ADAPT**
- **Staging**: not delegate-threshold agreement (that models "same commit pushed by k people",
  wrong for continuous integration). Staging = the integrator's merge of member namespace heads,
  green-gated, published in the integrator's namespace and marked canonical by rule
  `{refs/heads/staging → allow:[integrator-lease-holders], threshold:1}`. Integrator = the
  existing lock-authority lease. The sha-token lock handoff (already designed) still coordinates
  *editing*; publication needs no locks at all anymore.
- **sigrefs-lite**: device-signed ref-set blob per namespace, our signing idiom, verified on fetch.
- **Identity**: raw device Ed25519 anchored to GitHub (skip DID encoding; same crypto).
- **Trust tiers**: the Phase-3 comms lattice gains the git dimension — namespace *replication* at
  `observe`+, canonical-ref *consideration* (integrator merges your namespace) at `steer`
  (multi-owner mode), mirroring trust-tiered auto-merge.
**DROP**
- CoBs — our federated work-item/conversation plane already does this; duplicating into git
  objects adds a second source of truth.
- Delegate-quorum identity-document governance — the owner-signed hive policy is our governance
  doc; hives have an owner, not a delegate set.
- Open-world seeding/DHT discovery for repos — the hive topic + membership already scope it.
- GitHub as the sync transport (per owner D-009) — it remains the identity anchor + release
  channel; sync is hive-native.

## 5. Consequences for the plan

The per-device-namespace model **supersedes the shared-branch pull-rebase-push tick** at the
replication layer (no push contention, no rescue-branch hot path — divergence becomes "integrator
hasn't merged yet", visible not destructive). The git phase items should be specced as:
G-1 storage layout + namespaces; G-2 `papercusp/hive-git` fetch channel (v2 over Protomux);
G-3 ref announcements on fed events + fetch trigger; G-4 sigrefs-lite; G-5 integrator (staging
canonical compute + green gate); G-6 crefs-style rules in hive policy (release refs);
G-7 worktree bridge (each machine's working tree tracks canonical staging; sha-token lock handoff
unchanged); G-8 cold-clone bootstrap (bundle later).

## Sources

Primary: radicle.dev/guides/protocol · radicle.dev/guides/user · hackmd.io/@radicle/rJ2UH54P6
(Heartwood release overview) · github.com/radicle-dev/heartwood HACKING.md ·
radicle.dev/2025/08/12/canonical-references · git-scm.com/docs/gitprotocol-v2 ·
git-scm.com/docs/gitremote-helpers · git-scm.com/docs/bundle-uri · pijul.org/model.
Secondary: DeepWiki heartwood fetch-protocol · LWN 966869 · ctrl.blog git-p2p-compared ·
git-ssb-intro · hypergit · git-remote-ipfs · HN 39600810/25322584 · beyermatthias.de Radicle
usability study.
