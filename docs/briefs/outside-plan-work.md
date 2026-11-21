# Work planned outside Papercusp

Launch an su session with `psu --no-picker --plan-ref='tracker:ABC-123'`. A client that
authorizes unattended execution can also pass `--auto` and supply the assignment with
`--kickoff`. The outside reference records where the work was planned. Execution authority
still comes from the launch mode. The client supplies
the task, design material and acceptance criteria in its kickoff. Read the exact label with
`coord:whoami` (`outsidePlanRef`). The program receives its result in the final reply.

`capability:launch-agent` and `fleet:launch-on-plan` accept `planRef`. The ACP adapter
contract places the value at `_meta.psuAcp.planRef` on `session/new` and `session/resume`.
The adapter forwards that value to the launcher. The saved session binding survives resume.
A Papercusp plan binding and an outside reference are mutually exclusive.

Create and hold a work-item before editing. The work-item inherits the creating session's
reference. An explicit `planRef` on a single item or batch entry overrides the default.
The stored work-item field is the existing `external_plan_ref`; older records keep their
original labels. Session labels are opaque and bounded at launch. Work-item reads and
claim filters expose the label without looking up the external system.

For a fleet, the leader holds its own item and creates one item for each piece, recording
unfinished prerequisites with `blocks` links. For example, with three actual IDs and two
ready items, issue one launch:

```json
{
  "name": "client-assignment",
  "workItems": ["WI-101", "WI-102", "WI-103"],
  "count": 2,
  "headless": true
}
```

The fleet inherits the leader's reference. The launch checks the ready frontier and
persists the exact ID filter before opening members. To admit an existing additional
item, use `scheduler:set_claim_spec` with `fleet` and `appendIds`. Members pull via
`scheduler:get_next` and complete work with evidence. The leader comments on the
affected work-item when it makes a ruling, checks the entire admitted set, and completes
its own item before returning the result.

## Implementation and control

The base kernel, engineer and power tool notes, shared plan-discipline text and AUTO
mode definition recognize outside planning. The sealed stack selects the outside
workflow at launch. The control anchor reads the same persisted binding when a session
joins a fleet or changes role. The two outside fleet identities supply work-item-specific
instructions. The launch and fleet briefs direct the agent to read the opaque label as
data. The broad-intent hint directs claims to the appropriate work-item or plan-item tool.

Ordinary sessions continue to select their original planning workflow and fleet
identities. Their text now explains the exception for a bound outside session. The
comparison uses the same Codex profile, AUTO mode and harness on both sides.
[Assembled launch prompt diff](../evidence/outside-plan-prompt.diff)

## Verification

The claim-discipline routine only sends a plan-item reminder when presence declares a plan
slug. The plan-attention reader and unshipped-plan audit operate on existing plans.
`plans:audit` takes a target slug. The continuation gate considers context headroom,
pending interrupts and fleet state. The ordinary `coord:orient` path skips the plan read
when the caller has neither a supplied nor a declared slug. The outside member posture
uses that path. Work-item creation suppresses its residual-plan and plan-blocker hints
for a referenced item. The detail panel and work-item table render the stored reference
as text, preserving spaces and line breaks.

The two fleet identities are separate so launch, resume and leadership changes can
select the applicable instructions. Later member-created pieces use the existing
claim-spec store. The work-item field reuses the existing structured
`payload.externalPlanRef` value on both issue and feature records. The session binding
uses the `outside_plan_ref` column on `adv_sessions`. These choices avoid a second
work-item field, fleet queue or plan store.

The ordinary rendered kernel gained clauses about reference-bearing work at the
planning rule, the big-scope tier and the cross-lane decision rule. The engineer and
power tool notes and the shared planning note also explain the exception. All apply
only to referenced work. The ordinary stack still selects the local planning block
and the original leader/member identities. The diff above compares the rendered
ordinary and outside cases at the same profile and mode.

Run the focused suites with `npm run test:file --` followed by
`packages/operator-core/lib/stack-binding-channel.test.ts`,
`packages/operator-core/lib/su-launch-context.test.ts` and
`packages/operator-core/lib/agent-tools/coordination/tools/declare-intent.test.ts`.
The database restart scenario lives in
`packages/operator-core/lib/agent-tools/work_items/outside-plan-restart.integration.test.ts`.
It uses Bubblewrap, a loopback-only namespace and a new native PostgreSQL cluster.
The single-session case runs in its own database clone and exercises identity,
creation with an inherited reference, conflicting bindings, a two-file edit and
completion. The restart case exits one application process after the first claim,
then uses a second process to read the binding, drain the exact set in dependency
order, check the unrelated item and complete the leader. The fleet launch-handler
suite separately checks that the claim spec is stored before either spawn callback
and that an over-wide launch opens no members.
