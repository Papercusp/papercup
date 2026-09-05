# Copying build artifacts off the mac VM: rsync fails two different silent ways, and exit codes lie about it
URL: /internal/docs/agent-insights/copying-artifacts-off-the-mac-vm

macOS ships Apple rsync 2.6.9, which rejects --protect-args/-s (exit 12); hand-escaping the spaces in \"Papercusp GUI.app.tar.gz\" passes the backslash through literally (exit 23). Both transfer ZERO bytes. Stream per-file with `ssh 'cat …'` and verify by sha256 — never by exit code.

The mac desktop bundles are named **with spaces** — `Papercusp GUI.app.tar.gz`,
`Papercusp Server.app.tar.gz`. Getting them off `papercup-vm-mac` looks like a
one-line `rsync`. It is not, and both failure modes are silent: they report
success and copy **nothing**.

(The same spaces cause a *second*, unrelated bug once the files are uploaded —
an unencoded space in `latest.json`'s download url is rejected by the client.
See WI-4364. Assume anything touching these filenames is booby-trapped.)

## Failure 1 — hand-escaping the spaces (exit 23, nothing transferred)

```bash
# WRONG
The mac VM account is machine-local config — `. ~/.papercusp/build-vms.env`
first, which exports `VM_MAC_USER` (WI-4419: never hardcode it here).

rsync -av ""$VM_MAC_USER"@127.0.0.1:~/build/Papercusp\ GUI.app.tar.gz" ./
# rsync: link_stat ".../Papercusp\ GUI.app.tar.gz" failed: No such file or directory (2)
# rsync error: some files/attrs were not transferred (code 23)
```

The backslash is passed through **literally** to the remote, which then looks for a
file whose name really does contain a backslash. Escaping is the intuitive fix and it
is the wrong one.

## Failure 2 — reaching for `-s` / `--protect-args` (exit 12, nothing transferred)

That is the documented fix for spaces in remote paths… on **GNU** rsync.

```bash
# WRONG on macOS
rsync -avs ""$VM_MAC_USER"@127.0.0.1:~/build/Papercusp GUI.app.tar.gz" ./
# rsync: on remote machine: -slogDtpre.iLsfxCIvu: unknown option
# rsync error: syntax or usage error (code 12) [server=2.6.9]
```

**macOS ships Apple rsync 2.6.9** (from 2006). It does not know `-s`. The local rsync
folds `-s` into the option string it sends to the remote, and the ancient remote
rejects the whole blob. Note the tell in the error: `[server=2.6.9]`.

## Before reaching for `-s` at all — a PUSH usually never needed it

The trap above is worth avoiding one step earlier, because `-s` is reached for far more
often than it is required, and on a mac target the reflex is what breaks you.

`--protect-args` protects arguments that reach the **remote shell's argv**. A
space-bearing *filename* being copied does not: it travels inside the rsync protocol
stream, not on the remote command line. So `-s` only matters when a space-bearing path
appears as a remote *argument* — a remote SOURCE path, or a destination directory whose
own name contains a space.

```bash
# FINE without -s: only the LOCAL side has spaces, dest dir does not
rsync -av "local/Papercusp GUI_0.0.13_x64.dmg" "$VM:~/build/"
```

That is the asymmetry that makes this bite: it is the *pull* (remote source, spaces in
the remote path) that tempts you toward `-s`, and the fix for that case is not `-s` at
all — it is the per-file ssh stream below. Note the direction of the hazard too: the
more carefully you write the command, the more likely you reach for the safety flag,
and the flag is what fails.

If a helper genuinely must pass `-s` to a host that might be a mac, feature-detect
(`ssh "$VM" rsync --version`) rather than assuming — or use `scp` / `tar | ssh`, which
is what `papercusp-desktop/bin/mac-vm-verify-build.sh` does (it rsyncs the snapshot
**without** `-s` and pulls the DMGs back over `scp`).

## The fix — stream per file over ssh, then verify by content

Skip rsync entirely. Quote the remote path *once*, for the remote shell:

```bash
ssh -i ~/.ssh/papercup-vm-mac -p 2222 "$VM_MAC_USER"@127.0.0.1 \
  "cat '/Users/"$VM_MAC_USER"/build/.../Papercusp GUI.app.tar.gz'" \
  > "Papercusp GUI.app.tar.gz"
```

Then **verify by sha256, not by exit code** — capture the hash on the VM *before*
the transfer and compare after:

```bash
ssh … "shasum -a 256 '/abs/path/Papercusp GUI.app.tar.gz'"   # on the VM, first
shasum -a 256 "Papercusp GUI.app.tar.gz"                      # locally, after
```

A truncated or empty stream still exits 0. The hash is the only thing that
actually proves the bytes arrived — and for a 462 MB GUI tarball / 1.33 GB Server
tarball, "it seemed to work" is not evidence.

## Why the failures were invisible for so long

Both rsync attempts were run as `rsync … | tail`, so the harness's completion
notification reported **"exit code 0"** while the real exit codes were 23 and 12 —
the pipeline's status is its *last* stage's. That is
[EI-8871](/internal/docs/agent-insights/background-test-pipe-exit-code-trap), and it
is not a testing-only trap. When a transfer "succeeds" but the file is missing or
short, suspect the exit code before you suspect the network:

```bash
rsync … ; echo "EXIT=${PIPESTATUS[0]}"
```
