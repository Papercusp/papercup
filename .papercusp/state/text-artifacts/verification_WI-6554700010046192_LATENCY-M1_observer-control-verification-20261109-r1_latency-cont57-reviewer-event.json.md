---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-control-verification-20261109-r1/latency-cont57-reviewer-event.json"
updated_at: 1794251091900
_body: "content"
---

{
  "event_inspection": {
    "event": "coord:inbox-wake:su-9b9bd4c6-34cd-4356-acb1-a53a444aa1b7",
    "current_generation": null,
    "current_state": "fired_undeclared",
    "fire_latch": {
      "first_fired_at": "2026-11-09 13:22:50.359437-05",
      "last_fired_at": "2026-11-09 13:33:17.919507-05",
      "last_fired_by": "su-24790d3e-5b5a-41fa-a8b0-4faf7584ec9f",
      "fire_count": 3
    },
    "advice": "This key has genuinely fired 3× (most recently 2026-11-09 13:33:17.919507-05 by su-24790d3e-5b5a-41fa-a8b0-4faf7584ec9f) but was never declared via events:emit { announce:true } — do NOT read current_state:'fired_undeclared' as \"never happened\". If you were about to conclude this gate never opened, it did; check waiters[]/wake_outcomes[] below or last_fired_at for when.",
    "declarations": [],
    "waiters": [
      {
        "await_id": 421212,
        "subscriber_id": "su-9b9bd4c6-34cd-4356-acb1-a53a444aa1b7",
        "policy": "wake",
        "state": "registered",
        "registered_at": "2026-11-09T17:59:41.189Z",
        "fired_at": null,
        "fired_reason": null,
        "cancelled_at": null,
        "expires_ts": null
      }
    ],
    "wake_outcomes": [
      {
        "delivery_id": 1153557,
        "subscriber_id": "su-9b9bd4c6-34cd-4356-acb1-a53a444aa1b7",
        "status": "parked",
        "channel": null,
        "turn_invoked": false,
        "turn_proof": null,
        "turn_started_at": null,
        "attempts": 4,
        "source": "pickup-escalation",
        "last_error": "resume claim for adv session #58953 was won by another resumer; parked before Channel 2 spawn",
        "created_at": "2026-11-09T18:47:15.395Z",
        "delivered_at": null
      },
      {
        "delivery_id": 1153448,
        "subscriber_id": "su-9b9bd4c6-34cd-4356-acb1-a53a444aa1b7",
        "status": "pending",
        "channel": null,
        "turn_invoked": false,
        "turn_proof": null,
        "turn_started_at": null,
        "attempts": 7,
        "source": "su-24790d3e-5b5a-41fa-a8b0-4faf7584ec9f",
        "last_error": "resume-turn-death:agent_crash",
        "created_at": "2026-11-09T18:33:17.927Z",
        "delivered_at": null
      },
      {
        "delivery_id": 1153445,
        "subscriber_id": "su-9b9bd4c6-34cd-4356-acb1-a53a444aa1b7",
        "status": "delivered",
        "channel": "inbox",
        "turn_invoked": false,
        "turn_proof": "not-picked-up",
        "turn_started_at": null,
        "attempts": 8,
        "source": "su-24790d3e-5b5a-41fa-a8b0-4faf7584ec9f",
        "last_error": null,
        "created_at": "2026-11-09T18:32:02.230Z",
        "delivered_at": "2026-11-09T18:37:04.014Z"
      },
      {
        "delivery_id": 1153383,
        "subscriber_id": "su-9b9bd4c6-34cd-4356-acb1-a53a444aa1b7",
        "status": "delivered",
        "channel": "inbox",
        "turn_invoked": false,
        "turn_proof": null,
        "turn_started_at": null,
        "attempts": 8,
        "source": "su-24790d3e-5b5a-41fa-a8b0-4faf7584ec9f",
        "last_error": null,
        "created_at": "2026-11-09T18:22:50.378Z",
        "delivered_at": "2026-11-09T18:27:49.536Z"
      }
    ],
    "history_window": {
      "limit": 10,
      "declarations": {
        "loaded_rows": 0,
        "shown": 0,
        "omitted_loaded": 0,
        "more_available": false
      },
      "waiters": {
        "loaded_rows": 1,
        "shown": 1,
        "omitted_loaded": 0,
        "more_available": false
      },
      "wake_outcomes": {
        "loaded_rows": 4,
        "shown": 4,
        "omitted_loaded": 0,
        "more_available": false
      }
    },
    "resync": {
      "required": false,
      "reason": "watermark_not_supplied",
      "consumer_generation": null,
      "authoritative_generation": null,
      "rule": "Replace cached state with this exact-key snapshot whenever required=true; then persist authoritative_generation as the next watermark.",
      "next_verb": "events:status { event: \"coord:inbox-wake:su-9b9bd4c6-34cd-4356-acb1-a53a444aa1b7\" }"
    }
  }
}

