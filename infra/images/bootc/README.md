# bootc host image — P-303 gate-spike artifact (PROVEN, not yet the product image)

These three files are the **exact artifacts that passed the P-303 gate spike** on plan
`byoc-cloud-workspaces-gcp-aws-azure-2026-08-22`. They are committed here because they were
proven on real hardware and then lived only in a scratch directory
(`~/.papercusp/p303-bootc-spike/`) outside version control — one cleanup away from being lost,
at a re-derivation cost of a full GCP spike in time and real money.

They are byte-identical to the artifacts that were actually run. Do not "tidy" them without
re-proving them.

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

**Ruling for P-305 / P-306: apply the identity ACLs at FIRST BOOT from a systemd oneshot — never
bake them into the image.** `systemd-tmpfiles` is not an escape hatch (tmpfiles.d has no ACL verb).
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

## What this is NOT

Not the product image, and not the bootstrap port. The Containerfile says so in its own header: it
installs only what proves the model works. Re-deriving the real package set on this base is P-304;
porting the bootstrap is P-306; collapsing the three per-cloud bake paths (today
`infra/images/workspace-host.pkr.hcl`) into one `bootc-image-builder` pipeline is P-307.

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

## References

- Plan item P-303 (done) — the gate spike and its verdict.
- WI-2143115 (critical, done) — the ACL-drop defect, with the controlled before/after proof.
- D-249, D-254 — the owner ruling that ratified bootc; D-043, D-251 — the identity contract.
