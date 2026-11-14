---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/external-entry-activation-preparation-20261109-r1/preparation-summary.json"
updated_at: 1794265036331
_body: "content"
---

{
  "schemaVersion": "external-entry-activation-preparation-summary-v1",
  "workItem": "WI-6554700010046192",
  "plan": "agent-latency-causes-remediation-2026-11-06",
  "governingRuling": 1222463,
  "scope": "PREPARATION ONLY; no runtime qualification, maintained test run, task attempt or product behavior edit",
  "sourceAudit": {
    "byteLength": 45232,
    "sha256": "2441729825f3073dba0e9ed6abd30accbf8513ce5f809c5cc8c5d94d41abed2a",
    "gzipBytes": 7597,
    "entries": [
      {
        "pkg": "mem0ai/oss",
        "imports": 29,
        "dynamics": 46,
        "constructors": 0,
        "dangerous": 0,
        "bindings": [
          {
            "name": "convertToLangchainMessages",
            "refs": 2,
            "violations": 0
          },
          {
            "name": "getNodeFs",
            "refs": 1,
            "violations": 0
          }
        ],
        "unresolved": [
          {
            "spec": "@aws-sdk/client-bedrock-runtime",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "cohere-ai",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "@mochow/mochow-sdk-node",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "chromadb",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "iovalkey",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "@aws-sdk/client-bedrock-runtime",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "fastembed",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "@databricks/sql",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "@aws-sdk/client-neptune-graph",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "@google-cloud/aiplatform",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "@elastic/elasticsearch",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "@opensearch-project/opensearch",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "@upstash/vector",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "mysql2/promise",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "@google-cloud/aiplatform",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "cassandra-driver",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "@pinecone-database/pinecone",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "@aws-sdk/client-s3vectors",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "@turbopuffer/turbopuffer",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "mongodb",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "weaviate-client",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          },
          {
            "spec": "oracledb",
            "errorCode": "ERR_MODULE_NOT_FOUND"
          }
        ]
      },
      {
        "pkg": "@huggingface/transformers",
        "imports": 12,
        "dynamics": 1,
        "constructors": 3,
        "dangerous": 0,
        "bindings": [
          {
            "name": "tc",
            "refs": 1,
            "violations": 1
          }
        ],
        "unresolved": []
      }
    ]
  },
  "findings": [
    "mem0ai entry static imports reach better-sqlite3; Transformers static imports reach onnxruntime-node and sharp. Entry non-entry requires actual attempt-bound engine proof; mere constructor census balance is insufficient.",
    "mem0ai has 46 direct dynamic import sites; the complete recorded two-entry AST distinguishes those from the 29 static import declarations. Missing optional import targets do not prove attempt non-entry.",
    "Transformers contains two new Worker sites and one new Function site in its bundled Web/WASM code. Both Worker identifiers have no lexical binding in the exact entry; they are NOT established Node worker_threads views.",
    "Transformers computed import helper tc has one recorded assignment and one lexical use tc(y) in fs4. fs4 chooses a built-in module or a configurable/generated WASM module URL. Exact source conditions, helper bindings and UTF-16 offsets retained.",
    "Scope is two entry modules, not a complete transitive graph. Imported aliases, generated Function behavior, native-addon worker construction and actual activation remain UNKNOWN."
  ],
  "sourceBarrier": {
    "head": "794e082c832727e1d05f59367f956aedaa73b645",
    "observer": "9ff5e23397e966d30fefd84c3c7cacc2b9ad3cc83a7c5aac3e66855dc22b5944",
    "readerWorking": "7757894a732a367ce89b909a4d9ff72e3af868324eaa11ff2556237043d025c6",
    "readerHEAD": "acb544f3c1efc3a89d3b794d9ad65f8828295c3e1a0d7c81800138ade53a77ed",
    "testWorking": "bda2e6401039da2bd00d6f7925ce524906fee13ed3d2b2fbd3b1eb34091338d9",
    "testHEAD": "7cf7f0c76f33b07561d81cc49ed9ef0dfeba8761b146142fa54ad9047ee4ed30",
    "qualificationControls": "NOT RUN; mixed committed source remains ineligible"
  },
  "failedAttempt": "First two-entry analysis output exceeded the native tool result cap; no usable complete artifact from that attempt. Recomputed bounded entry analysis emitted gzip+base64 with complete capture. The prior whole-84MB Babel/4GB exit134 remains failed and was NOT retried.",
  "baselineAttempts": 0,
  "productBehaviorEdits": 0,
  "immutableBaselineRule": "Complete 60 baseline attempts and independent acceptance before product behavior edits.",
  "remaining": "Source barrier, maintained pending controls, complete source/constructor/engine/load/native qualification, actual immutable baseline60 independent acceptance, candidate60 and full16 shipment; historical incident chain retained.",
  "priorCheckpoint": "verification/WI-6554700010046192/LATENCY-M1/external-entry-activation-preparation-20261109-r1/prior-checkpoint-b2a0600e0d45.md"
}
