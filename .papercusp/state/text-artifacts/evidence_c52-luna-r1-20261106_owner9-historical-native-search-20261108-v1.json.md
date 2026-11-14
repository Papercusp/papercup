---
rel_path: "evidence/c52-luna-r1-20261106/owner9-historical-native-search-20261108-v1.json"
updated_at: 1794179093854
_body: "content"
---

{
  "schemaVersion": "luna-r1-owner9-native-search-v1",
  "workItem": "WI-6554700010045700",
  "cases": [
    {
      "id": "EI-26217185985299604",
      "owner": "su-55595f20-e777-401b-92a3-3f06394a9541",
      "since": "2026-10-27T16:15:00Z",
      "until": "2026-10-27T16:45:00Z"
    },
    {
      "id": "EI-27707885265505216",
      "owner": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
      "since": "2026-11-06T03:10:00Z",
      "until": "2026-11-06T03:35:00Z"
    },
    {
      "id": "EI-25398054129696034",
      "owner": "su-82592767-2742-45b8-b053-4b096877bacc",
      "since": "2026-10-13T17:00:00Z",
      "until": "2026-10-13T17:25:00Z"
    }
  ],
  "reads": [
    {
      "status": "fulfilled",
      "value": {
        "case": {
          "id": "EI-26217185985299604",
          "owner": "su-55595f20-e777-401b-92a3-3f06394a9541",
          "since": "2026-10-27T16:15:00Z",
          "until": "2026-10-27T16:45:00Z"
        },
        "result": {
          "ok": true,
          "query": "EI-26217185985299604",
          "mode": "verbatim",
          "window": {
            "until": "2026-10-27T16:45:00Z"
          },
          "hint": "0 hits: verbatim mode matches only an exact, contiguous, case-insensitive substring — a paraphrase or multi-word description of what you remember will NOT match even if the content exists. Retry with mode:'hybrid' (meaning-based, the default) to search by concept, or narrow query to the exact short phrase you expect verbatim in the transcript. Do not read this 0 as \"it didn't happen\" — it also cannot see text that lives only inside a tool call or tool result (a file body, a report, most interactive-tool answers), which this index excludes by design regardless of query phrasing (see zeroHitCaveat if a match was found there).",
          "zeroHitCaveat": "⚠ FOUND, JUST NOT IN A TEXT TURN: 0 hits among plain conversational turns, but the exact string appears inside a tool call or tool result. toolPartMatch identifies one exact indexed part; its stored text may be truncated at ingest. Recover complete arguments/results from that session's native transcript (the returned path is unverified, or unresolved when unavailable). sessions:read reads session_turns and excludes tool calls/results; it cannot recover this payload. This 0 is NOT evidence the text was never written.",
          "toolPartMatch": {
            "indexedLocator": {
              "table": "harness_shared.session_turn_parts",
              "workspace_id": "default",
              "source_kind": "codex",
              "session_id": "01a17e14-ad10-7ec3-a407-b34f5efb06e3",
              "part_idx": 38,
              "part_kind": "tool_use",
              "tool_name": "exec"
            },
            "indexedContent": {
              "completeness": "may-be-truncated-at-ingest",
              "storedChars": 784
            },
            "nativeTranscript": {
              "path": null,
              "status": "unresolved"
            }
          },
          "total_hits": 0,
          "hasMore": false,
          "results": [],
          "_meta": {
            "explicitFullRequest": true,
            "format": "json",
            "_seeAlso": [
              {
                "tool": "sessions:read (window read)"
              },
              {
                "tool": "sessions:list (enumerate sessions)"
              },
              {
                "tool": "search:semantic (other corpora)"
              }
            ]
          }
        }
      }
    },
    {
      "status": "fulfilled",
      "value": {
        "case": {
          "id": "EI-27707885265505216",
          "owner": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
          "since": "2026-11-06T03:10:00Z",
          "until": "2026-11-06T03:35:00Z"
        },
        "result": {
          "ok": true,
          "query": "EI-27707885265505216",
          "mode": "verbatim",
          "window": {
            "until": "2026-11-06T03:35:00Z"
          },
          "hint": "0 hits: verbatim mode matches only an exact, contiguous, case-insensitive substring — a paraphrase or multi-word description of what you remember will NOT match even if the content exists. Retry with mode:'hybrid' (meaning-based, the default) to search by concept, or narrow query to the exact short phrase you expect verbatim in the transcript. Do not read this 0 as \"it didn't happen\" — it also cannot see text that lives only inside a tool call or tool result (a file body, a report, most interactive-tool answers), which this index excludes by design regardless of query phrasing (see zeroHitCaveat if a match was found there).",
          "zeroHitCaveat": "⚠ FOUND, JUST NOT IN A TEXT TURN: 0 hits among plain conversational turns, but the exact string appears inside a tool call or tool result. toolPartMatch identifies one exact indexed part; its stored text may be truncated at ingest. Recover complete arguments/results from that session's native transcript (the returned path is unverified, or unresolved when unavailable). sessions:read reads session_turns and excludes tool calls/results; it cannot recover this payload. This 0 is NOT evidence the text was never written.",
          "toolPartMatch": {
            "indexedLocator": {
              "table": "harness_shared.session_turn_parts",
              "workspace_id": "default",
              "source_kind": "codex",
              "session_id": "01a1aebc-2a31-70e0-be94-12664e8fb26c",
              "part_idx": 96,
              "part_kind": "tool_use",
              "tool_name": "exec"
            },
            "indexedContent": {
              "completeness": "may-be-truncated-at-ingest",
              "storedChars": 370
            },
            "nativeTranscript": {
              "path": null,
              "status": "unresolved"
            }
          },
          "total_hits": 0,
          "hasMore": false,
          "results": [],
          "_meta": {
            "explicitFullRequest": true,
            "format": "json",
            "_seeAlso": [
              {
                "tool": "sessions:read (window read)"
              },
              {
                "tool": "sessions:list (enumerate sessions)"
              },
              {
                "tool": "search:semantic (other corpora)"
              }
            ]
          }
        }
      }
    },
    {
      "status": "fulfilled",
      "value": {
        "case": {
          "id": "EI-25398054129696034",
          "owner": "su-82592767-2742-45b8-b053-4b096877bacc",
          "since": "2026-10-13T17:00:00Z",
          "until": "2026-10-13T17:25:00Z"
        },
        "result": {
          "ok": true,
          "query": "EI-25398054129696034",
          "mode": "verbatim",
          "window": {
            "until": "2026-10-13T17:25:00Z"
          },
          "hint": "0 hits: verbatim mode matches only an exact, contiguous, case-insensitive substring — a paraphrase or multi-word description of what you remember will NOT match even if the content exists. Retry with mode:'hybrid' (meaning-based, the default) to search by concept, or narrow query to the exact short phrase you expect verbatim in the transcript. Do not read this 0 as \"it didn't happen\" — it also cannot see text that lives only inside a tool call or tool result (a file body, a report, most interactive-tool answers), which this index excludes by design regardless of query phrasing (see zeroHitCaveat if a match was found there).",
          "total_hits": 0,
          "hasMore": false,
          "results": [],
          "_meta": {
            "explicitFullRequest": true,
            "format": "json",
            "_seeAlso": [
              {
                "tool": "sessions:read (window read)"
              },
              {
                "tool": "sessions:list (enumerate sessions)"
              },
              {
                "tool": "search:semantic (other corpora)"
              }
            ]
          }
        }
      }
    }
  ]
}
