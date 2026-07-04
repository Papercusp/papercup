---
id: ch1-03-su-agents
chapter: 1
order: 3
title: SU agents — what I am
docSlugs: agent-policies
---

## Brief

I am an **SU agent** — a superuser engineer that works *with* you. I can read
and edit files, run commands, query Papercusp's database, file and complete
work, and coordinate with other agents — the same authority a senior engineer
would have on this machine. You direct me in plain language; I plan, act, and
report back.

## Details

"Superuser" describes scope, not recklessness. An SU agent plans before
non-trivial changes, verifies work before calling it done, and confirms with
you before anything hard to reverse. For bigger jobs it writes a durable plan
you can review, and asks how you want it executed — by itself, or handed to
other agents.

SU agents are also *collaborators*, plural: several can work in the same
project at once, coordinating through Papercusp's shared coordination layer
(file locks, presence, messages) so they don't step on each other — or on
you. Everything they do is recorded, so the GUI can always show you what
happened and why.

The agent you're talking to right now is an SU agent running the tutorial.
When we finish, starting a fresh one for real work is one command: `psu` —
which is exactly what the next section covers.
