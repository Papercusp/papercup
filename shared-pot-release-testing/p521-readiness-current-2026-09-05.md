# P521 current preparation snapshot

Artifact pending. This is a computed source-only NO-GO interpretation. No physical journey has passed on a unified candidate.

| Capability | State | Result | Scenario | Evidence | Owner |
| --- | --- | --- | --- | --- | --- |
| artifact-provenance | unmeasured | unknown | F7: reproduce minimal runtime and identify dependencies, migrations, seed and optional packs | 759d62125e5f | su-f54d7965-118b-4647-aa7d-6fa08663a8b7 |
| discovery-join | unmeasured | unknown | Fresh packaged owner and joined device discover the same pinned hive with admitted identities | e1bedd18b288 | su-315c424d-0ca8-4108-aede-41a6d84a6c1d |
| exact-peer-git | unmeasured | unknown | F1/F2/P203: named peers, current store generation and exact signed refs at a recorded watermark; negative population controls | fbb750480b49 | su-fa658170-b1b3-4b74-9918-946ade7e8017 |
| serving-signing-identity | source-tested | unknown | F3: packaged separate-process publication across owner restart, expired or omitted discovery and generation replacement | e3755c7be7de | su-315c424d-0ca8-4108-aede-41a6d84a6c1d |
| replicated-write-recovery | source-tested | unknown | F4: transient apply outage preserves unapplied state; recovery and replay converge without permanently skipping writes | 8404c13c2c48 | su-315c424d-0ca8-4108-aede-41a6d84a6c1d |
| trusted-delegated-seats | unmeasured | unknown | F5/P202: target-bound grant, real headless boot and first work, receipts, visible stop and revocation on the candidate | 602004d73529 | su-f54d7965-118b-4647-aa7d-6fa08663a8b7 |
| protected-effects-fencing | source-tested | unknown | F6/D022: owner-only canonical/ref, GitHub, submodule and fork/PR effects; stale/device-only authority and divergent elections cannot publish | 314318b5bf8f | su-315c424d-0ca8-4108-aede-41a6d84a6c1d |
| github-bridge | unmeasured | unknown | P204: bridged TEST hive keeps members commit-only and owner-authorized bridge publishes the exact admitted refs | 7221bff3e08f | su-f54d7965-118b-4647-aa7d-6fa08663a8b7 |
| full-offline-installer | unmeasured | unknown | Full offline installer restores/joins the same supported hive and is compatible with the minimal witness | f287f565aeb2 | su-f54d7965-118b-4647-aa7d-6fa08663a8b7 |
| independent-go | unmeasured | unknown | Independent non-implementer reviews exact artifact and all mandatory evidence, then signs GO through existing verdict authority | ff7de302161b | pending:independent-non-implementer |

```json
{
  "nodes": [
    {
      "capability": "artifact-provenance",
      "state": "unmeasured",
      "remaining": true
    },
    {
      "capability": "discovery-join",
      "state": "unmeasured",
      "remaining": true
    },
    {
      "capability": "exact-peer-git",
      "state": "unmeasured",
      "remaining": true
    },
    {
      "capability": "serving-signing-identity",
      "state": "source-tested",
      "remaining": true
    },
    {
      "capability": "replicated-write-recovery",
      "state": "source-tested",
      "remaining": true
    },
    {
      "capability": "trusted-delegated-seats",
      "state": "unmeasured",
      "remaining": true
    },
    {
      "capability": "protected-effects-fencing",
      "state": "source-tested",
      "remaining": true
    },
    {
      "capability": "github-bridge",
      "state": "unmeasured",
      "remaining": true
    },
    {
      "capability": "full-offline-installer",
      "state": "unmeasured",
      "remaining": true
    },
    {
      "capability": "independent-go",
      "state": "unmeasured",
      "remaining": true
    }
  ],
  "edges": [
    {
      "from": "discovery-join",
      "to": "artifact-provenance"
    },
    {
      "from": "exact-peer-git",
      "to": "discovery-join"
    },
    {
      "from": "serving-signing-identity",
      "to": "exact-peer-git"
    },
    {
      "from": "replicated-write-recovery",
      "to": "discovery-join"
    },
    {
      "from": "trusted-delegated-seats",
      "to": "discovery-join"
    },
    {
      "from": "protected-effects-fencing",
      "to": "serving-signing-identity"
    },
    {
      "from": "github-bridge",
      "to": "protected-effects-fencing"
    },
    {
      "from": "full-offline-installer",
      "to": "artifact-provenance"
    },
    {
      "from": "independent-go",
      "to": "exact-peer-git"
    },
    {
      "from": "independent-go",
      "to": "full-offline-installer"
    },
    {
      "from": "independent-go",
      "to": "github-bridge"
    },
    {
      "from": "independent-go",
      "to": "protected-effects-fencing"
    },
    {
      "from": "independent-go",
      "to": "replicated-write-recovery"
    },
    {
      "from": "independent-go",
      "to": "serving-signing-identity"
    },
    {
      "from": "independent-go",
      "to": "trusted-delegated-seats"
    }
  ]
}
```
