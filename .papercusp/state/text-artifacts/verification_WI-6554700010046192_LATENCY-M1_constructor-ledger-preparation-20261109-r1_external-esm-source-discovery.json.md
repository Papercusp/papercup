---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/constructor-ledger-preparation-20261109-r1/external-esm-source-discovery.json"
updated_at: 1794260432086
_body: "content"
---

{
  "schemaVersion": "external-esm-source-discovery-v1",
  "parent": "file:///tmp/latency-baseline-runtime-20261108-r4/hono-host.mjs",
  "bundleSha256": "40383d2173d5e438638c9528599816fff1707e5b6872d42f144fd762144d25bc",
  "scope": "resolution and direct-source AST only; no execution or transitive/native closure",
  "entries": [
    {
      "pkg": "mem0ai/oss",
      "url": "file:///tmp/latency-baseline-git-source-20261108-r1/node_modules/mem0ai/dist/oss/index.mjs",
      "path": "/tmp/latency-baseline-git-source-20261108-r1/node_modules/mem0ai/dist/oss/index.mjs",
      "byteLength": 606986,
      "sha256": "0344af33887153828c572e7e74c59081976b6f769e516fbb66ef3ebdd8a8bbd7",
      "parseErrors": 0,
      "imports": [
        "uuid",
        "crypto",
        "zod",
        "openai",
        "better-sqlite3",
        "fs",
        "path",
        "os",
        "axios"
      ],
      "dynamic": [
        {
          "line": 179,
          "source": "import(\"@aws-sdk/client-bedrock-runtime\")"
        },
        {
          "line": 330,
          "source": "import(\"ollama\")"
        },
        {
          "line": 588,
          "source": "import(\"@anthropic-ai/sdk\")"
        },
        {
          "line": 661,
          "source": "import(\"groq-sdk\")"
        },
        {
          "line": 708,
          "source": "import(\"@mistralai/mistralai\")"
        },
        {
          "line": 1189,
          "source": "import(\"cohere-ai\")"
        },
        {
          "line": 1319,
          "source": "import(\"zeroentropy\")"
        },
        {
          "line": 1367,
          "source": "import(\"@huggingface/transformers\")"
        },
        {
          "line": 1507,
          "source": "import(\"@mochow/mochow-sdk-node\")"
        },
        {
          "line": 1920,
          "source": "import(\"@qdrant/js-client-rest\")"
        },
        {
          "line": 2380,
          "source": "import(\"chromadb\")"
        },
        {
          "line": 2654,
          "source": "import(\"cloudflare\")"
        },
        {
          "line": 3143,
          "source": "import(\"redis\")"
        },
        {
          "line": 3662,
          "source": "import(\"iovalkey\")"
        },
        {
          "line": 4035,
          "source": "import(\"ollama\")"
        },
        {
          "line": 4306,
          "source": "import(\"@aws-sdk/client-bedrock-runtime\")"
        },
        {
          "line": 4595,
          "source": "import(\"@supabase/supabase-js\")"
        },
        {
          "line": 5022,
          "source": "import(\"@supabase/supabase-js\")"
        },
        {
          "line": 5100,
          "source": "import(\"@google/genai\")"
        },
        {
          "line": 5139,
          "source": "import(\"@google/genai\")"
        },
        {
          "line": 5360,
          "source": "import(\"fastembed\")"
        },
        {
          "line": 6073,
          "source": "import(\"@langchain/core/messages\")"
        },
        {
          "line": 6333,
          "source": "import(\"@langchain/core/documents\")"
        },
        {
          "line": 6456,
          "source": "import(\"@azure/search-documents\")"
        },
        {
          "line": 6466,
          "source": "import(\"@azure/identity\")"
        },
        {
          "line": 7128,
          "source": "import(\"pg\")"
        },
        {
          "line": 8085,
          "source": "import(\"@databricks/sql\")"
        },
        {
          "line": 9337,
          "source": "import(\"@aws-sdk/client-neptune-graph\")"
        },
        {
          "line": 9442,
          "source": "import(\"@google-cloud/aiplatform\")"
        },
        {
          "line": 9606,
          "source": "import(\"@elastic/elasticsearch\")"
        },
        {
          "line": 9857,
          "source": "import(\"@opensearch-project/opensearch\")"
        },
        {
          "line": 10327,
          "source": "import(\"@upstash/vector\")"
        },
        {
          "line": 10536,
          "source": "import(\"@azure/identity\")"
        },
        {
          "line": 10553,
          "source": "import(\"mysql2/promise\")"
        },
        {
          "line": 10784,
          "source": "import(\"@google-cloud/aiplatform\")"
        },
        {
          "line": 11302,
          "source": "import(\"cassandra-driver\")"
        },
        {
          "line": 11540,
          "source": "import(\"@pinecone-database/pinecone\")"
        },
        {
          "line": 11825,
          "source": "import(\"@aws-sdk/client-s3vectors\")"
        },
        {
          "line": 12532,
          "source": "import(\"@turbopuffer/turbopuffer\")"
        },
        {
          "line": 13151,
          "source": "import(\"mongodb\")"
        },
        {
          "line": 13557,
          "source": "import(\"weaviate-client\")"
        },
        {
          "line": 14006,
          "source": "import(\"oracledb\")"
        },
        {
          "line": 16859,
          "source": "import(\"fs\")"
        },
        {
          "line": 16860,
          "source": "import(\"path\")"
        },
        {
          "line": 16861,
          "source": "import(\"os\")"
        },
        {
          "line": 16862,
          "source": "import(\"crypto\")"
        }
      ]
    },
    {
      "pkg": "@huggingface/transformers",
      "url": "file:///tmp/latency-baseline-git-source-20261108-r1/node_modules/@huggingface/transformers/dist/transformers.node.mjs",
      "path": "/tmp/latency-baseline-git-source-20261108-r1/node_modules/@huggingface/transformers/dist/transformers.node.mjs",
      "byteLength": 1256499,
      "sha256": "4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d",
      "parseErrors": 0,
      "imports": [
        "fs",
        "path",
        "url",
        "onnxruntime-node",
        "onnxruntime-common",
        "stream",
        "stream/promises",
        "sharp"
      ],
      "dynamic": [
        {
          "line": 9984,
          "source": "import(\n    /*webpackIgnore:true*/\n    /*@vite-ignore*/\n    a\n  )"
        }
      ]
    },
    {
      "pkg": "onnxruntime-node",
      "url": "file:///tmp/latency-baseline-git-source-20261108-r1/node_modules/onnxruntime-node/dist/index.js",
      "path": "/tmp/latency-baseline-git-source-20261108-r1/node_modules/onnxruntime-node/dist/index.js",
      "byteLength": 1602,
      "sha256": "019eb02133b94b1f7fdf2d89eb93b590ce1288d271f7b280647fb3978e6391fa",
      "parseErrors": 0,
      "imports": [],
      "dynamic": [
        {
          "line": 20,
          "source": "require(\"onnxruntime-common\")"
        },
        {
          "line": 21,
          "source": "require(\"./backend\")"
        },
        {
          "line": 23,
          "source": "require(\"onnxruntime-common\")"
        },
        {
          "line": 24,
          "source": "require(\"./version\")"
        },
        {
          "line": 25,
          "source": "require(\"./backend\")"
        }
      ]
    }
  ],
  "nativeBoundary": {
    "path": "/tmp/latency-baseline-git-source-20261108-r1/node_modules/onnxruntime-node/dist/binding.js",
    "byteLength": 1507,
    "sha256": "65be03f9a10c7ad773c22185a94f0b80835cd40ddcdc2acd63c1fbe96f94cbb8",
    "nativePath": "/tmp/latency-baseline-git-source-20261108-r1/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node",
    "nativeBytes": 384040,
    "closure": "unknown: module evaluation loads platform addon; static resolution cannot prove native constructor behavior"
  }
}
