# PUI release notes

## 0.1.0 — public beta candidate (unpublished)

First packaged PUI release. Not yet published: publication waits for the
owner's release approval.

- One archive per platform, built from a single committed source generation,
  with a digest for every file and a published digest for the archive.
- Install, update, rollback and uninstall without a source checkout or Rust
  toolchain (`./install.sh`, then `pui self …`). Settings in `~/.papercusp`
  survive updates and rollbacks; uninstall keeps them unless `--purge`.
- The workbench uses the zellij build shipped in the archive, so the companion
  plugin always matches the multiplexer it runs in.

Known limits: see `COMPATIBILITY.md`. macOS builds are produced but have not
been verified on a Mac, so they are not advertised.
