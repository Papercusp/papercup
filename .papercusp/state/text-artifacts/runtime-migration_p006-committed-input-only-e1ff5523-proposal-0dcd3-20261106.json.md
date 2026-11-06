---
rel_path: "runtime-migration/p006-committed-input-only-e1ff5523-proposal-0dcd3-20261106.json"
updated_at: 1793969678672
_body: "content"
---

{
  "schemaVersion": "p006-committed-dependency-input-only-proposal-v1",
  "status": "PREPARED_NOT_EXECUTED",
  "ownerId": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "item": "P-006",
  "workItem": "WI-6554700010022072",
  "purpose": "Measure only committed dependency lock/shrinkwrap/patch inputs of the distinct e1ff5523 candidate through the maintained input-manifest algorithm. This is a new prerequisite after completed D022 source materialization, not an old tuple or source-task retry.",
  "priorScope": {
    "decision": "D-022",
    "state": "SUCCESS_CONSUMED",
    "result": "runtime-migration/p006-d022-e1ff5523-source-only-result-0dcd3-20261106.json",
    "restriction": "D011-D022 remain terminal/consumed including D021 NO_START. Do not re-probe completed D022 source clone/task/cleanup after its deadline."
  },
  "candidateCommit": "e1ff55230c4bfc416a7c1e1fa7382968db8c3f39",
  "measurementRoot": "/home/marsh-office/papercupai-workspace/papercusp",
  "rootMeaning": "Read the named committed root and recursively exact gitlink commits in locally present, correctly rooted submodule repositories. Do not inspect working dependency bytes. No assumption that a missing submodule/object can be fetched.",
  "reuse": {
    "surface": "apps/operator/bin/release/dependency-generation.sh",
    "why": "Reuse maintained dependency_generation_input_manifest_ref and recursive emit/input-record/hash functions. Standalone fingerprint-ref is excluded because CLI root resolution can write the generation-root record; missing-object hydration is overridden to fail closed. No new production API/table/service/selector introduced."
  },
  "helper": {
    "path": "apps/operator/bin/release/dependency-generation.sh",
    "sha256": "d82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e",
    "candidateBlobSha256": "d82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e",
    "workingEqualsCandidate": true,
    "definitions": [
      {
        "name": "dependency_generation_log",
        "sha256": "16582093c5c2f90fb543d323d51ed649ced66a0849ab242da59b64f5c74a9c6b",
        "source": "dependency_generation_log() {\n  printf '[dependency-generation] %s\\n' \"$*\" >&2\n  # WI-10004094: while this process holds an identity's in-flight build, mirror\n  # each line to the lock so a joined waiter can relay the holder's progress.\n  if [ -n \"${DEPENDENCY_GENERATION_INFLIGHT_PROGRESS:-}\" ]; then\n    {\n      printf '%s %s\\n' \"$(date +%s)\" \"$*\" > \"$DEPENDENCY_GENERATION_INFLIGHT_PROGRESS.tmp\" \\\n        && mv -f \"$DEPENDENCY_GENERATION_INFLIGHT_PROGRESS.tmp\" \"$DEPENDENCY_GENERATION_INFLIGHT_PROGRESS\"\n    } 2>/dev/null || true\n  fi\n}"
      },
      {
        "name": "dependency_generation_sha256",
        "sha256": "56555a84f0a8624016635528ea7247e81e8225b8f655ad85e7e5beeca12a6ede",
        "source": "dependency_generation_sha256() {\n  if command -v sha256sum >/dev/null 2>&1; then\n    sha256sum | awk '{ print $1 }'\n  elif command -v shasum >/dev/null 2>&1; then\n    shasum -a 256 | awk '{ print $1 }'\n  else\n    dependency_generation_log 'FATAL: neither sha256sum nor shasum is available'\n    return 1\n  fi\n}"
      },
      {
        "name": "dependency_generation_ref_input_records",
        "sha256": "a59e9ac0a297938da9ba7552d7fb62122aa049c6329c2966b3a64f8be1938be5",
        "source": "dependency_generation_ref_input_records() {\n  local root=\"$1\" ref=\"$2\"\n  git -C \"$root\" ls-tree -r -z \"$ref\" \\\n    | LC_ALL=C grep -zE $'\\t([^/]+/)*(package-lock\\\\.json|npm-shrinkwrap\\\\.json)$|\\t([^/]+/)*patches/[^/]+\\\\.patch$'\n}"
      },
      {
        "name": "dependency_generation_input_manifest_ref",
        "sha256": "f336fc96cba09e9a61ce644929a058182a0b0b0c8c8bb1b1987465b1727a0c40",
        "source": "dependency_generation_input_manifest_ref() {\n  local root=\"$1\" ref=\"$2\" prefix=\"${3:-}\" extract_root=\"${4:-}\" cache_root=\"${5:-}\"\n  local cache_file cache_tmp manifest\n  # The prewarm search owns this cache inside its disposable scratch tree. A\n  # manifest is immutable for one commit and path prefix; extraction always\n  # re-reads and hashes the actual blobs rather than trusting cached bytes.\n  if [ -z \"$cache_root\" ] || [ -n \"$extract_root\" ]; then\n    dependency_generation_emit_input_manifest_ref \"$@\"\n    return $?\n  fi\n  cache_file=\"$cache_root/$ref/${prefix}inputs\"\n  if [ -f \"$cache_file\" ]; then\n    cat \"$cache_file\"\n    return $?\n  fi\n  manifest=\"$(dependency_generation_emit_input_manifest_ref \"$@\")\" || return $?\n  mkdir -p \"$(dirname \"$cache_file\")\" || return 1\n  cache_tmp=\"$cache_file.tmp.$$\"\n  { [ -z \"$manifest\" ] || printf '%s\\n' \"$manifest\"; } > \"$cache_tmp\" || { rm -f -- \"$cache_tmp\"; return 1; }\n  mv \"$cache_tmp\" \"$cache_file\" || { rm -f -- \"$cache_tmp\"; return 1; }\n  [ -z \"$manifest\" ] || printf '%s\\n' \"$manifest\"\n}"
      },
      {
        "name": "dependency_generation_submodule_has_commit",
        "sha256": "50388d6fb17f2b117aa3c105c4425886ccd42105d2d09964e9e7fad8f75baddc",
        "source": "dependency_generation_submodule_has_commit() {\n  local root=\"$1\" path=\"$2\" object=\"$3\" top here\n  [ -d \"$root/$path\" ] || return 1\n  top=\"$(git -C \"$root/$path\" rev-parse --show-toplevel 2>/dev/null)\" || return 1\n  here=\"$(cd \"$root/$path\" && pwd -P)\" || return 1\n  [ \"$top\" = \"$here\" ] || return 1\n  git -C \"$root/$path\" cat-file -e \"$object^{commit}\" 2>/dev/null\n}"
      },
      {
        "name": "dependency_generation_hydrate_submodule",
        "sha256": "ddf237d8b15c7cc3fe57a4135449ee3903afe008e86b9b5c979936dd0a9f4e6a",
        "source": "dependency_generation_hydrate_submodule() {\n  local root=\"$1\" path=\"$2\" object=\"$3\"\n  local timeout_s=\"${PAPERCUSP_DEPENDENCY_SUBMODULE_HYDRATE_TIMEOUT_SEC:-1800}\" top='' here=''\n  if [ -d \"$root/$path\" ]; then\n    top=\"$(git -C \"$root/$path\" rev-parse --show-toplevel 2>/dev/null || true)\"\n    here=\"$(cd \"$root/$path\" && pwd -P)\" || here=''\n  fi\n  if [ -n \"$top\" ] && [ \"$top\" = \"$here\" ]; then\n    dependency_generation_log \"submodule $path lacks $object; fetching it from its origin\"\n    GIT_TERMINAL_PROMPT=0 timeout \"$timeout_s\" \\\n      git -C \"$root/$path\" fetch --no-tags --quiet origin \"$object\" >&2 \\\n      || GIT_TERMINAL_PROMPT=0 timeout \"$timeout_s\" \\\n        git -C \"$root/$path\" fetch --no-tags --quiet origin >&2 \\\n      || return 1\n  else\n    dependency_generation_log \"submodule $path is not initialized in $root; initializing it for $object\"\n    GIT_TERMINAL_PROMPT=0 timeout \"$timeout_s\" \\\n      git -C \"$root\" submodule update --init -- \"$path\" >&2 || return 1\n  fi\n  dependency_generation_submodule_has_commit \"$root\" \"$path\" \"$object\"\n}"
      },
      {
        "name": "dependency_generation_emit_input_manifest_ref",
        "sha256": "fb9ed5a5c2cd6de50a0a8323fd178a64de3164fe02fc05443749a08da428c5d2",
        "source": "dependency_generation_emit_input_manifest_ref() {\n  local root=\"$1\" ref=\"$2\" prefix=\"${3:-}\" extract_root=\"${4:-}\"\n  local cache_root=\"${5:-}\"\n  local record metadata mode type object rel digest submodule_path submodule_object\n  while IFS= read -r -d '' record; do\n    metadata=\"${record%%$'\\t'*}\"\n    rel=\"${record#*$'\\t'}\"\n    read -r mode type object <<< \"$metadata\"\n    [ \"$type\" = 'blob' ] || continue\n    case \"$rel\" in\n      package-lock.json|*/package-lock.json|npm-shrinkwrap.json|*/npm-shrinkwrap.json) ;;\n      patches/*.patch|*/patches/*.patch) ;;\n      *) continue ;;\n    esac\n    case \"$rel\" in\n      .papercusp/*|*/.papercusp/*|.papercusp-smoke-snapshots/*|*/.papercusp-smoke-snapshots/*|node_modules/*|*/node_modules/*) continue ;;\n    esac\n    if [ -n \"$extract_root\" ]; then\n      mkdir -p \"$extract_root/$(dirname \"${prefix}${rel}\")\" || return 1\n      git -C \"$root\" cat-file blob \"$object\" > \"$extract_root/${prefix}${rel}\" || return 1\n      digest=\"$(dependency_generation_sha256 < \"$extract_root/${prefix}${rel}\")\" || return 1\n    else\n      digest=\"$(git -C \"$root\" cat-file blob \"$object\" | dependency_generation_sha256)\" || return 1\n    fi\n    printf '%s\\t%s\\n' \"${prefix}${rel}\" \"$digest\"\n  done < <(dependency_generation_ref_input_records \"$root\" \"$ref\")\n\n  while IFS= read -r submodule_path; do\n    [ -n \"$submodule_path\" ] || continue\n    submodule_object=\"$(\n      git -C \"$root\" ls-tree \"$ref\" -- \"$submodule_path\" \\\n        | awk '$1 == \"160000\" && $2 == \"commit\" { print $3; exit }'\n    )\"\n    [ -n \"$submodule_object\" ] || {\n      dependency_generation_log \\\n        \"FATAL: exact dependency-input ref $ref has no gitlink for submodule $submodule_path\"\n      return 74\n    }\n    dependency_generation_submodule_has_commit \"$root\" \"$submodule_path\" \"$submodule_object\" \\\n      || dependency_generation_hydrate_submodule \"$root\" \"$submodule_path\" \"$submodule_object\" || {\n        dependency_generation_log \\\n          \"FATAL: exact dependency-input ref $ref requires unavailable submodule $submodule_path@$submodule_object (hydrating the integration checkout from the submodule's own remote did not produce that commit; this is an integration-checkout defect, not a generation-store one)\"\n        return 74\n      }\n    dependency_generation_input_manifest_ref \\\n      \"$root/$submodule_path\" \"$submodule_object\" \"${prefix}${submodule_path}/\" \\\n      \"$extract_root\" \"$cache_root\" || return $?\n  done < <(\n    git -C \"$root\" config --blob \"$ref:.gitmodules\" --get-regexp '\\.path$' 2>/dev/null \\\n      | awk '{ print $2 }'\n  )\n}"
      },
      {
        "name": "dependency_generation_input_fingerprint_ref",
        "sha256": "6e7bae1d33a86bf6289c809882a2cdad2b8f468ff88652fe144d14cbf1911c18",
        "source": "dependency_generation_input_fingerprint_ref() {\n  local root=\"$1\" ref=\"$2\" manifest\n  ref=\"$(git -C \"$root\" rev-parse --verify \"$ref^{commit}\" 2>/dev/null)\" || {\n    dependency_generation_log \"FATAL: dependency-input ref is not a commit: $ref\"\n    return 74\n  }\n  manifest=\"$(dependency_generation_input_manifest_ref \"$root\" \"$ref\" | LC_ALL=C sort)\" || return $?\n  {\n    printf 'schema\\t1\\n'\n    [ -z \"$manifest\" ] || printf '%s\\n' \"$manifest\"\n  } | dependency_generation_sha256\n}"
      }
    ]
  },
  "fixture": {
    "path": "apps/operator/lib/release/fixtures/bun-dependency-input-only-guards.sh",
    "sha256": "1b007e25a919fa4e9c69bfb6d028213cbf430e048d88aa904cad416845b558f7",
    "bytes": 2963,
    "source": "# Exact portable guard block for the P-006 input-only proposal. The caller sources\n# the pinned maintained helper first and owns the disposable error-file directory.\n# No generation API is called. Keep machine paths and execution admission outside\n# this fixture; its bytes are embedded in the canonical review packet.\ndependency_generation_input_only() (\n  set -euo pipefail\n  root=\"$1\" ref=\"$2\" errors=\"$3\"\n  DEPENDENCY_GENERATION_INFLIGHT_PROGRESS=''\n  export GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1\n\n  git() {\n    local rc=0 listing='' listing_rc=0\n    if [ \"$#\" -lt 3 ] || [ \"$1\" != '-C' ]; then\n      printf 'unsupported git invocation\\n' >> \"$errors\"\n      return 74\n    fi\n    case \"$3\" in\n      rev-parse|ls-tree) ;;\n      cat-file)\n        case \"${4:-}\" in blob|-e) ;; *) printf 'unsupported cat-file\\n' >> \"$errors\"; return 74 ;; esac ;;\n      config)\n        if [ \"$#\" -ne 7 ] || [ \"$4\" != '--blob' ] || [ \"$6\" != '--get-regexp' ] || [ \"$7\" != '\\.path$' ]; then\n          printf 'unsupported config read\\n' >> \"$errors\"\n          return 74\n        fi ;;\n      *) printf 'forbidden git command: %s\\n' \"$3\" >> \"$errors\"; return 74 ;;\n    esac\n    command git \"$@\" || rc=$?\n    [ \"$rc\" -ne 0 ] || return 0\n    # The maintained walker asks every leaf repo for .gitmodules. Missing files\n    # (128) and valid files without path entries (1) are normal, not read failures.\n    if [ \"$3\" = config ] && { [ \"$rc\" -eq 1 ] || [ \"$rc\" -eq 128 ]; }; then\n      listing=\"$(command git -C \"$2\" ls-tree \"${5%:.gitmodules}\" -- .gitmodules)\" || listing_rc=$?\n      if [ \"$listing_rc\" -eq 0 ] && { [ -z \"$listing\" ] || [ \"$rc\" -eq 1 ]; }; then\n        return \"$rc\"\n      fi\n    fi\n    # Process substitutions can hide failures from the caller's exit status.\n    # Their descendants share this one caller-owned error channel, checked below.\n    printf 'git read failed: %s exit=%s\\n' \"$3\" \"$rc\" >> \"$errors\"\n    return \"$rc\"\n  }\n\n  dependency_generation_hydrate_submodule() {\n    printf 'missing committed submodule; hydration forbidden\\n' >> \"$errors\"\n    return 74\n  }\n\n  resolved=\"$(git -C \"$root\" rev-parse --verify \"$ref^{commit}\")\" || exit $?\n  [ \"$resolved\" = \"$ref\" ] || exit 74\n  manifest=\"$(dependency_generation_input_manifest_ref \"$root\" \"$ref\" | LC_ALL=C sort)\" || exit $?\n  [ ! -s \"$errors\" ] || { cat \"$errors\" >&2; exit 74; }\n  [ -n \"$manifest\" ] || exit 74\n  printf '%s\\n' \"$manifest\" | awk -F '\\t' '\n    NF != 2 || length($2) != 64 || $2 !~ /^[0-9a-f]+$/ ||\n      $1 ~ /^\\// || $1 ~ /(^|\\/)\\.\\.?($|\\/)/ || $1 ~ /\\\\/ { exit 74 }\n    seen[$1]++ { exit 74 }\n  ' || exit $?\n  fingerprint=\"$( { printf 'schema\\t1\\n'; printf '%s\\n' \"$manifest\"; } | dependency_generation_sha256)\" || exit $?\n  [[ \"$fingerprint\" =~ ^[0-9a-f]{64}$ ]] || exit 74\n  printf 'DEPENDENCY_INPUT_MANIFEST_BEGIN\\n%s\\nDEPENDENCY_INPUT_MANIFEST_END\\n' \"$manifest\"\n  printf 'DEPENDENCY_INPUT_FINGERPRINT schema=1 candidate=%s input=%s\\n' \"$ref\" \"$fingerprint\"\n)\n"
  },
  "command": {
    "shell": "bash",
    "stdin": "set -euo pipefail\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT NODE_OPTIONS NODE_PATH BASH_ENV ENV\nexport GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0\nexport GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null\nexport DEPENDENCY_GENERATION_INFLIGHT_PROGRESS=''\nroot='/home/marsh-office/papercupai-workspace/papercusp'\nhelper=\"$root/apps/operator/bin/release/dependency-generation.sh\"\nprintf '%s  %s\\n' 'd82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e' \"$helper\" | sha256sum -c -\nscratch=\"$(mktemp -d /mnt/data/tmp/bun-p006-input-only-e1ff-0dcd3-20261106.XXXXXXXX)\"\ncleanup() { rc=$?; trap - EXIT; rm -f -- \"$scratch/errors\" || rc=74; rmdir -- \"$scratch\" || rc=74; exit \"$rc\"; }\ntrap cleanup EXIT\ntimeout --signal=TERM --kill-after=10s 90s bash -euo pipefail -s -- \"$root\" \"$helper\" \"$scratch/errors\" <<'P006_INPUT_ONLY'\nroot=\"$1\" helper=\"$2\" errors=\"$3\"\nprintf '%s  %s\\n' 'd82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e' \"$helper\" | sha256sum -c -\nsource \"$helper\"\nprintf '%s  %s\\n' 'd82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e' \"$helper\" | sha256sum -c -\n# Exact portable guard block for the P-006 input-only proposal. The caller sources\n# the pinned maintained helper first and owns the disposable error-file directory.\n# No generation API is called. Keep machine paths and execution admission outside\n# this fixture; its bytes are embedded in the canonical review packet.\ndependency_generation_input_only() (\n  set -euo pipefail\n  root=\"$1\" ref=\"$2\" errors=\"$3\"\n  DEPENDENCY_GENERATION_INFLIGHT_PROGRESS=''\n  export GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1\n\n  git() {\n    local rc=0 listing='' listing_rc=0\n    if [ \"$#\" -lt 3 ] || [ \"$1\" != '-C' ]; then\n      printf 'unsupported git invocation\\n' >> \"$errors\"\n      return 74\n    fi\n    case \"$3\" in\n      rev-parse|ls-tree) ;;\n      cat-file)\n        case \"${4:-}\" in blob|-e) ;; *) printf 'unsupported cat-file\\n' >> \"$errors\"; return 74 ;; esac ;;\n      config)\n        if [ \"$#\" -ne 7 ] || [ \"$4\" != '--blob' ] || [ \"$6\" != '--get-regexp' ] || [ \"$7\" != '\\.path$' ]; then\n          printf 'unsupported config read\\n' >> \"$errors\"\n          return 74\n        fi ;;\n      *) printf 'forbidden git command: %s\\n' \"$3\" >> \"$errors\"; return 74 ;;\n    esac\n    command git \"$@\" || rc=$?\n    [ \"$rc\" -ne 0 ] || return 0\n    # The maintained walker asks every leaf repo for .gitmodules. Missing files\n    # (128) and valid files without path entries (1) are normal, not read failures.\n    if [ \"$3\" = config ] && { [ \"$rc\" -eq 1 ] || [ \"$rc\" -eq 128 ]; }; then\n      listing=\"$(command git -C \"$2\" ls-tree \"${5%:.gitmodules}\" -- .gitmodules)\" || listing_rc=$?\n      if [ \"$listing_rc\" -eq 0 ] && { [ -z \"$listing\" ] || [ \"$rc\" -eq 1 ]; }; then\n        return \"$rc\"\n      fi\n    fi\n    # Process substitutions can hide failures from the caller's exit status.\n    # Their descendants share this one caller-owned error channel, checked below.\n    printf 'git read failed: %s exit=%s\\n' \"$3\" \"$rc\" >> \"$errors\"\n    return \"$rc\"\n  }\n\n  dependency_generation_hydrate_submodule() {\n    printf 'missing committed submodule; hydration forbidden\\n' >> \"$errors\"\n    return 74\n  }\n\n  resolved=\"$(git -C \"$root\" rev-parse --verify \"$ref^{commit}\")\" || exit $?\n  [ \"$resolved\" = \"$ref\" ] || exit 74\n  manifest=\"$(dependency_generation_input_manifest_ref \"$root\" \"$ref\" | LC_ALL=C sort)\" || exit $?\n  [ ! -s \"$errors\" ] || { cat \"$errors\" >&2; exit 74; }\n  [ -n \"$manifest\" ] || exit 74\n  printf '%s\\n' \"$manifest\" | awk -F '\\t' '\n    NF != 2 || length($2) != 64 || $2 !~ /^[0-9a-f]+$/ ||\n      $1 ~ /^\\// || $1 ~ /(^|\\/)\\.\\.?($|\\/)/ || $1 ~ /\\\\/ { exit 74 }\n    seen[$1]++ { exit 74 }\n  ' || exit $?\n  fingerprint=\"$( { printf 'schema\\t1\\n'; printf '%s\\n' \"$manifest\"; } | dependency_generation_sha256)\" || exit $?\n  [[ \"$fingerprint\" =~ ^[0-9a-f]{64}$ ]] || exit 74\n  printf 'DEPENDENCY_INPUT_MANIFEST_BEGIN\\n%s\\nDEPENDENCY_INPUT_MANIFEST_END\\n' \"$manifest\"\n  printf 'DEPENDENCY_INPUT_FINGERPRINT schema=1 candidate=%s input=%s\\n' \"$ref\" \"$fingerprint\"\n)\ndependency_generation_input_only \"$root\" 'e1ff55230c4bfc416a7c1e1fa7382968db8c3f39' \"$errors\"\nprintf '%s  %s\\n' 'd82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e' \"$helper\" | sha256sum -c -\nP006_INPUT_ONLY\nprintf '%s  %s\\n' 'd82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e' \"$helper\" | sha256sum -c -\nrm -f -- \"$scratch/errors\"\nrmdir -- \"$scratch\"\ntrap - EXIT\nprintf 'P006_COMMITTED_INPUT_ONLY_READY candidate=e1ff55230c4bfc416a7c1e1fa7382968db8c3f39\\n'\n",
    "chars": 4693,
    "sha256": "6c5e1e2572a791327b917eb90fc0164a86a17a25f4a9282aec1466ffb9cbce0e",
    "syntaxStatus": "NOT_RUN: predecessor bash -n was denied before dispatch by execution-authority lookup at 2026-11-06T11:58:31.454Z. Do not interpret attempted syntax call as a pass.",
    "executionStatus": "NOT_EXECUTED"
  },
  "callGraphAndWrites": [
    "Sourcing the complete hash-guarded helper only defines functions; the executable main guard does not run in sourced mode.",
    "dependency_generation_input_only calls exact rev-parse, input_manifest_ref with extract_root/cache_root absent, emit_input_manifest_ref, ref_input_records, submodule_has_commit and sha256. It does not call input_fingerprint_ref/CLI, resolve_root, generation selectors/leases/publish/copy/install.",
    "The guard overrides hydrate_submodule with exit74 and a caller-owned error-channel write. Missing submodule/object terminates the one attempt without fetching or initialization.",
    "The Bash git wrapper allows only pinned helper read shapes: -C rev-parse/ls-tree, cat-file blob/-e, config --blob --get-regexp \\.path$. Other commands terminate74 before Git.",
    "Git read failures append to one scratch/errors file because process substitutions can hide exit status. Missing .gitmodules and valid no-path config statuses are distinguished through an additional read-only ls-tree.",
    "INFLIGHT_PROGRESS is empty before source and inside the guard, disabling log progress-file writes. GIT_OPTIONAL_LOCKS=0, GIT_NO_LAZY_FETCH=1, GIT_NO_REPLACE_OBJECTS=1, global/system Git config disabled as listed in exact command.",
    "Only explicit authored filesystem mutation is mktemp own input-only scratch, error-file appends on refusal, then rm own errors and rmdir own scratch. No recursive delete. Standard tool/runtime bookkeeping and GNU sort's possible temporary spill are not proven absent by these unit tests; reviewer must assess this exact command's TMPDIR omission before admission."
  ],
  "confinement": {
    "required": true,
    "route": "Actual qualified current-build managed capability:bash with require_task_confinement:true; fail closed if not positively enrolled/confined with a scope unit and verified source containment.",
    "innerTimeoutSec": 90,
    "innerKillAfterSec": 10,
    "requestedOuterDurationSec": 150,
    "cleanupReserveSec": 40,
    "deadline": "Absolute deadline must be recorded from actual dispatch receipt before use; no postdeadline task/source probing.",
    "stopPolicy": "Exactly one admitted actual measurement; first drift/refusal/nonzero/timeout/unknown cleanup terminates scope. Preserve original receipt/partial evidence. No retries, alternate roots, old tuple, helper-pin refresh, stripped fields, fallback or retargeting."
  },
  "outputAcceptance": [
    "Process exits0 within bounded deadline.",
    "Exact helper hash guards before/after source and measurement pass.",
    "All rows nonempty valid unique safe-relative path+64hex SHA256; manifest and schema1 fingerprint printed.",
    "Final P006_COMMITTED_INPUT_ONLY_READY emitted only after inner success, outer helper hash and own scratch cleanup.",
    "Actual native subtree cleanup and terminal task ledger independently verified before deadline. If missing, scope is not PASS."
  ],
  "tests": {
    "type": "FOCUSED_UNIT_ONLY",
    "runId": "e7f98be5-5ba3-41ee-ae59-1c80f56cf53a",
    "ledgerId": 23473211,
    "taskId": "0mw4xbjphalhd3o1ouv",
    "manifestPath": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-2wEl0E/manifest.json",
    "manifestSha256": "b9e1fd6296b93bfea4b7bec9afe8a6b2f5d2a72b1bd4bbdfe493295f40bbbc96",
    "manifest": {
      "schemaVersion": 1,
      "runId": "e7f98be5-5ba3-41ee-ae59-1c80f56cf53a",
      "root": "/home/marsh-office/papercupai-workspace/papercusp",
      "deadline": {
        "startedAtMs": 1793966470231,
        "taskDeadlineAtMs": 1793966770231,
        "cleanupReserveMs": 30000,
        "childCutoffAtMs": 1793966740231
      },
      "state": "retained",
      "childState": "closed",
      "paths": {
        "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-2wEl0E",
        "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-2wEl0E/manifest.json",
        "phases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-2wEl0E/phases.jsonl",
        "reports": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-2wEl0E/reports",
        "ownedDatabases": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-2wEl0E/owned-databases",
        "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-2wEl0E/executed-inputs",
        "nativeProof": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-2wEl0E/native-proof"
      },
      "groupCleanups": [],
      "result": {
        "ok": true,
        "runId": "e7f98be5-5ba3-41ee-ae59-1c80f56cf53a",
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "passed": 7,
        "failed": 0,
        "skipped": 203,
        "files": 1,
        "failures": [],
        "failuresTruncated": false,
        "durationMs": 7097,
        "byFile": {
          "apps/operator/lib/release/dependency-generation.test.ts": {
            "passed": 7,
            "failed": 0,
            "skipped": 203,
            "collectionFailed": false
          }
        }
      },
      "cleanup": {
        "complete": true,
        "databases": [],
        "errors": []
      },
      "executedRoot": "/home/marsh-office/papercupai-workspace/papercusp",
      "phaseTimings": null,
      "nativeCustody": {
        "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-2wEl0E/native-proof",
        "locator": {
          "manifest": {
            "ref": "62f6b50cbf1cd947bffa2d6137fb2ecaa55cac4aacabac6f2a0a6c3e78dfea93.native-proof.json",
            "sha256": "62f6b50cbf1cd947bffa2d6137fb2ecaa55cac4aacabac6f2a0a6c3e78dfea93",
            "byteLength": 16543
          },
          "identity": {
            "workspace": "papercusp-workspace",
            "harness": "papercusp",
            "runId": "e7f98be5-5ba3-41ee-ae59-1c80f56cf53a"
          },
          "expectedHash": "95d7dfbc2c0c55cc1ce4580454bcd2c5843d76188c50f27ea4c539409c0edb81",
          "inventoryHash": "aa10601d61380f263cd3d0391977486f1ecd21933ee4e97befc8185beed2787e"
        },
        "byteCustody": "complete",
        "writerState": "settled",
        "routerCustody": [
          "complete"
        ],
        "nativeProof": "unqualified",
        "acceptance": "unmeasured",
        "producerRetirement": "not-performed"
      }
    },
    "executedTestSha256": "aa55a8e97ef7d5e99fc2f450a0ca5d97278d46bb7dea2cf98f98ca6852d38bf0",
    "currentTestSha256": "98a8ef392a0a4e7188c386a998d50c2c0656fae96266dd47f8642ea124b8c9f2",
    "currentTestBlock": "describe('Bun input-only proposal guards', () => {\n  const guards = join(__dirname, 'fixtures/bun-dependency-input-only-guards.sh');\n\n  function inputOnly(mode = 'ok', missingSubmodule = false, override = '') {\n    const integration = makeIntegration();\n    commitAllFixture(integration, 'seed input-only guard fixture');\n    if (missingSubmodule) {\n      writeFileSync(join(integration, '.gitmodules'), '[submodule \"vendor\"]\\npath = libs/vendor\\nurl = https://invalid.example/vendor\\n');\n      mkdirSync(join(integration, 'libs/vendor'), { recursive: true });\n      execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},libs/vendor`], { cwd: integration });\n    }\n    const ref = missingSubmodule\n      ? commitAllFixture(integration, 'record unavailable input-only submodule')\n      : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: integration, encoding: 'utf8' }).trim();\n    const bin = join(dirname(integration), 'input-only-git-bin');\n    const trace = join(dirname(integration), 'input-only-git-trace');\n    const errors = join(dirname(integration), 'input-only-errors');\n    mkdirSync(bin);\n    const realGit = execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();\n    writeFileSync(join(bin, 'git'), `#!/bin/bash\nprintf '%s\\\\n' \"$*\" >> \"$INPUT_ONLY_TRACE\"\nif { [ \"$INPUT_ONLY_MODE\" = list-fail ] && [ \"$3\" = ls-tree ] && [ \"$4\" = -r ]; } ||\n   { [ \"$INPUT_ONLY_MODE\" = blob-fail ] && [ \"$3\" = cat-file ] && [ \"$4\" = blob ]; } ||\n   { [ \"$INPUT_ONLY_MODE\" = ref-fail ] && [ \"$3\" = rev-parse ] && [ \"$4\" = --verify ]; }; then\n  \"$INPUT_ONLY_REAL_GIT\" \"$@\"\n  exit 42\nfi\nif [ \"$INPUT_ONLY_MODE\" = modules-fail ] && [ \"$3\" = config ]; then exit 42; fi\nexec \"$INPUT_ONLY_REAL_GIT\" \"$@\"\n`, { mode: 0o755 });\n    const result = spawnSync('bash', ['-c', [\n      'set -euo pipefail', 'source \"$SCRIPT\"', 'source \"$GUARDS\"', override,\n      'dependency_generation_input_only \"$INTEGRATION\" \"$REF\" \"$ERRORS\"',\n      'printf \"INPUT_ONLY_READY\\\\n\"',\n    ].join('\\n')], {\n      encoding: 'utf8',\n      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SCRIPT, GUARDS: guards,\n        INTEGRATION: integration, REF: ref, ERRORS: errors, INPUT_ONLY_MODE: mode,\n        INPUT_ONLY_TRACE: trace, INPUT_ONLY_REAL_GIT: realGit },\n    });\n    return { result, integration, ref, trace, errors };\n  }\n\n  it('matches the maintained fingerprint without a generation record or store', () => {\n    const { result, integration, ref } = inputOnly();\n    expect(result.status, result.stderr).toBe(0);\n    expect(result.stdout).toContain('INPUT_ONLY_READY');\n    expect(publishedInputFingerprint(result.stdout)).toBe(publishedInputFingerprint(fingerprintRef(integration, ref).stdout));\n    expect(existsSync(join(integration, '.papercusp/dependency-generation-root'))).toBe(false);\n    expect(existsSync(join(integration, '.papercusp/dependency-generations'))).toBe(false);\n  }, NATIVE_SHELL_TIMEOUT_MS);\n\n  it.each(['list-fail', 'blob-fail', 'ref-fail', 'modules-fail'])('withholds readiness after %s even when Git emitted correct bytes', mode => {\n    const { result } = inputOnly(mode);\n    expect(result.status).not.toBe(0);\n    expect(result.stdout).not.toContain('INPUT_ONLY_READY');\n    expect(result.stdout).not.toContain('DEPENDENCY_INPUT_FINGERPRINT');\n  }, NATIVE_SHELL_TIMEOUT_MS);\n\n  it('refuses a missing submodule without fetching or initializing it', () => {\n    const { result, integration, trace, errors } = inputOnly('ok', true);\n    expect(result.status, result.stderr).toBe(74);\n    expect(result.stdout).not.toContain('INPUT_ONLY_READY');\n    expect(readFileSync(errors, 'utf8')).toContain('hydration forbidden');\n    expect(readFileSync(trace, 'utf8')).not.toMatch(/\\b(fetch|submodule)\\b/);\n    expect(existsSync(join(integration, 'libs/vendor/.git'))).toBe(false);\n  }, NATIVE_SHELL_TIMEOUT_MS);\n\n  it('blocks a mutating Git command before it reaches Git', () => {\n    const { result, trace, errors } = inputOnly('ok', false,\n      'dependency_generation_input_manifest_ref() { git -C \"$INTEGRATION\" fetch origin; }');\n    expect(result.status, result.stderr).toBe(74);\n    expect(readFileSync(errors, 'utf8')).toContain('forbidden git command: fetch');\n    expect(readFileSync(trace, 'utf8')).not.toContain('fetch');\n    expect(result.stdout).not.toContain('INPUT_ONLY_READY');\n  }, NATIVE_SHELL_TIMEOUT_MS);\n});\n\n",
    "fixtureSha256": "1b007e25a919fa4e9c69bfb6d028213cbf430e048d88aa904cad416845b558f7",
    "recoveryBinding": "Current seven-case block equals recovered initial patch plus the two recorded fixture corrections; the first comparison's sole extra line was the next describe header, not a semantic block difference. Current full file differs after peer edits outside this block.",
    "cases": [
      "Matches maintained schema1 fingerprint without generation root/store creation",
      "Git ls-tree emits valid bytes then fails: readiness withheld",
      "Git cat-file emits valid bytes then fails: readiness withheld",
      "Git rev-parse emits valid bytes then fails: readiness withheld",
      "Git config fails: readiness withheld",
      "Unavailable committed submodule: exit74 with hydration/fetch/init forbidden",
      "Mutating Git fetch request blocked before reaching Git"
    ],
    "limits": "Seven passed, zero failed, 203 excluded by testNamePattern. These are unit tests with real local Git fixture subprocesses; native-proof protocol is unqualified and product acceptance unmeasured. They do not prove candidate measurement/installed Bun/full suite acceptance. No test rerun for recovery."
  },
  "admissionRequested": "Independent source review of the COMPLETE exact packet and a recorded distinct decision. If accepted, perform only the required targeted Discovery reconciliation, fresh semantic activation/canonical ordinary start/current execution readiness, exact serving-source containment and positive managed confinement checks before one exact command. Existing historical audit/start is not new native permission. If changes required, publish a new packet edition and rebind exact bytes.",
  "remaining": "Node selected, Bun UNSHIPPED. Dependency generation discovery/readiness/build/native/installed full matrix, P004 launcher acceptance, canary/soak/rollback and final shipment remain open."
}

