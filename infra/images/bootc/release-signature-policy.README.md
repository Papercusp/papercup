# `release-signature-policy.json` — why it looks the way it does

> ⛔ **This prose lives here, NOT in the JSON.** `release-signature-policy.json` is parsed by
> containers/image, whose policy parser is STRICT: **any unknown top-level key is a fatal
> error**, comment-shaped or not. The file used to carry a `"_comment"` array, and the result
> was an image that could not install itself —
> `invalid policy in "/etc/containers/policy.json": Unknown key "_comment"` — raised by
> `bootc install to-filesystem` at the moment `bootc-image-builder` tried to render a disk
> (measured 2026-09-04, P-307's first end-to-end bake). `skopeo --policy` rejects it
> identically, so the file had never been loadable by anything.
>
> **Do not add comments, `_comment`, `//`, or any explanatory key back into that JSON.**
> Put it here instead.

## Why this file exists

P-306 / D-262 condition 1: the containers signature policy the workspace-host bootc image MUST
ship at `/etc/containers/policy.json`.

The centos-bootc base ships a policy whose default is `{"type": "insecureAcceptAnything"}` —
measured, and reproduced as PROBE C in `p306-signature-policy-probe.sh`, which copies an
UNSIGNED image with exit 0. So adopting bootc gives the verification MECHANISM, defaulted OFF.
If P-306 removes the tarball's minisign check because "bootc verifies now" and nobody ships
this file, the customer host verifies NOTHING and is strictly weaker than the path it replaced.

## Substitution points

This is a TEMPLATE, not a finished policy. The registry is deliberately a placeholder, and the
public key is deliberately absent, until a release build supplies both:

- `<RELEASE_REGISTRY_NAMESPACE>` — the registry repo the release is published to. Substituted at
  BUILD time by `workspace-host.Containerfile` layer 3 (P-307), all-or-nothing across this file
  and `release-registries.d.yaml`. **Include the PORT**: it is part of the signature scope, and a
  port-less key matches nothing while refusing byte-identically to an unsigned image.
- `/etc/pki/papercusp/release-signing.pub` — the sigstore PUBLIC key. `bake-cloud-images.sh`
  takes it from `--pubkey` (or the `.pub` sibling of `--key`), validates it during the build,
  and bakes it into the image before P-308 signs the resulting digest. It is never fetched at
  run time. A specialised build with a registry but no matching public key is refused.

Leaving a placeholder in place makes the policy fail CLOSED (the reference cannot match), which
is the correct direction for an unfinished supply chain.

## The narrow `containers-storage` exception is for image rendering only (D-291)

`bootc-image-builder` installs its source through `containers-storage:`. The supply-chain gate
has already signed and verified one registry digest before that step, then the bake pulls that
exact digest into local storage and asserts it exists. A specialised build therefore adds two
local rules with `insecureAcceptAnything`:

- `[<graph-driver>@/var/lib/containers/storage]<RELEASE_REGISTRY_NAMESPACE>` admits only our
  digest-pinned repository from the caller's mounted store.
- `[overlay@/run/osbuild/containers/storage2]` admits the second, name-less image-ID handoff from
  osbuild's private graph root. containers/image deliberately canonicalizes the longer live
  reference (which also carries a runroot and `additionalimagestore` option) to driver + graph
  root for policy matching; neither a repository scope nor the `/var/lib` store can match it.

These are deliberately not a transport default: a seven-arm probe proves the repository-scoped
rule rejects a foreign local image that a blanket rule accepts, and separately proves the exact
`storage2` graph root accepts osbuild's image-ID reference while a different graph root rejects
that same reference. The `docker:` rule is unchanged and remains `sigstoreSigned`; upgrades from
the release registry still require the baked public key. Both local rules are injected by
`workspace-host.Containerfile`, rather than written into this template, so an unspecialised image
carries no local-storage allowance at all.

## Coupling (D-262 condition 3)

This policy and P-308's signing are ONE unit. Shipping this without the signature bricks
upgrades; shipping the signature without this verifies nothing.

## `signedIdentity` is `matchRepository` ON PURPOSE — do not "tighten" it (D-287)

cosign v2.4.1 signing an image BY DIGEST records `critical.identity.docker-reference` as the
BARE REPOSITORY (measured: `<host>/papercusp/workspace-host` — no tag, no digest), and its
`sign` subcommand has NO `--sign-identity` flag to change that. So `matchRepoDigestOrExact`
REJECTS our own correctly signed image with `Signature for identity ... is not accepted`.

This file USED to say `matchRepoDigestOrExact`; it would have failed on the first real host.
That is not a weakening: the scope key already pins the repository, signatures are discovered
per-DIGEST (a `sha256-<digest>.sig` attachment), and the key check is real — a wrong key fails
with `cryptographic signature verification failed`. `matchRepository` relaxes only the recorded
docker-reference field, which cosign fills with that same repository anyway.

## ⛔ This policy is INERT without `use-sigstore-attachments` (D-287)

On the `docker:` transport containers/image does not even LOOK for a cosign signature unless the
registry is listed in `/etc/containers/registries.d/` with `use-sigstore-attachments: true`.
Without it a correctly signed image reports `A signature was required, but no signature exists`
— byte-identical to the message an UNSIGNED image produces. The image ships that fragment; see
`workspace-host.Containerfile` layer 3. Deleting it does not loosen the gate, it silently breaks
every upgrade.

## `default: reject` is load-bearing

Do NOT soften it to `insecureAcceptAnything` to make an unrelated pull work — add a narrow
transport entry for that specific source instead.

## How this file is verified

Grepping it is not verification. Two probes touch it, and for a long time NEITHER loaded it:

- `p306-signature-policy-probe.sh` writes its OWN policy via heredoc, so its accept/reject
  findings are about containers/image BEHAVIOUR, not about this file.
- `p306-image-build-probe.sh` used to only `grep` this file for the placeholder and for
  `default: reject` — both text properties, which is exactly why a fatal `_comment` key survived
  in it undetected until a real disk render.

It now also LOADS the policy with `skopeo --policy` inside the image and asserts the loader does
not reject it. That check is the one that would have caught the `_comment` bug on day one; keep
it, and prefer a behavioural assertion over a grep for anything else added here.
