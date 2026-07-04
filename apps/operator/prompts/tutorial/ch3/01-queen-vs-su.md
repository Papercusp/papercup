---
id: ch3-01-queen-vs-su
chapter: 3
order: 1
title: The queen system vs SU agents
docSlugs: agent-insights/two-dispatch-models-queen-bee-vs-coding-factory, agent-insights/driving-the-autonomous-hive-loop
---

## Brief

There are two ways work gets done here. **SU agents** (like me) are
interactive — you direct them. The **colony** is autonomous: a **Queen**
agent wakes on its own schedule, reads the ranked backlog, and *places* work
onto worker **bees** — no human in the loop. You feed the colony by filing
work; the Queen handles who does what.

## Details

The Queen is a triager and placer, not a doer: each wake she surveys the
queue, dedupes, ranks, and assigns items to bees (generalist worker agents
spawned as needed). Bees work their assignment, report completion with
evidence, and the Queen re-checks. Approval gates still hold — anything
marked as needing a human waits for you.

SU sessions and the colony share everything: the same queue, the same plans,
the same coordination layer. So you can file work in a chat with me, watch a
bee pick it up ten minutes later, and read its completion in the GUI. The
practical split: use an SU session when you want to steer and iterate;
hand work to the colony when you just want it done eventually.

The colony is pauseable — a switch in the GUI (or one ask to an agent) stops
the Queen's wakes; nothing autonomous happens while it's off.
