## Your positioning

Avi, lead as a production commerce and distributed-systems engineer—not primarily as an AI founder.

Your strongest narrative is:

> I’ve spent 13+ years building and operating revenue-bearing systems end to end. I ran a commerce platform doing over $1M per month, synchronized millions of SKUs across marketplaces, and built performance-critical fulfillment infrastructure. More recently, I built a multi-agent engineering platform, so I also understand how to use AI tools without lowering production standards.

This directly matches arrivia’s combination of commerce, scale, reliability, full-stack ownership, and AI-assisted development.

## 90-second introduction

> I’m a full-stack and distributed-systems engineer with more than 13 years of end-to-end production ownership.
>
> For twelve years, I founded and engineered Store Wolf, an automated commerce platform that generated over $1 million per month while operating with only three warehouse employees. The difficult part was keeping inventory, pricing, orders, and listings consistent across millions of SKUs and multiple marketplaces. I also built a fulfillment optimizer that modeled more than 100,000 SKUs and recomputed lowest-cost fulfillment paths in about sixty seconds.
>
> More recently, I built PaperCusp, a TypeScript, React, Hono, Tauri, and PostgreSQL platform for coordinating more than fifty AI coding agents on a shared codebase. That work includes distributed scheduling, collision prevention, observability, test and release gates, failover, health checks, and rollback.
>
> Arrivia interests me because it combines problems I already know well: consumer commerce, changing inventory and pricing, distributed integrations, low-latency customer experiences, and reliable production operations. I’m looking to bring founder-level ownership into a senior IC role on a strong engineering team.

Do not recite it mechanically. Remember the sequence: **13 years → Store Wolf scale → PaperCusp relevance → why arrivia.**

## Why arrivia?

> Travel is a new domain for me, but the engineering shape is very familiar. Arrivia has multiple brands, suppliers, transactional systems, changing availability and pricing, customer-facing latency requirements, and sensitive member data.
>
> I was also drawn to the way the role combines feature ownership with production operations. It does not separate building software from running it. That matches how I have worked throughout my career.
>
> Finally, I like that arrivia explicitly values AI coding tools while still emphasizing testing, security, and code quality. I have spent enough time building agent infrastructure to understand both the leverage and the failure modes.

Avoid generic claims about loving travel unless that is genuinely true.

## The three concerns you must neutralize

### “Why leave the founder path for a senior IC role?”

> Founding companies gave me unusually broad ownership, but it also meant splitting my attention across every part of the business. I’m deliberately looking for a role where engineering is the primary job again—working with strong peers, participating in design and code review, and applying what I’ve learned to a larger customer and organizational context.
>
> This is not a fallback from entrepreneurship. It is a deliberate move toward deeper engineering collaboration and shared product ownership.

If asked about PaperCusp:

> PaperCusp is serious technical work, but I’m intentionally pursuing a full-time engineering role. The role would be my professional priority, and I would keep any outside activity within the company’s conflict-of-interest and intellectual-property policies.

Only say that if it reflects your actual commitment.

### “You have not worked at a conventional mature engineering company.”

> My background is nontraditional, and I would not pretend that running my own companies is identical to working inside a thousand-engineer organization.
>
> What I did have was mature production accountability. Store Wolf processed real revenue and could not tolerate informal releases or casually inconsistent data. I had to build testing, monitoring, failure recovery, idempotent workflows, deployment controls, and operational ownership because there was no other team to absorb mistakes.
>
> PaperCusp takes those practices further with explicit work queues, automated verification, guarded promotion, deployment health checks, and rollback. I’m comfortable adopting an established organization’s processes, and one reason I want this role is to work within a stronger peer-review environment.

### “Are you overqualified for a 5–8-year role?”

> I care more about the actual engineering scope than optimizing for title. If the role offers meaningful ownership of performance, reliability, and production systems, Senior Engineer is an appropriate conversation. I’m comfortable earning trust within arrivia’s leveling system.

## Requirement-to-evidence map

| Arrivia requirement | Your strongest evidence |
|---|---|
| Full-stack ownership | PaperCusp’s React/Tauri client, TypeScript/Hono services, PostgreSQL state, and release infrastructure |
| Production applications serving users | Twelve years operating Store Wolf and more than $1M/month in commerce |
| Scalability and performance | Millions of synchronized SKUs; 100K+ SKU weighted graph; millions of paths evaluated in about 60 seconds |
| Reliability and failover | Distributed synchronization, event-driven recovery, inference failover, health checks, guarded releases, rollback |
| Sensitive-data security | Server-authoritative validation, least-privilege boundaries, auditability, treating external and model output as untrusted |
| AI coding tools | Built the coordination and verification infrastructure for 50+ concurrent coding agents |
| On-call ownership | As founder and principal engineer, there was no higher escalation tier; production failures ultimately belonged to you |
| Mentoring and review | Emphasize executable engineering standards, design review, explaining tradeoffs, and helping others reason—not formal management you did not perform |

## Likely questions and strong answers

### “What is your biggest technical accomplishment?”

> Store Wolf is the best example because the result was business-scale, not a demonstration. We had to keep inventory, prices, orders, and listings correct across multiple marketplaces and millions of SKUs.
>
> I designed the synchronization and caching architecture and built a fulfillment optimizer that represented over 100,000 SKUs as a weighted graph. Bitmap indexing let it evaluate millions of possible configurations and recompute lowest-cost fulfillment in roughly sixty seconds.
>
> The broader result was a commerce platform producing more than $1 million per month while requiring only three warehouse staff. The engineering outcome was not merely faster software; it made the operating model possible.

### “How do you use AI coding agents safely?”

> I treat an agent as an untrusted, high-speed contributor—not as an authority.
>
> I give it a bounded task and the relevant context, but its output still goes through diff review, tests, type checking, integration verification, and release gates. Security-sensitive or state-changing operations stay behind deterministic authorization boundaries.
>
> PaperCusp grew from that principle. It adds durable work claims, dependency-aware scheduling, collision prevention, audit trails, restart recovery, and guarded deployment for fleets of agents. My advantage is not simply that I use AI tools; I understand how they fail and how to constrain them.

### “How do you approach a production incident?”

> First I establish customer impact and contain it without destroying evidence. Then I identify which invariant failed, use metrics and traces to isolate the failing boundary, and restore service through the safest reversible action.
>
> The incident is not finished when service returns. I identify the originating cause, add a test or detector for the entire failure class, and update the operational path so recurrence is caught earlier.
>
> As a founder, there was no escalation tier above me. I owned the diagnosis, remediation, and prevention.

Have one real Store Wolf incident ready. Use this order:

**Impact → detection → containment → root cause → durable fix → recurrence guard.**

Do not invent whether it was an oversell, stale price, or marketplace outage; choose an event you can defend under follow-up questions.

### “How do you design low-latency services?”

> I begin with an explicit latency budget and measure each boundary independently. I separate authoritative state from acceleration layers, remove unnecessary network hops, cache only data whose freshness semantics are understood, and bound concurrency before downstream services saturate.
>
> I also design the overload behavior. Deadlines, backpressure, bulkheads, circuit breakers, idempotency, and graceful degradation matter as much as the happy-path median. The relevant target is not simply average latency; it is predictable tail latency under realistic load.

### “How do you protect sensitive member data?”

> I minimize collection first, then separate identity, authorization, and business data so no component receives more than it needs. I use least-privilege access, encryption in transit and at rest, managed secrets, structured audit trails, dependency scanning, and server-side validation at every trust boundary.
>
> I treat browser input, third-party integrations, and AI output as untrusted. Sensitive actions require deterministic authorization; model confidence never becomes permission.

### “What is a weakness?”

> I naturally go deep on technical details, and earlier in my career I sometimes explained the machinery before explaining the decision. I’ve learned to lead with the outcome, constraint, and tradeoff, then go deeper only where it helps the audience make the decision.

That answer is credible and fixable without undermining a core requirement.

### “Why did Store Wolf end?”

Your profile does not state the reason. Prepare one factual sentence and pivot:

> Store Wolf concluded because **[actual reason]**. It was a twelve-year chapter that taught me how to build systems whose correctness has direct financial consequences. Since then, I’ve focused on modern distributed and AI-assisted engineering, and I’m now looking to bring both bodies of experience to a strong product organization.

## Compensation

Start by asking for their range:

> I’m primarily evaluating the role, team, and scope, and I’d like to understand how arrivia has leveled and budgeted the position. What base and total-compensation range is approved?

If they insist before sharing it:

> I’m looking for market-competitive senior-engineer compensation and evaluating the complete package. A base around $175,000 would be a reasonable anchor, with flexibility depending on bonus, equity, benefits, and the actual scope.

Adjust that number to your real walk-away point. Do not give a range whose bottom you would reject.

## Questions to ask the recruiter

Choose four:

1. “Is this role open because of growth, replacement, or a specific modernization initiative?”
2. “Which product and engineering group would this person join, and what is the most important problem that team is solving?”
3. “How does arrivia distinguish success at Senior Engineer from the next level?”
4. “How much of the work involves integrating or consolidating systems across the ICE, SOR Technology, and WMPH brands?”
5. “What does AI-assisted development look like in practice—individual tool choice, or an organization-wide workflow and security policy?”
6. “What are the interview stages, and what will each stage evaluate?”
7. “What compensation band has been approved for the role?”

Do not assume the acquired brands still have separate systems; ask.

## Questions for the hiring manager later

- “Which service currently owns the tightest latency or throughput constraint?”
- “What are the team’s important SLOs, and where does operational toil concentrate today?”
- “What does an on-call rotation look like, and how are incidents converted into engineering work?”
- “Where does the architecture intentionally fail closed versus degrade gracefully?”
- “What would you expect this engineer to own independently within six months?”
- “Which engineering decision is currently hardest to reverse?”

## Avoid these mistakes

- Do not lead with PaperCusp or “50 agents.” Lead with production commerce.
- Do not call yourself a solo developer; say you owned systems end to end.
- Do not imply that agents replace review, testing, or engineers.
- Do not claim conventional large-company experience you do not have.
- Do not spend five minutes explaining an algorithm during a recruiter screen.
- Do not sound as though arrivia is temporary while you wait for PaperCusp funding.
- Do not apologize for 13 years of experience. Frame it as low-ramp, high-ownership value.

## Closing statement

> From what you’ve described, the role aligns closely with what I want: meaningful ownership across the stack, real performance and reliability requirements, and a team using AI as leverage inside disciplined engineering practices. I’d be very interested in continuing to the technical conversations.

Before the call, memorize only the opening and closing. For everything else, keep five prompts beside you:

**$1M/month · millions of SKUs · 100K graph/~60 seconds · 50+ agents · founder-to-team transition.**
