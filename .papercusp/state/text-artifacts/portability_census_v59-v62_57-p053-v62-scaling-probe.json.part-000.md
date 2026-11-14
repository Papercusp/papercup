---
rel_path: "portability/census/v59-v62/57-p053-v62-scaling-probe.json.part-000"
updated_at: 1794254873437
_body: "content"
---

{
  "scope": "bounded saved-input generateStateCensus benchmark; not a host collection rerun or acceptance test",
  "sourcePin": "738a90b7c540fbb87e5c13ac28fd3305c25beaf0ca3b618f900f7ac62e9b73cf",
  "snapshot": "/tmp/p053-v61-host.before-filesystem.json",
  "samples": [
    {
      "requested": 64,
      "results": [
        {
          "condition": "all-declarations",
          "entries": 64,
          "declarations": 77748,
          "pairChecks": 4975872,
          "wallMs": 153.21880599999997,
          "cpuMs": 223.136,
          "resultSha256": "7e0bb53e2cf14ffc90837de8b9cd22318f5d6f81016cadd1c49e3eb236fe41a2"
        },
        {
          "condition": "same-kind-declarations",
          "entries": 64,
          "declarations": 1481,
          "pairChecks": 94784,
          "wallMs": 1.6913460000000669,
          "cpuMs": 1.69,
          "resultSha256": "7e0bb53e2cf14ffc90837de8b9cd22318f5d6f81016cadd1c49e3eb236fe41a2"
        }
      ],
      "sameResult": true
    },
    {
      "requested": 256,
      "results": [
        {
          "condition": "all-declarations",
          "entries": 256,
          "declarations": 77748,
          "pairChecks": 19903488,
          "wallMs": 205.34110399999997,
          "cpuMs": 224.094,
          "resultSha256": "2d74e703380f6b6eca7d0ffc59ccc639daafe91539c710ef0b4dab2e161e7d1f"
        },
        {
          "condition": "same-kind-declarations",
          "entries": 256,
          "declarations": 1481,
          "pairChecks": 379136,
          "wallMs": 9.760066000000052,
          "cpuMs": 9.721,
          "resultSha256": "2d74e703380f6b6eca7d0ffc59ccc639daafe91539c710ef0b4dab2e161e7d1f"
        }
      ],
      "sameResult": true
    },
    {
      "requested": 1024,
      "results": [
        {
          "condition": "all-declarations",
          "entries": 1024,
          "declarations": 77748,
          "pairChecks": 79613952,
          "wallMs": 635.932216,
          "cpuMs": 635.865,
          "resultSha256": "d3a9ec87508989836acee56eaecb8da38b69c637c5e0937bbc1d087c96986df6"
        },
        {
          "condition": "same-kind-declarations",
          "entries": 1024,
          "declarations": 1481,
          "pairChecks": 1516544,
          "wallMs": 19.390022000000044,
          "cpuMs": 19.349,
          "resultSha256": "d3a9ec87508989836acee56eaecb8da38b69c637c5e0937bbc1d087c96986df6"
        }
      ],
      "sameResult": true
    }
  ],
  "wholeInstallVerified": false
}
