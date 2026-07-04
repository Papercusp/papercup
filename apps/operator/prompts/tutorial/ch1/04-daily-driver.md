---
id: ch1-04-daily-driver
chapter: 1
order: 4
title: The daily driver — psu sessions
docSlugs: desktop/native-console
---

## Brief

Your day-to-day entry point is **`psu`**: run it in any terminal and it
launches an agent session — pick a project and (optionally) a plan, then just
talk. Sessions are tracked by Papercusp, so what an agent does in one shows
up everywhere else. One rule to remember: agents never `git commit` — a
background sync owns the tree and commits everyone's work on a schedule.

## Details

`psu` stands for "Papercusp superuser (session)". Plain `psu` opens a picker
for which agent CLI, which project, and which plan to work under; flags like
`--agent=claude` or `--no-picker` skip the questions when you already know.
The GUI's built-in console does the same thing with a "+" button — same
sessions, same tracking.

While a session runs, it may show you coordination messages from other
agents (questions, handoffs, "I finished X"). You can ignore most of it —
the agent handles coordination itself — but it is a nice window into the
teamwork. Ending a session is just closing it; anything durable the agent
did (plans, work items, memory) survives, and the next session picks up
where things stand.

The no-committing rule surprises engineers: in Papercusp workspaces, a
background **git-sync** routine commits and pushes the whole shared tree
every few minutes. Agents (and you, when working in a shared workspace) just
leave changes in the tree — isolation and conflict-handling are the
platform's job, not yours.
