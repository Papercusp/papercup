# PUI — the Papercusp terminal app

PUI is a terminal client for Papercusp: ask an agent to do work, watch it
stream, approve or interrupt it, and pick up where you left off.

## Install

```sh
tar -xzf pui-<version>-<target>.tar.gz
cd pui-<version>-<target>
./install.sh
```

`install.sh` checks every file against `CONTENTS.sha256`, confirms `pui` starts
on this machine, then runs `bin/pui self install`, which previews what it will
change and asks before changing it. Nothing else is needed: no Rust toolchain,
no python, no source checkout.

It installs into `~/.local/share/pui` and links `~/.local/bin/pui`. Set
`PUI_HOME` or `PUI_BIN_DIR` to choose other (absolute) locations. If
`~/.local/bin` is not on your `PATH`, add it.

Before unpacking, you can check the archive against the `SHA256SUMS` published
beside it (`sha256sum -c SHA256SUMS --ignore-missing`, or
`shasum -a 256 -c SHA256SUMS --ignore-missing` on macOS). If a `.minisig`
signature is published, verify it with `minisign -V -m <archive>` and the
publisher's public key.

## What PUI needs

PUI connects to a Papercusp operator: the Papercusp desktop app, a Papercusp
workspace host, or a remote operator URL. See `COMPATIBILITY.md`. With no
operator configured, `pui` opens setup; `pui doctor` checks the installation
and the selected operator.

## Update, roll back, uninstall

```sh
pui self status
pui self update --from pui-<newer-version>-<target>.tar.gz
pui self rollback            # return to the release before the last update
pui self uninstall           # keeps your settings; add --purge to remove them
```

The same actions are in PUI's command palette. Updates and rollbacks keep your
settings in `~/.papercusp`; the last two releases stay installed so a rollback
needs no download.

## Files in this release

| File | Purpose |
| --- | --- |
| `bin/pui` | the PUI binary |
| `bin/zellij` | the terminal multiplexer PUI's workbench uses (version-matched) |
| `pui-companion.wasm` | PUI's zellij plugin, built with the binary |
| `pui-install.json` | the binary/companion generation manifest |
| `CONTENTS.sha256` | digest of every file in this release |
| `PROVENANCE.json` | source commit, toolchain, measured runtime requirements |
| `COMPATIBILITY.md` | supported platforms and what each has been verified on |
| `THIRD_PARTY_LICENSES.md` | licenses of everything built into or shipped with PUI |
| `RELEASE_NOTES.md` | what changed |
