# PUI release notes

## 0.1.0 — public beta candidate (unpublished)

First packaged PUI release. Not yet published: publication waits for the
owner's release approval.

**Chat with an agent**

- Your first message starts a Papercusp agent session and its reply streams
  into the chat, with the agent's tool use shown as it happens. Nothing opens
  in another window.
- Messages you send while the agent is working wait their turn. `Ctrl+X` stops
  the current turn. A stopped session reopens the same conversation on your
  next message.
- Questions from the agent and requests to use a tool open as cards over the
  chat, so you can answer or decline without leaving the keyboard.
- `l` lists your conversations; pick one to reopen it with its history.
  `m` / `e` / `a` / `u` choose the model, effort, account and mode for a new
  session.
- If the connection to the operator drops or the operator restarts, PUI
  reconnects and returns you to the same conversation.

**Task list**

- `Ctrl+T` opens the conversation's task list. You and the agent edit the same
  list: add, edit, reorder, start, block with a reason, finish, reopen or drop
  tasks, or turn one into a tracked work item.

**Terminal**

- PUI follows `NO_COLOR` and has a high-contrast theme (`:theme`).
- In a terminal smaller than 80×20, PUI pauses behind a notice and keeps your
  unsent message; it continues once the window is large enough again.

**Remote hosts**

- `pui --connect` runs PUI on a remote Papercusp host saved in `psu`, using the
  same connections, picker and sign-in as `psu`. It needs `psu` installed on
  this machine.

**Install and support**

- One archive per platform, built from a single committed source generation,
  with a digest for every file and a published digest for the archive.
- Install, update, rollback and uninstall without a source checkout or Rust
  toolchain (`./install.sh`, then `pui self …`). Settings in `~/.papercusp`
  survive updates and rollbacks; uninstall keeps them unless `--purge`.
- `pui doctor` checks the installation and the operator connection.
  `:about` shows the installed release, and `:diagnostics` saves a support
  report that leaves out conversation content and credentials.
- The workbench uses the zellij build shipped in the archive, so the companion
  plugin always matches the multiplexer it runs in.

Known limits: see `COMPATIBILITY.md` for which platforms and agent engines this
release has been verified with. macOS builds are produced but have not been
verified on a Mac, so they are not advertised.
