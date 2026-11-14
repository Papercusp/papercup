---
rel_path: "portability/review/primary-outcome-r4-r7-v1.json"
updated_at: 1794179995315
_body: "content"
---

{
  "rubricRef": "acceptance-portable-papercusp-container-and-native-2026-10-06",
  "criteria": [
    {
      "key": "r-1",
      "title": "Phase 0 measured native vs container cost and today's moving cost",
      "intent": {
        "request": "Measure first: would containers hurt performance, and how hard is a move today.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:5",
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:8",
          "D-005",
          "D-007",
          "D-008"
        ]
      },
      "model": "Linux and Windows native-vs-container results and a timed full restore rehearsal with a breakage inventory are recorded on the work item.",
      "bar": "Linux and Windows native-vs-container results and a timed full restore rehearsal with a breakage inventory are recorded on the work item.",
      "barKey": "R-1",
      "barHash": "10e54286f360095d042245428d418572a99656f373e4011161dc2ca1dfca9b1c",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "Read WI-10006429 posts 1160112, 1160167, 1160265, 1160287 and 1160298 and ~/p0-bench/results.\n\nGoverns: D-005, D-007, D-008. Verification conditions: record Linux and Windows native/container measurements and the Phase 0 full restore duration and breakage inventory. Use the named WI-10006429 posts as durable evidence; ~/p0-bench/results alone is insufficient for another grader. This is the manual Phase 0 restore (P-052), distinct from the product export/import rehearsal in R-6.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "A Phase 0 result the plan relies on has no recorded measurement.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-2",
      "title": "Every state path is classified, and an unclassified one fails a check",
      "intent": {
        "request": "Bring the full app, DB and settings to another machine: know exactly what the state is.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:0",
          "D-004"
        ]
      },
      "model": "The generated state manifest classifies each required persistent input under the declared state taxonomy.",
      "bar": "The generated state manifest classifies each required persistent input under the declared state taxonomy.",
      "barKey": "R-2",
      "barHash": "3dfcd3b7ea26ea2c53d9ecd59455b57c5cf758420aab0d94b03c493ccc65d43c",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "MANDATORY CONTRACT SCOPE (each original condition is still a pass requirement): A generated state manifest classifies every state root entry, database, unit and secret as state, config, secret, cache or dev-only, and its drift check fails on an unclassified entry.\nRun the census drift-check unit tests, including a fixture with an unclassified path.\n\nGoverns: D-004. Verification conditions: enumerate every state-root entry, database, unit and secret; classify each as state, config, secret, cache or dev-only; inject an unclassified entry and observe the drift check fail. Resolve packages/operator-core/lib/backup/state-census-producers.test.ts and state-census-cli.test.ts and identify which assertions cover these conditions before binding tests; a passing file without the falsifier is insufficient.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "An unclassified state path passes the drift check.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-3",
      "title": "Every install keeps its state in declared roots",
      "intent": {
        "request": "One state layout for native and container installs so export/import is variant-independent.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:12",
          "D-004"
        ]
      },
      "model": "The Server resolves its PG data, state, secrets and cache roots from one data-roots module that honours environment overrides, and the native installers use it.",
      "bar": "The Server resolves its PG data, state, secrets and cache roots from one data-roots module that honours environment overrides, and the native installers use it.",
      "barKey": "R-3",
      "barHash": "1adf88420a1b601e224cd090eca98726d68bf435ab6c044bb51464bafb91c15c",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "Data-roots unit tests plus the no-hardcoded-home lint.\n\nGoverns: D-004. Verification conditions: exercise PG data, state, secrets and cache roots with default and overridden environments; verify one roots resolver supplies the Server and native installers; run the no-hardcoded-home lint. Record exact test/lint paths and exercised assertions on the implementing work item before adding structured bindings.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "Product code resolves a state, PG data, secret or cache location outside the data-roots module.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-4",
      "title": "papercusp export writes one consistent, self-describing bundle",
      "intent": {
        "request": "Make moving the full app, DB and settings easier.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:0",
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:2"
        ]
      },
      "model": "An export preserves one consistently recoverable instance under its complete portable manifest.",
      "bar": "An export preserves one consistently recoverable instance under its complete portable manifest.",
      "barKey": "R-4",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "MANDATORY ORIGINAL CONTRACT (every condition remains required): An export contains a single-snapshot PG dump, the state roots minus caches, an encrypted secrets bundle that includes the DB encryption key, and a manifest with product version, migration head, PG and extension versions and source identity.\nExport unit and integration tests against a scratch PG.\n\nGoverns: D-004, D-009(4)-(5). Verification conditions: verify one consistent PG snapshot, declared state roots with caches omitted, encrypted secrets including the DB encryption key, and every manifest field (product version, migration head, PG version, extension versions, source identity). Exercise full-by-default and explicit optional export tiers. Record scratch-PG fixture, exported manifest and exact deciding test assertions.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "An export omits the DB encryption key, mixes PG snapshots, or lacks a manifest field.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-5",
      "title": "papercusp import restores safely and never impersonates the source",
      "intent": {
        "request": "Bring an installation to a different machine.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:0",
          "D-004"
        ]
      },
      "model": "Import activates only a compatible restored instance under fresh destination device identity.",
      "bar": "Import activates only a compatible restored instance under fresh destination device identity.",
      "barKey": "R-5",
      "barHash": "542606ae9496f1317e72f18a439e78ca7532e827554edfa91c5ed1a4e191d8dc",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "MANDATORY CONTRACT SCOPE (each original condition is still a pass requirement): Import verifies the manifest, refuses a downgrade, restores, migrates forward, rewrites behaviour-driving root paths, and regenerates machine identity; dry-run changes nothing.\nImport unit and integration tests, including downgrade refusal and identity regeneration.\n\nGoverns: D-004, D-009(5), D-010. Verification conditions: verify manifest validation and mismatch refusal; refuse a downgrade; restore an older supported version and migrate forward; rewrite behaviour-driving roots with no source-root residue; regenerate machine identity; observe imported health checks; prove dry-run changes no state. Use the P-056 split clauses as additional proof references, retaining every model assertion. Record exact unit/integration test paths and positive/negative controls before binding.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "An imported install keeps the source node identity, accepts an older product version, or dry-run writes state.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-6",
      "title": "This dev box's move is rehearsed and timed",
      "intent": {
        "request": "How hard would it be to bring our full install to a different machine.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:0",
          "D-001"
        ]
      },
      "model": "The full native dev-box instance passes a timed product export/import rehearsal into an isolated scratch VM.",
      "bar": "The full native dev-box instance passes a timed product export/import rehearsal into an isolated scratch VM.",
      "barKey": "R-6",
      "barHash": "b8d155b0526536c46dfb766539375747dbc96da2cc5c3846ec9c1c076b8eee10",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "MANDATORY CONTRACT SCOPE (each original condition is still a pass requirement): The native dev box is exported in full and imported into a scratch VM, health checks pass, and the source box is unaffected; the timed procedure is recorded.\nRehearsal log and timings on the P-057 work item.\n\nGoverns: D-001, D-008, D-009, D-010. Verification conditions: run the product export/import tools on the full native dev-box instance and a scratch VM; record export/import durations, imported health, source-service health and unchanged source identity. Evidence belongs on the P-057 work item with exact log/manifest references. The Phase 0 P-052 manual restore does not discharge this product rehearsal.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "The rehearsal needed an unrecorded manual step or the import failed health checks.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-7",
      "title": "The Server ships as a container image built from the same bundle",
      "intent": {
        "request": "Containerized versions of the Linux, Mac and Windows builds sharing the native pipeline.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:2",
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:5",
          "D-002",
          "D-003",
          "D-004"
        ]
      },
      "model": "Published OCI artifacts run the identical Server payload as native installers for the same signed release.",
      "bar": "Published OCI artifacts run the identical Server payload as native installers for the same signed release.",
      "barKey": "R-7",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "MANDATORY ORIGINAL CONTRACT (every condition remains required): An OCI image for amd64 and arm64 runs the bundle-host.sh bundle on the shared runtime rootfs, with an SBOM and the release signature.\nBuild the image and compare its bundle digest with the native artifact of the same build.\n\nGoverns: D-002, D-003, D-004, D-010. Verification conditions: verify published amd64 AND arm64 image manifests, the same-build native/OCI Server bundle digest and shared rootfs lineage, the image SBOM, and its signature against the trusted release identity. Record image/manifest digests, native payload hashes, SBOM digest and signature verification receipt. A local unsigned image or one architecture leaves the missing conditions unknown. R-7 owns image identity/publication; R-16 separately owns one-release-run provenance and the complete artifact family.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "The image runs a different Server build than the native installer of the same release.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-8",
      "title": "Agent processes stay confined inside the container",
      "intent": {
        "request": "Any capability the native version has that the container would not.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:5"
        ]
      },
      "model": "Inside the container the task manager confines and kills agent process trees through systemd with cgroup delegation, and host signals are labelled container-scoped.",
      "bar": "Inside the container the task manager confines and kills agent process trees through systemd with cgroup delegation, and host signals are labelled container-scoped.",
      "barKey": "R-8",
      "barHash": "68a8d379707b24ff632584c183779da06b60e0088e2a3a286c3bcbdac6d70ee5",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "Kill a spawned process tree inside the running container and check it is gone.\n\nGoverns: D-002, D-004 and the agent-confinement requirement. Verification conditions: spawn parent/child/grandchild agents inside the container, confirm systemd/cgroup delegation owns the tree, terminate it and verify no descendant survives; verify displayed host signals explicitly identify their container scope. Record the exact image, task/unit and before/after process evidence.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "An agent process tree survives processes:kill inside the container, or confinement silently degrades.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-9",
      "title": "Linux users can run the container Server with podman or Docker",
      "intent": {
        "request": "Support the container version on Linux.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:8",
          "D-002"
        ]
      },
      "model": "A generated rootless podman quadlet (and a Docker equivalent) starts the Server with volumes on the declared data roots and survives a reboot.",
      "bar": "A generated rootless podman quadlet (and a Docker equivalent) starts the Server with volumes on the declared data roots and survives a reboot.",
      "barKey": "R-9",
      "barHash": "581b3110d10ffcd778f027ea3e674e310ff444ae6e982f692e0a680edd11ec77",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "Install and restart the container Server in the Linux test VM.\n\nGoverns: D-002, D-009(1). Verification conditions: run the generated rootless podman quadlet and Docker equivalent in a Linux test VM, verify declared data-root mounts, reboot and observe Server/state recovery. Verify PG data is on a named volume, never the image overlay. Record the quadlet/unit, image digest, volume mapping and reboot receipt.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "The container Server loses state across restart or needs hand-written unit files.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-10",
      "title": "Windows runs the same image as its WSL runtime",
      "intent": {
        "request": "Support the container version on Windows with one pipeline.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:8",
          "D-002",
          "D-004"
        ]
      },
      "model": "The WSL distro rootfs and the container image come from one build artifact, and the Windows container variant runs the Server with its state on the WSL ext4 side.",
      "bar": "The WSL distro rootfs and the container image come from one build artifact, and the Windows container variant runs the Server with its state on the WSL ext4 side.",
      "barKey": "R-10",
      "barHash": "b6063c6e19b63bce734e67afba2d012ab2fed3b3d0077b613bcc01392cb46ce2",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "Compare artifact digests and run the variant in papercup-vm-win.\n\nGoverns: D-002, D-004, D-009(2). Verification conditions: prove the WSL distro IS the same container image export, run the Server directly in papercup-vm-win, and verify all state resides on WSL ext4. Exercise the /mnt/c PG-data refusal and use host networking as decided. Record image/export digest lineage, distro identity and state-path observations.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "Windows ships a rootfs built separately from the container image, or keeps state under /mnt/c.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-11",
      "title": "macOS runs the container Server in a managed Linux VM",
      "intent": {
        "request": "Support the container version on macOS.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:8",
          "D-002",
          "D-007"
        ]
      },
      "model": "The macOS native GUI manages the selected container VM lifecycle.",
      "bar": "The macOS native GUI manages the selected container VM lifecycle.",
      "barKey": "R-11",
      "barHash": "71976cae00fe93fdac53333cc0587cb57212c2fc0dce05a2213c03ce57a597b8",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "MANDATORY CONTRACT SCOPE (each original condition is still a pass requirement): The macOS GUI can create, size, start at login, update and stop the Linux VM that runs the Server image, with workspaces on the VM volume.\nLifecycle tests plus a run on available macOS hardware.\n\nGoverns: D-002, D-007, D-009(3). Verification conditions: on real Apple silicon, create and size the podman machine VM, start it at login, update and stop it, and verify workspaces reside on the VM volume. Lifecycle unit tests can establish GUI logic only. papercup-vm-mac's emulated Intel guest with kern.hv_support=0 cannot discharge the VM run; absent real-Mac evidence is unknown. Record machine/runtime identity and each lifecycle observation.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "The macOS container variant needs the user to install or manage the VM by hand.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-12",
      "title": "The GUI finds and connects to a container Server",
      "intent": {
        "request": "The native window talks to a containerized Server.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:12",
          "D-003"
        ]
      },
      "model": "The GUI connects to a local container Server through the BYOC connection path, terminals open inside it, OAuth callbacks reach it, and with no Server found it offers an install flow.",
      "bar": "The GUI connects to a local container Server through the BYOC connection path, terminals open inside it, OAuth callbacks reach it, and with no Server found it offers an install flow.",
      "barKey": "R-12",
      "barHash": "54a0e9f0f90c644ba95633cd519861d659d8b78e3c66088bec80e92221bf057c",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "Drive the GUI against a container Server headless.\n\nGoverns: D-003. Verification conditions: drive the native GUI against a local container Server through BYOC; open a terminal and show it executes inside that Server; complete an OAuth callback; remove discovery evidence and observe the install flow. Record GUI build, image/Server identity and each journey result.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "A container Server is reachable but the GUI cannot open a terminal or complete an agent CLI login.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-13",
      "title": "Host credentials reach agents in the container",
      "intent": {
        "request": "Native capabilities the container must not lose.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:5"
        ]
      },
      "model": "The SSH agent, git credential helper, OS keychain secrets and agent CLI logins are usable by agents in the container, and repos outside the volume can be mounted from the GUI.",
      "bar": "The SSH agent, git credential helper, OS keychain secrets and agent CLI logins are usable by agents in the container, and repos outside the volume can be mounted from the GUI.",
      "barKey": "R-13",
      "barHash": "ad229dff0b9e4ca67f0c70bdb485b37f98742fdfa4249391362be7ab5041c35a",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "Forwarding tests in the Linux test VM.\n\nGoverns: D-002, D-003 and the host-credential/volume requirement. Verification conditions: independently use forwarded SSH-agent credentials, git credential helper, OS-keychain secrets and agent CLI login from an agent inside the container; mount a repository outside the volume through the GUI and use it. Record each mechanism's successful operation without disclosing secrets, plus OS/runtime and mount identity.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "An agent in the container cannot push to a repo the host user can push to.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-14",
      "title": "Container upgrades are checked and reversible",
      "intent": {
        "request": "Maintain the container version alongside native.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:5",
          "D-002"
        ]
      },
      "model": "An upgrade pins the image tag, checks migration compatibility first, snapshots data, and can roll back to the previous image and snapshot.",
      "bar": "An upgrade pins the image tag, checks migration compatibility first, snapshots data, and can roll back to the previous image and snapshot.",
      "barKey": "R-14",
      "barHash": "82c9157620f657120288f834f89638d080e6b2348d3e9a2b215bf2c1ab0c5d6d",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "Upgrade and rollback test with a forced failure.\n\nGoverns: D-002 and the upgrade/rollback requirement. Verification conditions: pin the image tag/digest; observe migration-compatibility checking before writes; snapshot data; force upgrade failure; restore the prior image AND snapshot and verify data/health. Record old/new digest, compatibility decision, snapshot id, forced failure and rollback receipt.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "A failed upgrade leaves the install unable to start on either image.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-15",
      "title": "Dev and test tooling works inside the container",
      "intent": {
        "request": "Any capability the native version has that the container would not.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:5"
        ]
      },
      "model": "Testcontainers-based tests and Xvfb run inside the container Server, and unsupported tooling per OS is documented.",
      "bar": "Testcontainers-based tests and Xvfb run inside the container Server, and unsupported tooling per OS is documented.",
      "barKey": "R-15",
      "barHash": "d031775bf56679222d4c9d7ba8d3bbedc2ec82af2ca7e0612092ede1d8ee5b47",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "Run one testcontainers integration test inside the container.\n\nGoverns: D-002 and the development-tooling requirement. Verification conditions: run a Testcontainers integration test AND an Xvfb-dependent journey inside the Server container; verify each OS's unsupported tooling is documented. Record exact test commands/results, image identity and documentation references. A Testcontainers pass alone does not establish Xvfb or documentation.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "A testcontainers integration test cannot start Postgres from inside the container.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-16",
      "title": "One release build emits native installers and the container image",
      "intent": {
        "request": "Will they share most of the same pipeline.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:5",
          "D-004"
        ]
      },
      "model": "One signed release run emits the complete native/container artifact family from the identical Server bundle.",
      "bar": "One signed release run emits the complete native/container artifact family from the identical Server bundle.",
      "barKey": "R-16",
      "barHash": "007f4fd92c6c0ec47dd6158431981d267774d16b1e1193a453489846ab92cae2",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "MANDATORY CONTRACT SCOPE (each original condition is still a pass requirement): One release run emits, from one Server bundle, the native installers, the container image and the WSL rootfs, each signed with an SBOM, and the release notes list both variants.\nInspect a release run's artifacts and digests.\n\nGoverns: D-004. Verification conditions: one release run emits native installers, container image and WSL rootfs from one Server bundle; verify provenance and hashes across every artifact; verify each artifact's signature and SBOM; confirm release notes list both variants. Record the release-run id, full artifact inventory, bundle/rootfs digest lineage, signature/SBOM receipts and notes. R-16 owns complete release provenance; R-7's local/image proof cannot substitute for this run.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "The container image is built by a separate pipeline from a different bundle.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-17",
      "title": "Install, upgrade and moves are proven across the matrix",
      "intent": {
        "request": "Support both containerized and native versions on all 3 platforms.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:8",
          "D-002",
          "D-004"
        ]
      },
      "model": "Fresh install, upgrade and export/import pass for each OS and variant, including native-to-container and container-to-native moves, and a scheduled restore-proof drill runs.",
      "bar": "Fresh install, upgrade and export/import pass for each OS and variant, including native-to-container and container-to-native moves, and a scheduled restore-proof drill runs.",
      "barKey": "R-17",
      "barHash": "29fd90f0448a3d7b13bdbce095543036546dcb71bd5eb281a0c1125de1220cad",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "E2E matrix results and the drill's last run.\n\nGoverns: D-002, D-004 and the E2E/restore-proof requirement. Verification conditions: enumerate Linux, Windows and macOS x native/container x fresh install/upgrade/export-import, plus native-to-container and container-to-native moves; attach each result and its exact runtime/artifact identity. Read the registered restore-proof schedule and completed drill receipt. Mark missing cells or a missing drill unknown; partial matrix evidence cannot be healthy.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "A matrix cell or cross-variant move has no passing run.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-18",
      "title": "Users can choose a variant and move machines from the docs",
      "intent": {
        "request": "Make moving machines easier.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:0",
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:5"
        ]
      },
      "model": "User docs explain native vs container per OS with the measured performance, and give a step-by-step export/import guide.",
      "bar": "User docs explain native vs container per OS with the measured performance, and give a step-by-step export/import guide.",
      "barKey": "R-18",
      "barHash": "1bec0f70314fdab6359e4882922b1425d2fe8ed223222133981c91e3aaf61823",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "Read the published docs pages.\n\nGoverns: D-002, D-004 and the user-docs requirement. Verification conditions: locate the maintained published user-doc pages and corresponding source paths under apps/operator-docs/src/content/docs; verify OS-by-OS native/container choices, measured performance and a complete export/import procedure. Record exact URLs/source paths and check every step against the verified journey. Do not treat an internal plan or a dead URL as published user documentation.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "The docs omit a platform or the moving guide.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-19",
      "title": "This dev box stays native",
      "intent": {
        "request": "This machine we'll keep native.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:8",
          "D-001"
        ]
      },
      "model": "The development machine remains a native installation after delivery.",
      "bar": "The development machine remains a native installation after delivery.",
      "barKey": "R-19",
      "barHash": "4570c0029544526901611c326c82f77d9930f0268838af06cdaa2aeebc8ff1b5",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-06T22:54:08.543Z",
        "declaredBy": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df"
      },
      "method": "MANDATORY CONTRACT SCOPE (each original condition is still a pass requirement): No change in this plan moves the dev box's Server, PG or fleet into a container; the dev box is the native reference case.\nCheck the dev box units after the plan ships.\n\nGoverns: D-001. Verification conditions: after the plan's changes, read dev:service_health and the native dev-box Server/PG/fleet process and unit identities; verify the services still execute natively and preserve the box as the native reference. Record exact service names and health/runtime evidence; no plan change may move these services into a container.\nRATING BASIS: the complete model and governing decisions are the pass floor; evaluate each verification condition and the named falsifier. A failed condition prevents healthy; missing evidence is unknown.",
      "driftMarkers": "The dev box's operator or PG runs from the container image after this plan.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-20",
      "title": "A clean destination can unlock the complete transfer.",
      "intent": {
        "request": "Implement Avi-approved machine-transfer review improvements while preserving approved native/container scope.",
        "sourceRefs": [
          "session_turn:codex:01a1bcef-63b8-7292-b72b-4bae418798c9:11",
          "report:rpt_3cdf7c19-b280-408b-b61e-292831d25276"
        ]
      },
      "model": "A clean offline destination recovers readable retained encrypted content using only the archive and user-controlled transfer secret.",
      "bar": "A clean offline destination recovers readable retained encrypted content using only the archive and user-controlled transfer secret.",
      "barKey": "R-20",
      "barHash": "eb3f5338ee6cbe10170454a264017655f69c4582b449de76162c69f96bc01183",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "legacy-backfilled",
        "declaredAt": "2026-11-08T23:03:40.546Z",
        "declaredBy": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9"
      },
      "method": "MANDATORY CONTRACT SCOPE (every condition must pass): The archive and a user-controlled transfer secret suffice to authenticate, decrypt and recover retained data on a clean offline destination without the source machine, source home or source OS keychain. Database/data keys are preserved or securely rewrapped; required integration sign-ins are disclosed. The transfer envelope records versioned memory-hard KDF parameters (scrypt through maintained Node crypto, with explicit supported parameter/resource bounds), a fresh cryptographic salt and fresh AEAD nonces per export. Secrets and unwrapped data keys are never logged or durably persisted outside their intended encrypted/key-store destination. Authentication completes before any extraction, database execution or destination mutation; wrong-secret, malformed-KDF and tampered input leave destination bytes/database/activation unchanged.\nRegistered fresh-destination encryption and tampering tests plus exact content readback in P-070/P-073; extend the existing backup/export/import mechanism with maintained authenticated encryption.\nExercise KDF version/parameter compatibility and resource limits, unique salt/nonces across exports, forbidden secret/key logging/persistence, full authentication before extraction/SQL, and byte/database/activation equality after every authentication failure. Prove exact content readback offline while source home, keychain, database and source-only key material are unavailable.\nAll atomic Conformance obligations require deciding registered test/probe or exact-artifact proof before mapped item closure; unbuilt/unmeasured proof is unknown.",
      "driftMarkers": "The importer needs a source-only key to unlock the archive, exposes retained content in cleartext, or wrong-secret/tampered input changes destination state.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-21",
      "title": "A transfer represents one consistent whole-instance cut.",
      "intent": {
        "request": "Implement Avi-approved machine-transfer review improvements while preserving approved native/container scope.",
        "sourceRefs": [
          "session_turn:codex:01a1bcef-63b8-7292-b72b-4bae418798c9:11",
          "report:rpt_3cdf7c19-b280-408b-b61e-292831d25276"
        ]
      },
      "model": "A sealed instance export represents one consistent producer-generation cut across every required store.",
      "bar": "A sealed instance export represents one consistent producer-generation cut across every required store.",
      "barKey": "R-21",
      "barHash": "5c9e744dc8c0c0cba6c723bd45f972dd31995a81f2eaeb265aeca269e0e0c734",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "legacy-backfilled",
        "declaredAt": "2026-11-08T23:03:40.546Z",
        "declaredBy": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9"
      },
      "method": "MANDATORY CONTRACT SCOPE (every condition must pass): All required producer stores participate in a recorded consistent cut covering logical databases, files, plugin/external state and replicated stores. Writers are drained/quiesced through existing controls; incomplete capture cannot be sealed or reported complete. Enumerate required producers before capture and use one reusable prepare/quiesce/capture-generation/commit-or-abort/seal protocol. The manifest records each required producer ID and captured generation; missing, failed, timed-out or restarted producers abort the cut and cannot yield a sealed complete export. Resume is idempotent and releases/resumes quiesced writers on abort.\nP-055/P-056 integration tests and P-071 fault injection around capture and sealing; use a database/file relationship fixture and verify both sides after restore.\nExercise concurrent relational-database/file/plugin/external-root and replicated-store writes, cross-store relation consistency, producer timeout/failure, writer restart, retry/abort cleanup and seal refusal for incomplete producer generations.\nAll atomic Conformance obligations require deciding registered test/probe or exact-artifact proof before mapped item closure; unbuilt/unmeasured proof is unknown.",
      "driftMarkers": "An archive combines incompatible store generations or publishes a complete-looking transfer after a required producer failed.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-22",
      "title": "Activation and handover survive interruption and source restart.",
      "intent": {
        "request": "Implement Avi-approved machine-transfer review improvements while preserving approved native/container scope.",
        "sourceRefs": [
          "session_turn:codex:01a1bcef-63b8-7292-b72b-4bae418798c9:11",
          "report:rpt_3cdf7c19-b280-408b-b61e-292831d25276"
        ]
      },
      "model": "An execution handover preserves the recorded single-executor authority across source and destination restarts.",
      "bar": "An execution handover preserves the recorded single-executor authority across source and destination restarts.",
      "barKey": "R-22",
      "barHash": "8df68c24ebd3ee0ed3347989c8db7f1d97b33693422b994850510c1c9692d836",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "legacy-backfilled",
        "declaredAt": "2026-11-08T23:03:40.546Z",
        "declaredBy": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9"
      },
      "method": "MANDATORY CONTRACT SCOPE (every condition must pass): Restore remains isolated with agents, schedules and outward sends disabled until verification and explicit handover. Durable operation state defines retry/rollback and source-restart behavior. Offline moves require source shutdown/fencing and disclose that disconnected sources cannot be stopped remotely. Persist transitions restored-isolated -> verified -> handover-committed -> active, bound to transfer/source/destination identity and a monotonic execution-authority epoch. Reuse and extend the current durable-operation and authority/fencing records, rather than create a scheduler or parallel lifecycle service. Online handover commits atomically only after durable source pause acknowledgement; agent claims, schedule dispatch and outward-send execution reject the retired source epoch. Before commit the source may resume only after destination abort; after commit it stays fenced across restart. Rollback after commit requires a reverse authority handover before source re-enable. Offline moves require recorded source shutdown acknowledgement; the UI states that a disconnected source cannot be remotely fenced, and an unverifiable shutdown never becomes an online single-executor guarantee.\nP-071 registered transition/crash/source-restart tests and isolated native journey checks; reuse durable operations and current ownership/device controls.\nTest every transition and crash/restart edge on source and destination, durable source acknowledgement loss, stale-epoch claim/schedule/send rejection, retry idempotency, pre-commit abort/source resume, post-commit rollback/reverse handover and offline shutdown acknowledgement/disclosure.\nAll atomic Conformance obligations require deciding registered test/probe or exact-artifact proof before mapped item closure; unbuilt/unmeasured proof is unknown.",
      "driftMarkers": "A restored destination executes work before activation, source restart silently duplicates work after handover, or interruption loses the recoverable source.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-23",
      "title": "The supported migration is self-service.",
      "intent": {
        "request": "Implement Avi-approved machine-transfer review improvements while preserving approved native/container scope.",
        "sourceRefs": [
          "session_turn:codex:01a1bcef-63b8-7292-b72b-4bae418798c9:11",
          "report:rpt_3cdf7c19-b280-408b-b61e-292831d25276"
        ]
      },
      "model": "A user can preview retained data and omissions, size/space and expected interruption, create an encrypted transfer, restore during first run, reconnect integrations, verify content, hand over execution and recover from interruption through the native GUI without terminal commands.",
      "bar": "A user can preview retained data and omissions, size/space and expected interruption, create an encrypted transfer, restore during first run, reconnect integrations, verify content, hand over execution and recover from interruption through the native GUI without terminal commands.",
      "barKey": "R-23",
      "barHash": "50052b4413a50b74087b8f2a533c2591142d13dc6fad2d11cbfbec6828c889d7",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "legacy-backfilled",
        "declaredAt": "2026-11-08T23:03:40.546Z",
        "declaredBy": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9"
      },
      "method": "P-072 GUI tests and P-073 isolated native-desktop acceptance using registered UI components and the same backend export/import operations.\nAll atomic Conformance obligations require deciding registered test/probe or exact-artifact proof before mapped item closure; unbuilt/unmeasured proof is unknown.",
      "driftMarkers": "The supported journey requires an agent/terminal, hides omitted required data, or leaves the user without an actionable recovery path.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-24",
      "title": "A verified native migration can ship independently.",
      "intent": {
        "request": "Implement Avi-approved machine-transfer review improvements while preserving approved native/container scope.",
        "sourceRefs": [
          "session_turn:codex:01a1bcef-63b8-7292-b72b-4bae418798c9:11",
          "report:rpt_3cdf7c19-b280-408b-b61e-292831d25276"
        ]
      },
      "model": "The independently accepted native migration milestone ships on the explicit minimum Linux x86_64 native-to-native support matrix.",
      "bar": "The independently accepted native migration milestone ships on the explicit minimum Linux x86_64 native-to-native support matrix.",
      "barKey": "R-24",
      "barHash": "ed16b7c4541825066a67dcaa78065245adf83bd9501844c9e6f72d32e96ef77d",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "deployed"
      ],
      "evidencePlane": "deployed",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "legacy-backfilled",
        "declaredAt": "2026-11-08T23:03:40.546Z",
        "declaredBy": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9"
      },
      "method": "MANDATORY CONTRACT SCOPE (every condition must pass): Milestone M1 releases the proven same-OS/same-architecture native route through the existing signed native release pipeline after independent acceptance and the full native dev-box scratch rehearsal. Its support matrix matches successful exact-artifact drills; the full approved platform/variant program remains M2. M1 minimum: Linux x86_64 native source to a clean Linux x86_64 native destination, including different username and root paths plus the full native dev-box scratch rehearsal. Windows x86_64 and macOS arm64 native routes, cross-OS/architecture moves and container variants are not M1-supported; UI and docs must label them unsupported until their exact-artifact M2 drills pass. M2 retains all approved native/container Linux/macOS/Windows obligations.\nP-073/P-074 exact signed-artifact checks and published support/docs; retain P-067/P-068/P-069 for the complete shared distribution program.\nRun the Linux x86_64 native-to-native M1 minimum on exact signed installer/server bytes; verify UI/docs explicitly label every unsupported route, then retain separate M2 proof for every additional platform/variant cell.\nAll atomic Conformance obligations require deciding registered test/probe or exact-artifact proof before mapped item closure; unbuilt/unmeasured proof is unknown.",
      "driftMarkers": "Native migration is claimed released without its deciding journey/drill proof, or waits solely on unrelated unfinished container capabilities.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-25",
      "title": "Content and recovery are proved early and at full scale.",
      "intent": {
        "request": "Implement Avi-approved machine-transfer review improvements while preserving approved native/container scope.",
        "sourceRefs": [
          "session_turn:codex:01a1bcef-63b8-7292-b72b-4bae418798c9:11",
          "report:rpt_3cdf7c19-b280-408b-b61e-292831d25276"
        ]
      },
      "model": "The full reference migration preserves the required retained content under the declared failure contract.",
      "bar": "The full reference migration preserves the required retained content under the declared failure contract.",
      "barKey": "R-25",
      "barHash": "0cf7c70ca602fcac029d09528341a38b9cc351812abb1834e9ef814a0dc6b6a0",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "legacy-backfilled",
        "declaredAt": "2026-11-08T23:03:40.546Z",
        "declaredBy": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9"
      },
      "method": "MANDATORY CONTRACT SCOPE (each original condition is still a pass requirement): A realistic small fixture proves history, attachment, encrypted value, plugin data, uncommitted repository work, external-path relocation and scheduled-action safety. Full native dev-box migration remains required; capture/restore/activation faults, disk shortage and invalid inputs have real suite coverage.\nP-070/P-071 registered suites, P-057 full reference rehearsal and P-073 independent acceptance, recording duration, source pause and destination temporary-space requirements.\nAll atomic Conformance obligations require deciding registered test/probe or exact-artifact proof before mapped item closure; unbuilt/unmeasured proof is unknown.",
      "driftMarkers": "A passing fixture substitutes for full required source coverage, a required retained value is unreadable, or a declared fault/compatibility case has no deciding proof.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    }
  ],
  "dryRun": true,
  "requestReview": {
    "workItemId": "WI-10007647",
    "harness": "papercusp"
  },
  "expectedRubricRevision": 3,
  "expectedSubjectPlanRevision": 64,
  "idempotencyKey": "portable-outcome-r4-r7-review-v1",
  "reason": "Exact spec-quality evaluator identified legacy R4/R7 projections as prescribing internal sealed-key storage and bundle-host.sh filenames. Express their observable consistency/recoverability and same-signed-release payload guarantees in the outcome, retaining the full original exact-key/manifest/rootfs/SBOM/signature/publication contract as mandatory Verification. No original guarantee is removed; canonical review must approve before implementation."
}
