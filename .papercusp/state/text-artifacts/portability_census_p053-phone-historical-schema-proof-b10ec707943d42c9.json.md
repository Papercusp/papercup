---
rel_path: "portability/census/p053-phone-historical-schema-proof-b10ec707943d42c9.json"
updated_at: 1794195311618
_body: "content"
---

{
  "sources": [
    {
      "producer": "app-migrations:registry:phone-app:/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app",
      "tables": [
        "public.phone_calls",
        "public.phone_call_preparations",
        "public.phone_transcript_segments",
        "public.phone_voicemails",
        "public.phone_scheduled_calls",
        "public.phone_numbers",
        "public.phone_provider_events",
        "public.phone_usage_accounts",
        "public.phone_usage_reservations",
        "public.phone_usage_charge_events",
        "public.phone_call_units",
        "public.phone_call_action_items"
      ]
    },
    {
      "producer": "app-migrations:registry:phone-app:/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app:git-blob:b6dcecaf6cdcba7ce0e4ebc09aabfe4b3afb74d2:packages/data/src/migrations.ts",
      "tables": [
        "public.phone_calls",
        "public.phone_call_preparations",
        "public.phone_transcript_segments",
        "public.phone_voicemails",
        "public.phone_scheduled_calls",
        "public.phone_numbers",
        "public.phone_provider_events",
        "public.phone_usage_accounts",
        "public.phone_usage_reservations",
        "public.phone_usage_charge_events",
        "public.phone_call_units",
        "public.phone_call_action_items"
      ],
      "columns": [
        {
          "table": "public.phone_calls",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "conversation_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "parent_operator_conversation_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "direction",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "caller_label",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "disposition",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "started_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_calls",
          "name": "ended_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_calls",
          "name": "duration_sec",
          "type": "integer"
        },
        {
          "table": "public.phone_calls",
          "name": "summary",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "transcript_text",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "search_document",
          "type": "tsvector"
        },
        {
          "table": "public.phone_calls",
          "name": "updated_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "attempt_id",
          "type": "text"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "phase",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "seq",
          "type": "integer"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "speaker",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "text",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_voicemails",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "transcript",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "duration_sec",
          "type": "integer"
        },
        {
          "table": "public.phone_voicemails",
          "name": "caller_label",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "created_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_voicemails",
          "name": "read_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "title",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "guest_name",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "guest_email",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "scheduled_for",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "duration_min",
          "type": "integer"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "invite_token",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "created_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_numbers",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "e164",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "provider",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "provider_account_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "trunk_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "assistant_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "provider",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "provider_account_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "event_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "payload_identity",
          "type": "text"
        },
        {
          "table": "public.phone_usage_accounts",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_accounts",
          "name": "period_id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_accounts",
          "name": "state",
          "type": "jsonb"
        },
        {
          "table": "public.phone_usage_reservations",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_reservations",
          "name": "period_id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_reservations",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_reservations",
          "name": "state",
          "type": "jsonb"
        },
        {
          "table": "public.phone_usage_charge_events",
          "name": "event_key",
          "type": "text"
        },
        {
          "table": "public.phone_usage_charge_events",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_charge_events",
          "name": "period_id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_charge_events",
          "name": "reservation_id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_charge_events",
          "name": "state",
          "type": "jsonb"
        },
        {
          "table": "public.phone_call_units",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_call_units",
          "name": "call_key",
          "type": "text"
        },
        {
          "table": "public.phone_call_units",
          "name": "kind",
          "type": "text"
        },
        {
          "table": "public.phone_call_units",
          "name": "scheduled_id",
          "type": "text"
        },
        {
          "table": "public.phone_call_units",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_call_units",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_call_units",
          "name": "brief_status",
          "type": "text"
        },
        {
          "table": "public.phone_call_units",
          "name": "brief_handle",
          "type": "jsonb"
        },
        {
          "table": "public.phone_call_units",
          "name": "brief_result",
          "type": "text"
        },
        {
          "table": "public.phone_call_units",
          "name": "brief_error",
          "type": "text"
        },
        {
          "table": "public.phone_call_units",
          "name": "brief_updated_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_call_units",
          "name": "dial_claimed_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_call_units",
          "name": "session_started_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_call_units",
          "name": "session_ended_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_call_units",
          "name": "end_reason",
          "type": "text"
        },
        {
          "table": "public.phone_call_units",
          "name": "transcript_segment_count",
          "type": "integer"
        },
        {
          "table": "public.phone_call_units",
          "name": "transcript_sha256",
          "type": "text"
        },
        {
          "table": "public.phone_call_units",
          "name": "wrap_up_status",
          "type": "text"
        },
        {
          "table": "public.phone_call_units",
          "name": "wrap_up_handle",
          "type": "jsonb"
        },
        {
          "table": "public.phone_call_units",
          "name": "wrap_up_error",
          "type": "text"
        },
        {
          "table": "public.phone_call_units",
          "name": "wrap_up_updated_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_call_units",
          "name": "outcome",
          "type": "jsonb"
        },
        {
          "table": "public.phone_call_units",
          "name": "created_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_call_units",
          "name": "updated_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_call_action_items",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_call_action_items",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_call_action_items",
          "name": "seq",
          "type": "integer"
        },
        {
          "table": "public.phone_call_action_items",
          "name": "text",
          "type": "text"
        },
        {
          "table": "public.phone_call_action_items",
          "name": "due_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_call_action_items",
          "name": "created_at",
          "type": "timestamp with time zone"
        }
      ]
    },
    {
      "producer": "app-migrations:registry:phone-app:/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app:git-blob:e606719b81b419990e0ce221db76e92902efe728:packages/data/src/migrations.ts",
      "tables": [
        "public.phone_calls",
        "public.phone_call_preparations",
        "public.phone_transcript_segments",
        "public.phone_voicemails",
        "public.phone_scheduled_calls",
        "public.phone_numbers",
        "public.phone_provider_events",
        "public.phone_usage_accounts",
        "public.phone_usage_reservations",
        "public.phone_usage_charge_events"
      ],
      "columns": [
        {
          "table": "public.phone_calls",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "conversation_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "parent_operator_conversation_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "direction",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "caller_label",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "disposition",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "started_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_calls",
          "name": "ended_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_calls",
          "name": "duration_sec",
          "type": "integer"
        },
        {
          "table": "public.phone_calls",
          "name": "summary",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "transcript_text",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "search_document",
          "type": "tsvector"
        },
        {
          "table": "public.phone_calls",
          "name": "updated_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "attempt_id",
          "type": "text"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "phase",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "seq",
          "type": "integer"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "speaker",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "text",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_voicemails",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "transcript",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "duration_sec",
          "type": "integer"
        },
        {
          "table": "public.phone_voicemails",
          "name": "caller_label",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "created_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_voicemails",
          "name": "read_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "title",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "guest_name",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "guest_email",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "scheduled_for",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "duration_min",
          "type": "integer"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "invite_token",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "created_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_numbers",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "e164",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "provider",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "provider_account_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "trunk_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "assistant_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "provider",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "provider_account_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "event_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "payload_identity",
          "type": "text"
        },
        {
          "table": "public.phone_usage_accounts",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_accounts",
          "name": "period_id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_accounts",
          "name": "state",
          "type": "jsonb"
        },
        {
          "table": "public.phone_usage_reservations",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_reservations",
          "name": "period_id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_reservations",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_reservations",
          "name": "state",
          "type": "jsonb"
        },
        {
          "table": "public.phone_usage_charge_events",
          "name": "event_key",
          "type": "text"
        },
        {
          "table": "public.phone_usage_charge_events",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_charge_events",
          "name": "period_id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_charge_events",
          "name": "reservation_id",
          "type": "text"
        },
        {
          "table": "public.phone_usage_charge_events",
          "name": "state",
          "type": "jsonb"
        }
      ]
    },
    {
      "producer": "app-migrations:registry:phone-app:/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app:git-blob:173584a70c57db7568f04ed8ba6b125a791eafd0:packages/data/src/migrations.ts",
      "tables": [
        "public.phone_calls",
        "public.phone_call_preparations",
        "public.phone_transcript_segments",
        "public.phone_voicemails",
        "public.phone_scheduled_calls",
        "public.phone_numbers",
        "public.phone_provider_events"
      ],
      "columns": [
        {
          "table": "public.phone_calls",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "conversation_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "parent_operator_conversation_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "direction",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "caller_label",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "disposition",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "started_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_calls",
          "name": "ended_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_calls",
          "name": "duration_sec",
          "type": "integer"
        },
        {
          "table": "public.phone_calls",
          "name": "summary",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "transcript_text",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "search_document",
          "type": "tsvector"
        },
        {
          "table": "public.phone_calls",
          "name": "updated_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "attempt_id",
          "type": "text"
        },
        {
          "table": "public.phone_call_preparations",
          "name": "phase",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "seq",
          "type": "integer"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "speaker",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "text",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_voicemails",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "transcript",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "duration_sec",
          "type": "integer"
        },
        {
          "table": "public.phone_voicemails",
          "name": "caller_label",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "created_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_voicemails",
          "name": "read_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "title",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "guest_name",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "guest_email",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "scheduled_for",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "duration_min",
          "type": "integer"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "invite_token",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "created_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_numbers",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "e164",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "provider",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "provider_account_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "trunk_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "assistant_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "provider",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "provider_account_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "event_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "payload_identity",
          "type": "text"
        }
      ]
    },
    {
      "producer": "app-migrations:registry:phone-app:/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app:git-blob:dc8cecb397697b505e2219e6e6a48cba008d1c7b:packages/data/src/migrations.ts",
      "tables": [
        "public.phone_calls",
        "public.phone_transcript_segments",
        "public.phone_voicemails",
        "public.phone_scheduled_calls",
        "public.phone_numbers",
        "public.phone_provider_events"
      ],
      "columns": [
        {
          "table": "public.phone_calls",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "conversation_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "parent_operator_conversation_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "direction",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "caller_label",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "disposition",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "started_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_calls",
          "name": "ended_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_calls",
          "name": "duration_sec",
          "type": "integer"
        },
        {
          "table": "public.phone_calls",
          "name": "summary",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "transcript_text",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "search_document",
          "type": "tsvector"
        },
        {
          "table": "public.phone_calls",
          "name": "updated_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "seq",
          "type": "integer"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "speaker",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "text",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_voicemails",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "transcript",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "duration_sec",
          "type": "integer"
        },
        {
          "table": "public.phone_voicemails",
          "name": "caller_label",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "created_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_voicemails",
          "name": "read_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "title",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "guest_name",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "guest_email",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "scheduled_for",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "duration_min",
          "type": "integer"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "invite_token",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "created_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_numbers",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "e164",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "provider",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "provider_account_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "trunk_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "assistant_id",
          "type": "text"
        },
        {
          "table": "public.phone_numbers",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "provider",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "provider_account_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "event_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_provider_events",
          "name": "payload_identity",
          "type": "text"
        }
      ]
    },
    {
      "producer": "app-migrations:registry:phone-app:/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app:git-blob:ca4bfced3acacd7e7758f4958adc9978415d66fd:packages/data/src/migrations.ts",
      "tables": [
        "public.phone_calls",
        "public.phone_transcript_segments",
        "public.phone_voicemails",
        "public.phone_scheduled_calls"
      ],
      "columns": [
        {
          "table": "public.phone_calls",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "conversation_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "parent_operator_conversation_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "direction",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "caller_label",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "disposition",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "started_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_calls",
          "name": "ended_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_calls",
          "name": "duration_sec",
          "type": "integer"
        },
        {
          "table": "public.phone_calls",
          "name": "summary",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "transcript_text",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "search_document",
          "type": "tsvector"
        },
        {
          "table": "public.phone_calls",
          "name": "updated_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "seq",
          "type": "integer"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "speaker",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "text",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_voicemails",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "transcript",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "duration_sec",
          "type": "integer"
        },
        {
          "table": "public.phone_voicemails",
          "name": "caller_label",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "created_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_voicemails",
          "name": "read_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "title",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "guest_name",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "guest_email",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "scheduled_for",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "duration_min",
          "type": "integer"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "invite_token",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "created_at",
          "type": "timestamp with time zone"
        }
      ]
    },
    {
      "producer": "app-migrations:registry:phone-app:/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app:git-blob:efadc1554c98a110e56a01211ebec3d2d438d592:packages/data/src/migrations.ts",
      "tables": [
        "public.phone_calls",
        "public.phone_transcript_segments",
        "public.phone_voicemails",
        "public.phone_scheduled_calls"
      ],
      "columns": [
        {
          "table": "public.phone_calls",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "conversation_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "direction",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "caller_label",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "disposition",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "started_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_calls",
          "name": "ended_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_calls",
          "name": "duration_sec",
          "type": "integer"
        },
        {
          "table": "public.phone_calls",
          "name": "summary",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "transcript_text",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "search_document",
          "type": "tsvector"
        },
        {
          "table": "public.phone_calls",
          "name": "updated_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "seq",
          "type": "integer"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "speaker",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "text",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_voicemails",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "transcript",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "duration_sec",
          "type": "integer"
        },
        {
          "table": "public.phone_voicemails",
          "name": "caller_label",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "created_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_voicemails",
          "name": "read_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "title",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "guest_name",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "guest_email",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "scheduled_for",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "duration_min",
          "type": "integer"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "invite_token",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "created_at",
          "type": "timestamp with time zone"
        }
      ]
    },
    {
      "producer": "app-migrations:registry:phone-app:/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app:git-blob:1014cd2530363730f1a269aa58a91ec01639c2ac:packages/data/src/migrations.ts",
      "tables": [
        "public.phone_calls",
        "public.phone_transcript_segments",
        "public.phone_voicemails",
        "public.phone_scheduled_calls"
      ],
      "columns": [
        {
          "table": "public.phone_calls",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "direction",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "caller_label",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "disposition",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "started_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_calls",
          "name": "ended_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_calls",
          "name": "duration_sec",
          "type": "integer"
        },
        {
          "table": "public.phone_calls",
          "name": "summary",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "transcript_text",
          "type": "text"
        },
        {
          "table": "public.phone_calls",
          "name": "search_document",
          "type": "tsvector"
        },
        {
          "table": "public.phone_calls",
          "name": "updated_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "seq",
          "type": "integer"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "speaker",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "text",
          "type": "text"
        },
        {
          "table": "public.phone_transcript_segments",
          "name": "at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_voicemails",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "transcript",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "duration_sec",
          "type": "integer"
        },
        {
          "table": "public.phone_voicemails",
          "name": "caller_label",
          "type": "text"
        },
        {
          "table": "public.phone_voicemails",
          "name": "created_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_voicemails",
          "name": "read_at",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "owner_id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "title",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "guest_name",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "guest_email",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "scheduled_for",
          "type": "timestamp with time zone"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "duration_min",
          "type": "integer"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "room_name",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "invite_token",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "status",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "call_id",
          "type": "text"
        },
        {
          "table": "public.phone_scheduled_calls",
          "name": "created_at",
          "type": "timestamp with time zone"
        }
      ]
    }
  ],
  "matches": [
    {
      "entry": {
        "kind": "database",
        "root": "postgres-cluster:7635091775813704249",
        "name": "phone_app_test"
      },
      "matched": [
        {
          "kind": "database",
          "root": "postgres-cluster:7635091775813704249",
          "name": "phone_app_test",
          "classification": "state",
          "producer": "app-migrations:registry:phone-app:/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app:git-blob:1014cd2530363730f1a269aa58a91ec01639c2ac:packages/data/src/migrations.ts"
        }
      ]
    },
    {
      "entry": {
        "kind": "database",
        "root": "postgres-cluster:7635091775813704249",
        "name": "phone_app_test2"
      },
      "matched": [
        {
          "kind": "database",
          "root": "postgres-cluster:7635091775813704249",
          "name": "phone_app_test2",
          "classification": "state",
          "producer": "app-migrations:registry:phone-app:/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app:git-blob:1014cd2530363730f1a269aa58a91ec01639c2ac:packages/data/src/migrations.ts"
        }
      ]
    }
  ]
}
