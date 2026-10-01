---
rel_path: "legal/agent-economy-counsel-brief-2026-10-01.md"
updated_at: 1790819962763
_body: "content"
---

# Draft counsel brief for the Papercusp agent economy

Prepared for Avi and prospective counsel on 1 October 2026. This packet proposes drafting instructions for entity structure, contributor rights and license-as-membership. Counsel selection, budget, entity formation and adoption of new license terms remain unresolved. The recommended review sequence is to identify the operating company and rights holder, choose the DAO wrapper, then finalize the CLA and license together.

This is a counsel-review draft. Bracketed terms require a decision before execution. It does not form an entity, appoint a lawyer, amend the current license, or represent a legal opinion.

## Product facts and approved constraints

The agent economy plan treats a signed, versioned agent identity as the main marketplace product; components can also be sold separately. Buyers bring their own inference accounts. A seller chooses an inference markup; the listing suggests 20%. Each priced identity in a stack charges its own markup. The DAO receives 10% of the markup payment, with creators and component authors sharing the remaining 90%. Inference paid directly to a model provider is separate from the marketplace payment.

For illustration, USD 100 of inference with one 20% markup yields a USD 20 marketplace charge: USD 2 for the DAO and USD 18 for the creator/component allocation. The DAO share is contained in that USD 20. The illustration excludes taxes, payment fees and other priced layers; their treatment needs explicit terms.

Avi approved an operating company to own Stripe, banking and tax responsibilities, with a DAO legal wrapper added before mainnet to own the Safe treasury. Phase A uses testnet. Mainnet capital and Safe signer selection require the prepared cutover process. Governance begins with reputation; a transferable token is outside the present counsel brief and requires a separate review. The transparency direction is hourly provisional reporting and anchoring, with a signed monthly statement after reconciliation.

These constraints come from the agent economy plan's ratified decisions D-004, D-007, D-013 and D-014. The plan's P-002 requests the present packet; its acceptance bar requires delivery to Avi and his receipt. The legal engagement is a separate step.

## Entity options for counsel

| Option | Statutory starting point | Questions for this product |
| --- | --- | --- |
| Wyoming DAO LLC | A Wyoming LLC elects DAO status in its articles; it needs a Wyoming registered agent. Articles identify relevant smart contracts. Governance contracts must be upgradeable. [Wyoming Title 17, sections 17-31-104 through 109](https://wyoleg.gov/statutes/compress/title17.pdf) | Can this wrapper own the Safe and license rights while the operating company handles customers? Define members, voting, tax treatment, signer authority and the relationship between code and written agreements. |
| Wyoming UNA | The ordinary unincorporated nonprofit association route under chapter 22 is distinct from a DUNA under chapter 32. [Wyoming Title 17](https://wyoleg.gov/statutes/compress/title17.pdf) | Define the nonprofit purpose, membership, authority to hold assets and contract, and the commercial company's funding agreement. Obtain banking and tax advice for the actual structure. |
| Wyoming DUNA | The statutory definition uses 100 members. Section 17-32-104 allows profit-making for the nonprofit purpose, restricts dividends/profit distributions, and permits specified compensation. [Wyoming Title 17](https://wyoleg.gov/statutes/compress/title17.pdf) | Confirm eligibility and distinguish creator compensation from member profit sharing. Check member-count changes, admission and withdrawal against the charter. |
| Foundation | One concrete comparison is a Cayman foundation company under the [Foundation Companies Act, 2025 Revision](https://legislation.gov.ky/cms/images/LEGISLATION/PRINCIPAL/2017/2017-0029/2017-0029_2025%20Revision.pdf), especially sections 4, 7, 8, 15 and 16. | Counsel must choose a jurisdiction; this example is not an owner selection. Compare directors/supervisors, community control, permitted payments, service-provider costs, tax reporting and enforcement of the relationship with the operating company. |

Wyoming amended UNA/DUNA provisions in 2026, including liability wording, definitions and conversion/winding-up rules. Counsel should reconcile chapter 32 with the enrolled amendment rather than reuse an older formation checklist. [2026 SF0022, Enrolled Act 21](https://www.wyoleg.gov/2026/Enroll/SF0022.pdf)

Proposed evaluation: keep the operating-company decision fixed while comparing wrappers on governance fit, permitted contributor payments, tax and banking feasibility, recurring cost, control of intellectual property, and enforceability across the intended customer jurisdictions. A nonprofit label alone is not a conclusion about tax exemption. Counsel and a CPA should provide the classification for the selected structure.

Counsel should document the ownership and contractual boundary for each asset: software copyright, trademarks, identity packages, customer contracts, provider accounts, Stripe receivables, customer-credit liabilities, DAO payables and the Safe. Specify how the DAO's 10% is accrued and transferred, how refunds change that payable, and which entity is responsible if software records and legal entitlements disagree.

## CLA draft for review

The baseline is the existing `scripts/public-release/CLA.md`, read alongside the current Elastic License 2.0 and CONTRIBUTING notice. It already retains contributor copyright and grants copyright and patent rights, including distribution under other license terms. This draft reuses that structure and makes the unresolved legal recipient explicit. It is not a claim that existing signatures, employer permissions or third-party rights have been audited.

### Parties and contribution

This Contributor License Agreement is between [full legal name of rights holder, jurisdiction and address] (the Project) and [contributor name and signing capacity] (you). A Contribution is work you intentionally submit for inclusion in [named Papercusp repositories], including code, documentation and agent package material. Work clearly marked as excluded from contribution is excluded. Acceptance covers [identified submissions and future submissions to those repositories].

### Copyright grant

You retain ownership of your Contribution. You grant the Project and recipients of its distributions a perpetual, worldwide, nonexclusive, royalty-free and irrevocable copyright license to reproduce, modify, create derivative works, display, perform, distribute and sublicense your Contribution. The grant includes distribution under future Project license terms, including source-available, commercial, membership-based and delayed-open-source terms. You may continue using and licensing your own work.

### Patent grant

You grant the Project and its recipients the corresponding patent license for claims you control that are necessarily infringed by your Contribution alone or combined with the Project to which it was submitted. Counsel should retain and finalize the baseline's patent-litigation termination provision, including precisely whose license terminates and on what trigger. This grant does not purport to license third-party patents you do not control.

### Authority and provenance

You represent that you can grant these rights. Where an employer or other person owns or controls rights, provide its authorization or an authorized corporate signature. Identify third-party material, its source, license and any restrictions; do not offer rights you lack. For AI-assisted material, disclose applicable provider terms or provenance limitations requested by the contribution policy. Notify the Project when you learn that a representation was materially inaccurate.

### Acceptance and limits

The Project may decline a Contribution. Contributions are provided without warranty to the extent permitted by applicable law. This agreement alone gives no compensation, treasury distribution, equity, membership, voting rights or trademark license; those require separate written terms. No contributor copyright assignment is implied.

### Signature and governing terms

Record the contributor's identity, capacity, agreement version/hash, covered repositories, timestamp and affirmative assent. Counsel must fill [governing law], [forum], [notice address], [permitted successor/assignment terms], and any mandatory protections. An organization requires an authorized signatory. Preserve the signed agreement and the applicable contribution evidence.

Before adopting this draft, counsel must identify the present CLA recipient behind the baseline's “we,” determine what existing assents cover, approve succession or rights transfers between the operating company and wrapper, and establish a rights census. A new CLA does not create retroactive permission from non-signers or replace third-party licenses. The current public CLA and license remain the distribution baseline until the rollout has its own approved terms and verified rights coverage.

## License-as-membership term sheet

The following are proposed negotiating terms. The revenue threshold, dues formula, license recipient and delayed-opening election are not approved numerical or legal choices.

| Term | Draft instruction for counsel |
| --- | --- |
| Parties and software | Name [rights holder] as licensor and [legal customer] as licensee. Identify covered repository/package names and a release hash. Separately identify the operating company supplying network services and the DAO wrapper admitting members. |
| Free tier | Permit personal use, noncommercial education/research, and commercial use below the agreed revenue threshold without mandatory paid membership. Specify copying, modification and redistribution permissions. Purchased identities, hosted services and provider inference retain their separate published charges; free software use does not promise free services. |
| Revenue threshold | Set [T in USD] before signing. Proposed measurable basis: the licensee's consolidated worldwide gross revenue over the preceding 12 months, net of refunds and collected sales tax; define control, affiliates, currency conversion, startups and reorganizations. Counsel and Avi must choose whether this covers total enterprise revenue or only attributable products. State the threshold-crossing date, declaration process and a reasonable cure period. |
| Membership clause | Above T, continued covered commercial use requires a written commercial grant plus admission and good standing under the named membership charter. Define dues or revenue-share [formula and base], reporting period, renewal, notice, cure and appeal. Payment alone does not silently create statutory membership. Identify the admitted legal person and its authorized representative. |
| Membership rights | Define participation and reputation-weighted governance in the charter. Draft membership without a promised investment return or automatic right to treasury profits. Reconcile that design with the chosen entity law. Contribution compensation, marketplace revenue splits and membership dues are separate obligations. |
| Economics | Preserve the approved 10% DAO allocation of identity markup. Software membership dues/revenue share are an additional proposed stream whose amount is unset. State refunds, chargebacks, taxes, fees and rounding explicitly, and avoid charging the DAO take a second time. |
| Version pinning promise | Include an immutable schedule recording release hash, release date, license text/hash, threshold and payment terms. Proposed clause: changes apply prospectively to newly accepted releases or service renewals; they do not silently replace the software grant for an already accepted release. Define ongoing membership duties for a pinned release and any lawful termination conditions. A pinned software grant does not guarantee perpetual service access or maintenance. |
| Enforcement | Enforce current network eligibility at marketplace listing, federation and gateway access according to the published service terms, with notice/cure and appeal. Distinguish those services from the rights in a locally held release. Specify what continues after suspension, including data export, earned payments and record retention. |
| Distribution and branding | Specify required license notices, derivative-work treatment, dependency exclusions and trademark rules. Do not label a license with revenue or membership restrictions as an unrestricted open-source grant. |
| Liability and disputes | Counsel drafts warranty, liability, termination, consumer protections, privacy, audit limits, governing law and dispute terms for the customer jurisdictions. Revenue verification should disclose the minimum needed information, not customer secrets in the public ledger. |

Suggested membership language for counsel to refine: “If your Covered Revenue exceeds [T] under Schedule A, continued Covered Commercial Use requires the commercial permission and membership terms identified in that schedule. Membership begins only through the admission procedure. The rights and obligations for a Release are those recorded in its immutable license schedule, subject to its express termination provisions.”

Boundary cases to resolve before adoption: an affiliate using the software for a larger group; a reseller or hosted competitor; a nonprofit with commercial activity; a company crossing or falling below T mid-period; a fork pinned to an older release; an identity assembled from differently licensed components; cancellation while earned seller payouts remain pending; and a refund after the DAO share has been transferred.

## Optional two year delayed opening

One option is an irrevocable future permissive grant for each release, effective two years after that release was made available. The upstream FSL-1.1-MIT template defines software by version, grants MIT rights on the second anniversary, and restricts competing uses during the initial period. It does not impose the revenue-threshold membership model proposed here. Adding that requirement would require a separately named, reviewed license rather than representing the altered text as standard FSL. [Upstream FSL-1.1-MIT template](https://github.com/getsentry/fsl.software/blob/main/FSL-1.1-MIT.template.md)

Counsel should compare: (A) the custom membership license without delayed opening; (B) that license with an explicit release-specific MIT or Apache-2.0 future grant; and (C) unmodified FSL plus separately contracted network membership. These are alternatives, not simultaneously adopted terms.

For B, record [future license], the first availability date and exact anniversary rule with each release; state how derivatives and separately licensed dependencies are treated. Example: a covered release first available on 1 October 2026 would have a scheduled future grant on 1 October 2028; a later release has its own date. Once the permissive grant applies, the earlier membership restriction must not be presented as a condition of that grant. Network service agreements remain separately defined. Do not promise permissions for rights the licensor does not control.

## Engagement scope and outstanding decisions

Request a staged quote from counsel experienced in software licensing and DAO entities, with a CPA covering tax and accounting. The first stage should produce a written entity comparison and rights/CLA assessment. The second should deliver final drafts for the selected wrapper, operating-company relationship, CLA, membership charter, commercial license and optional future grant. Obtain a separate compliance review for the actual payment flow, custody, customer balances, seller payouts and intended jurisdictions before mainnet or live payment operations.

Required client inputs are the existing entity documents, owner/residency and customer jurisdictions, member count and admission design, present CLA signatures and contribution history, dependency licenses, revenue-flow diagram, Safe contracts and intended signers, and the proposed threshold/dues model. Counsel should identify missing information rather than treat software assertions as legal facts.

Avi's outstanding choices are counsel and engagement budget. The packet also leaves the wrapper jurisdiction/form, legal rights holder, T and its revenue base, membership dues formula, and delayed-opening election explicit for that engagement. No external lawyer has been retained through this work. Receipt of this packet must be recorded separately; a successful save or queued delivery is not evidence that Avi read it.

## Review coverage

| Requested element | Location in this packet |
| --- | --- |
| WY DAO LLC versus UNA versus foundation | Entity options for counsel; ordinary UNA and DUNA distinguished |
| CLA draft | CLA draft for review, including rights, patents, authority and signature |
| Free tier | License-as-membership term sheet |
| Revenue threshold | License-as-membership term sheet, including unresolved T and revenue base |
| Membership clause | Term sheet and suggested clause |
| Version-pinning promise | Immutable release schedule and prospective changes |
| Optional FSL-style two-year opening | Optional two year delayed opening, with standard FSL/custom terms distinguished |
| Counsel and budget handoff | Engagement scope and outstanding decisions |

The related DAO/banking brief is `~/.papercusp/artifacts/dao-launch-and-auditable-banking-2026-09-30.md`. This packet refines its legal handoff using the newer ratified plan decisions. Primary authorities and the upstream license were checked on 1 October 2026; legal conclusions and final executable language remain counsel's work.

