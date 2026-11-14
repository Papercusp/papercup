---
rel_path: "portability/census/p053-native-production-v4.proof-a934cbda1c320c5a.json"
updated_at: 1794213828048
_body: "content"
---

{
  "summary": {
    "startedAt": "2026-11-09T08:40:35.572Z",
    "finishedAt": "2026-11-09T08:42:56.591Z",
    "ok": false,
    "wholeInstallVerified": false,
    "scope": "implemented-writer-filesystem-roots-and-host-catalogs",
    "inventory": 15431,
    "residue": 3266,
    "roots": 4
  },
  "target": {
    "host": "localhost",
    "port": "5432",
    "database": "/papercusp"
  },
  "sourceBefore": [
    {
      "path": "scripts/state-census-roots.mts",
      "sha256": "9ca1c70dfa0488e26b5cf46034d2d2fdfccc66176306a2980bb798069d16ecc6"
    },
    {
      "path": "packages/operator-core/lib/backup/state-census-producers.ts",
      "sha256": "02a71afaa305f3e6b1b865a6cc6e218a00bc8efc0c09950b4fe9a7d26eac0ecb"
    },
    {
      "path": "packages/operator-core/lib/backup/state-census-cli.test.ts",
      "sha256": "b7e9d875139956abd72d03e765ea3a8eff4f752f7adda0a45f94d3c83e28c19a"
    },
    {
      "path": "packages/backup/src/state-census.ts",
      "sha256": "738a90b7c540fbb87e5c13ac28fd3305c25beaf0ca3b618f900f7ac62e9b73cf"
    }
  ],
  "sourceAfter": [
    {
      "path": "scripts/state-census-roots.mts",
      "sha256": "9ca1c70dfa0488e26b5cf46034d2d2fdfccc66176306a2980bb798069d16ecc6"
    },
    {
      "path": "packages/operator-core/lib/backup/state-census-producers.ts",
      "sha256": "02a71afaa305f3e6b1b865a6cc6e218a00bc8efc0c09950b4fe9a7d26eac0ecb"
    },
    {
      "path": "packages/operator-core/lib/backup/state-census-cli.test.ts",
      "sha256": "b7e9d875139956abd72d03e765ea3a8eff4f752f7adda0a45f94d3c83e28c19a"
    },
    {
      "path": "packages/backup/src/state-census.ts",
      "sha256": "738a90b7c540fbb87e5c13ac28fd3305c25beaf0ca3b618f900f7ac62e9b73cf"
    }
  ],
  "sourceUnchanged": true,
  "outputSha256": "d45c1a6457c331188e9d789f0a3da4ffcfed758ddeb34258363b0a6c936af82b"
}
