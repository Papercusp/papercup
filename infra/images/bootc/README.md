# bootc host image — the product image, plus the proven artifacts behind it

Working artifacts for the bootc host-image phase (P-303..P-309) of plan
`byoc-cloud-workspaces-gcp-aws-azure-2026-08-22`. Everything here was **proven before it was
committed**, and every file is byte-identical to the artifact that was actually run. Do not "tidy"
any of them without re-proving them.

| file | owner item | what it is |
|---|---|---|
| `Containerfile`, `p303-boot-proof.service`, `gcp-boot-proof.sh` | P-303 | the gate spike that booted on real GCP |
| `RPM-EQUIVALENCE.md` | P-304 | the verified Ubuntu-24.04 → CentOS-Stream-9 assumption table |
| `verify-rpm-equivalents.sh` | P-304 | the probe that produced that table — re-run it, don't trust it |
| `release-signature-policy.json` | P-306 / D-262 | the signature policy the image must ship |
| `p306-signature-policy-probe.sh` | P-306 / D-262 | proof that policy is enforced and fails closed |
| **`workspace-host.Containerfile`** | **P-306** | **the PRODUCT image — the port itself (D-281)** |
| `papercusp-sysusers.conf` | P-306 | the three identities, with PINNED uid/gid (D-282) |
| `papercusp-firewall.nft` | P-306 | the nftables ruleset that replaces ufw |
| `papercusp-host-prepare.{sh,service}` | P-306 | what cannot be baked: roots + ACLs, applied every boot |
| `p306-image-build-probe.sh` | P-306 | the falsifier for all of the above — 44 assertions |

## ⛔ `Containerfile` and `workspace-host.Containerfile` are different files, on purpose

`Containerfile` is **P-303's frozen gate spike** — the image that booted on real GCP. It installs
four packages and is deliberately NOT built from the RPM table. Leave it byte-identical; the boot
proof is only worth something while the artifact matches what booted.

`workspace-host.Containerfile` is **the product image (P-306)**: the full package set derived from
`RPM-EQUIVALENCE.md`, the three identities, the signature policy, the firewall, and the per-boot
unit. The port was written *alongside* the spike rather than by editing it. `p306-image-build-probe.sh`
§8 fails if anyone collapses the two.

## The product image: run the falsifier, don't trust the table

```bash
sudo -n bash infra/images/bootc/p306-image-build-probe.sh   # expect PROBE_RESULT=PASS
```

It builds the image and asserts 44 properties. Three things about it are worth knowing before you
read a `PASS`:

- **The lint verdict is a COMPARISON, not an absolute.** The bare base ships its own warning, so the
  probe lints the base in the same run as a control and fails only if this image *adds* warnings or
  *loses* checks. Measured 2026-09-04: warnings base=1 ours=1, checks passed base=12 ours=12.
- **The firewall ruleset check carries a negative control.** A malformed ruleset must be rejected;
  a syntax checker that accepts everything would pass the positive case and prove nothing.
- **`host-prepare.sh` is executed, and its last guard is EXPECTED to fail there.** A container has no
  nftables table loaded, so the firewall assertion fires — which is the paired control for the one
  guard that protects against an *open* host.

⚠ **What a `PASS` does NOT establish** — all three are the same shape, a property that looks present
in the layer and may not be there at the far end:

1. **That `/opt` survives as image content on a booted host (D-283).** The base's own tmpfiles dropin
   says it "implements the old model", where `/opt` is a link to `/var/opt`. If that is what the
   deployed host does, a baked release tree is simply absent and every container-level signal still
   reads healthy. `papercusp-host-prepare.sh` asserts it at boot; **P-305 owes the booted run.**
2. **That ACLs apply on the real image filesystem.** They are applied at boot precisely because they
   do not survive a container commit (WI-2143115).
3. **That a booted `bootc upgrade` refuses a mis-signed image.** D-279 proved the enforcement path;
   the booted hop is still an inference.

> ⚠ **Every artifact in this directory was rescued from `~/.papercusp/` scratch directories, in two
> separate incidents two days apart** (P-303's spike files on 2026-09-04, P-304's table and probe
> the same day). Both items were marked `done` while their only copy sat outside version control,
> and P-304's plan-item note cited the scratch path *as the deliverable*. If you finish a spike
> here, committing the artifact is part of the proof, not cleanup afterwards — a proven artifact
> that lives outside version control is indistinguishable from one that was never built.

**Re-verified 2026-09-04**, after committing, against the files in this directory: `podman build`
completes all 7 steps including `bootc container lint` (exit 0), and the ACL repro at the bottom of
this file reproduces the WI-2143115 defect exactly as written. So the artifact here is functional
today, not merely archived — the `stream9` base tag moves, and this is the check that catches it
having moved out from under us.

## What P-303 proved (measured, on real GCP)

The D-254 pipeline works end to end at its narrowest:

```
Containerfile -> podman build -> bootc OCI image -> bootc-image-builder --type gce
              -> image.tar.gz (1,366,904,402 bytes, containing disk.raw)
              -> GCS -> gcloud compute images create -> booted e2-standard-2 (us-central1-a, --no-address)
```

- `bootc container lint`: 9 passed / 1 skipped / 4 warnings.
- Serial console from the booted instance:
  - `booted os=centos-9 kernel=5.14.0-730.el9.x86_64`
  - `P303-BOOT-PROOF: identities-present PASS`
  - `P303-BOOT-PROOF: bootc-managed PASS` — independently confirms the `bootc upgrade`
    update model D-254 assumes actually applies.
  - `P303-BOOT-PROOF: acl-survived-conversion FAIL` — see the constraint below.
- Teardown verified clean: 0 instances, 0 images, 0 GCS objects.

Scope: the gate as originally written wanted one booted instance per cloud. It was **met for v1
under the GCP-only owner ruling of 2026-09-03**; GCE is the disk type that was built and booted.

## ⛔ The constraint this spike exists to hand forward — read before writing the port

**POSIX ACLs are silently dropped when a container layer is committed** (WI-2143115, critical).
`setfacl` in a `RUN` layer takes effect during the build and is **gone from the committed image**;
`system.posix_acl_access` is not preserved across layer commit. Every surrounding signal reads
healthy — `podman build` exits 0, `bootc container lint` passes, the image converts, boots, and
both service identities exist. Only the ACL is missing, and the ACL is what carries D-043 (the SSH
user must not read the runtime) and D-251 (the third identity that enforces it).

**Ruling for P-305 / P-306: apply the identity ACLs from a systemd oneshot that runs on EVERY
BOOT — never bake them into the image, and never gate the unit on a first-boot stamp.**
`systemd-tmpfiles` is not an escape hatch (tmpfiles.d has no ACL verb).

⚠ *Every* boot, not first — corrected while implementing P-306 half A, and the correction matters
more than the original ruling. `bootc upgrade` reboots into a NEW deployment root: the ACLs on
`/opt/papercusp` belonged to the OLD one and are gone, while `/var` persists. A first-boot stamp
lives in `/var`, so it survives exactly the event that destroys the thing it is gating — and the
unit would then skip precisely the hosts that took an update. The implementation
(`papercusp-host-prepare.service`) is therefore unconditional and idempotent.
This is essentially what the existing Ubuntu bootstrap already does on the live host
(`libs/generic/deployment-driver/src/workspace-host-bootstrap.ts`), which is why today's production
path is unaffected — this is a defect in a *future* port, filed because the natural way to write
that port is the broken way.

**Do not accept a bootc port whose only ACL evidence is a green build. Require a BOOTED assertion.**

## Why the boot-proof unit is shaped the way it is

`p303-boot-proof.service` is a systemd oneshot with `StandardOutput=journal+console`, ordered
`After=multi-user.target` so its marker means "userspace really came up". Serial output is read from
the GCP control plane, so the proof needs **no external IP, no firewall rule, no IAP tag and no SSH
key** — it is independent of all the networking P-306 still owns. Reuse this pattern for the port's
ACL assertion.

## ⛔ Adopting bootc gives you signature verification DEFAULTED OFF

The second constraint to read before writing the port, and it runs the opposite way to the ACL one:
there, a green build hid a missing property; here, a **working update path hides a missing check**.

The centos-bootc base ships `/etc/containers/policy.json` with `"default": [{"type":
"insecureAcceptAnything"}]` and `signedBy` entries for the Red Hat registries only. So `bootc
upgrade`/`switch` will pull and boot **any** image from our registry with no signature check at all.
If the port drops the tarball's `minisign` verification because "bootc verifies now" and nobody
ships a policy, the customer host verifies *nothing* — strictly weaker than the path it replaced,
while the attestation's `signatureVerified: true` keeps being emitted by code nobody updated
(D-262; the unbacked-boolean class of D-252).

**Measured 2026-09-04** by `p306-signature-policy-probe.sh`, which discharges the clause D-262 left
as NOT ESTABLISHED — "whether a sigstoreSigned policy against our registry actually passes end to
end". It is a *paired* probe with a positive control, because a policy that rejects everything would
pass a rejection-only test while being useless:

| probe | policy | image | exit | meaning |
|---|---|---|---|---|
| A | ours (`sigstoreSigned`) | signed | `0` ACCEPT | the policy is satisfiable — not reject-everything |
| B | ours (`sigstoreSigned`) | **unsigned** | `1` REJECT | `A signature was required, but no signature exists` — **fails closed** |
| C | the base's shipped default | unsigned | `0` ACCEPT | D-262's trap, reproduced live |

Costs nothing and reaches no cloud: signing and verification both run inside the base image with the
`skopeo` it already carries (1.23.0), against a few-KB throwaway image over the `dir:` transport.

That skopeo is the same one `bootc` itself shells out to — `rpm -q --requires bootc` lists `skopeo`,
and the `bootc` binary embeds `containers-image-proxy`, which spawns `skopeo
experimental-image-proxy` and carries `--insecure-policy` as an explicit *opt-out*. **Still not
established, and deliberately not claimed here:** a booted end-to-end `bootc upgrade` refusing a
mis-signed image. The evidence above is the enforcement path plus bootc's dependency on it, not a
booted assertion — and this directory's own P-303 lesson is that a booted assertion is the one that
counts. Prove it on the first bootc host P-305 boots.

`release-signature-policy.json` is that policy, as a **template**: the registry namespace and the
public-key path are placeholders, because P-307 establishes the namespace and P-308's `cosign sign`
produces the signature. A placeholder fails *closed*, which is the right direction for an unfinished
supply chain. Per D-262 the two items are coupled — shipping the policy without the signature bricks
upgrades, shipping the signature without the policy verifies nothing — and until both hold, **the
tarball's minisign verification must not be removed** (EPEL 9 carries minisign for the transition).

## What this is NOT

Not the product image, and not the bootstrap port. The Containerfile says so in its own header: it
installs only what proves the model works — it is **not** built from `RPM-EQUIVALENCE.md`'s package
set, and deliberately so: it is the P-303 proof artifact and stays byte-identical to what booted.
Porting the bootstrap onto that package set is P-306; collapsing the three per-cloud bake paths
(today `infra/images/workspace-host.pkr.hcl`) into one `bootc-image-builder` pipeline is P-307.

## Reproduce the ACL defect (no VM, no cloud, ~3 min)

```bash
cd infra/images/bootc
sudo podman build -t papercusp-bootc-spike:p303 -f Containerfile .
# ACL present at build time (persisted as ordinary file content, which does survive):
sudo podman run --rm --entrypoint /bin/cat      papercusp-bootc-spike:p303 /usr/share/papercusp-acl-probe.txt
# ACL absent from the committed image (the xattr, which does not):
sudo podman run --rm --entrypoint /usr/bin/getfacl papercusp-bootc-spike:p303 -p /opt/papercusp
```

`gcp-boot-proof.sh` drives the full convert → upload → create-image → boot → read-serial → teardown
cycle. `PROJECT` is env-overridable; it defaults to the spike's project.

## Re-run the other two probes (no VM, no cloud, seconds each)

```bash
# Is the signature policy enforced, and does it fail closed?  Expect PROBE_RESULT=PASS.
sudo -n bash infra/images/bootc/p306-signature-policy-probe.sh

# Do the RPM equivalents in RPM-EQUIVALENCE.md still hold on today's base?
sudo -n podman run --rm -i --entrypoint /bin/bash quay.io/centos-bootc/centos-bootc:stream9 -s \
  < infra/images/bootc/verify-rpm-equivalents.sh
```

Both are worth re-running rather than trusting, for the same reason the `podman build` above is:
`centos-bootc:stream9` is a **moving tag**, so "byte-identical to what was proven" and "still true"
are different claims that only happen to agree today.

⚠ The `-i` in that second command is load-bearing. Without it `podman run` never attaches stdin, the
script is never delivered, and the container **exits 0 having run nothing** — a green result from an
instrument that measured nothing. That mistake was made and caught while writing these probes; if
you adapt them, keep a line of output that proves the payload actually arrived.

## References

- Plan item P-303 (done) — the gate spike and its verdict.
- WI-2143115 (critical, done) — the ACL-drop defect, with the controlled before/after proof.
- D-249, D-254 — the owner ruling that ratified bootc; D-043, D-251 — the identity contract.
