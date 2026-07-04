# Session modes — AUTO, IDEATE, DRAIN
URL: /internal/docs/agents/session-modes

The owner-switchable standing modes an interactive (su) agent session runs under — what each authorizes, how they compose, and how to turn them on and off.

An interactive agent session (an su / engineer-collaborator) runs under a set of
**standing modes** the owner switches with plain words. A mode is a session-wide
grant — it carries across turns and topics until explicitly turned off, the
session ends, or the goal completes. The canonical, binding statement of each
mode lives in the su playbook (the persona every su session is launched with);
this page is the orientation view.

## AUTO — "act, don't ask"

**On:** "AUTO mode", "run autonomously", "don't ask — use your judgment",
"just keep going". **Off:** "exit AUTO mode", "pause", "ask me first again".

AUTO suspends the default confirm-before-acting posture: the agent chooses the
route, passes approval gates on its own judgment, and **replaces every question
with a disclosure** — assumptions and deferrals are stated in the report, never
asked as menu check-ins ("want me to X or Y?" is banned). For open-ended
directives the agent arms an engine loop (`loop:arm`) so the work recurs across
turns instead of stopping to ask "what next?".

What still stops an AUTO session: nothing owner-shaped. The one hard rail is
data integrity — never destroying a **peer's** uncommitted work (tree-wide
destructive git ops on the shared checkout). Genuinely unresolvable
product-direction forks become disclosed assumptions, not pauses.

## IDEATE — "invent net-new, don't just patch"

**On:** "ideate mode", "brainstorm features", "think bigger". **Off:** "stop
ideating", "just fixes". Default OFF; orthogonal to AUTO.

IDEATE makes ambition part of the job: the agent runs deliberate ideation
passes — mining its own recent observations, `curation:state-of-hive`, rubric
freshness, and past graded proposals — and files net-new feature proposals via
`improvements:capture { kind:"feature" }`. No quality gate, no quota; blue-sky
is licensed. With AUTO also on, the strongest ideas get **built**, flag-ON and
disclosed, not just filed.

## DRAIN — "drive the queue to terminal"

**On:** "drain mode", "clear the backlog". Implies AUTO ON.

DRAIN sets the *objective*: take a work-item backlog and drive every item to a
terminal state (done / resolved / deprecated / needs\_human), usually by leading
a fleet. The operating loop: triage + rank first · capacity preflight · canary
launch, then the fleet · feed by claim-spec (never hand-assignment) · a leader
monitor loop each wake · wind down with a residue report. Completion integrity
outranks burn-down speed — nothing goes terminal without evidence.

## How they compose

|                | AUTO off                                          | AUTO on                                              |
| -------------- | ------------------------------------------------- | ---------------------------------------------------- |
| **IDEATE off** | File observations; fixes wait for approval.       | Implement fixes/improvements you encountered.        |
| **IDEATE on**  | Run ideation passes; file proposals, don't build. | Run passes AND build the strongest ideas, disclosed. |

DRAIN layers the queue→terminal mission on top of whichever cell is active.

## Where the truth lives

The full binding rules (what each mode suspends, the anti-footgun rail, the
end-of-turn test, loop cadence) are in the su persona/playbook sources — see
[prompt assembly](/internal/docs/agents/prompt-assembly) for how those reach a
live session, and the
[su-persona render + edit path](/internal/docs/agent-insights/su-persona-render-and-edit-path)
before editing them.
