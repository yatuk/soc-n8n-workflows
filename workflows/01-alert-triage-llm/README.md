# 01 — Alert Triage with LLM Verdict

## What it does

Receives a SIEM alert (Splunk alert-action or Elastic/Kibana alert payload) over a webhook, normalizes it into a vendor-agnostic schema, and asks an LLM — prompted as a Tier-2 SOC analyst — for a structured verdict: `true_positive`, `false_positive`, or `benign_true_positive`, with confidence, rationale, suggested MITRE ATT&CK techniques, and recommended Tier-1 actions. The verdict routes to different Slack messages; anything the model can't answer cleanly falls through to a human-review channel. Informational-severity alerts are archived *before* the LLM call to save tokens.

Key safety property: **the LLM output is validated by a Code node and a failed parse routes to `needs_review` — never to a default verdict.**

## Trigger

`POST /webhook/siem-alert` — point a Splunk webhook alert action or an Elastic watcher/connector at it. The webhook requires a shared-secret header (header-auth credential) and **responds 202 immediately** after normalization — LLM triage runs async so the SIEM's delivery timeout never fires and never causes duplicate redeliveries. Redelivered events are additionally deduplicated on `alert_id` (static-data window of 500).

## Node flow

1. **SIEM Alert Webhook** (header auth) — receives the raw alert.
2. **Normalize Alert** (Code) — detects Splunk vs. ECS shape, emits `{alert_id, source, rule_name, severity, entity{host,user,src_ip,dest_ip,process}, description, raw}`; dedups redeliveries on `alert_id`.
3. **Respond 202 Accepted** — acks the sender before any slow work (`{alert_id, status, duplicate}`).
4. **Severity Gate** (IF) — drops `informational` and duplicates to an archive path.
5. **LLM Triage** (OpenAI `gpt-4o-mini`, `temperature 0.1`, JSON output, `maxTokens 1024`, 60 s timeout, 2 retries, **fail-safe**: an LLM outage routes to analyst review instead of failing the run) — Tier-2 analyst prompt. The model receives a minimal `prompt_payload` (selected fields, 500-char caps, no raw passthrough) inside `<alert>` tags with the closing tag escaped in data — prompt-injection surface is minimized, and internal data sent to the provider is too.
6. **Parse & Validate Verdict** (Code) — schema-checks the model output; invalid or failed call → `needs_review`. LLM prose is stripped of Slack-active characters (`<>@`) so injected output can't smuggle mentions or links into the card.
7. **Route by Verdict** (Switch) — TP / FP+Benign / fallback.
8. **Slack** — three differently formatted messages (`#soc-alerts` for TP and FP-digest, `#soc-escalations` for review); retry-on-fail, and a notification failure doesn't kill the run.
9. **Audit Log** (Code) — appends a structured record (verdict, channel, timestamps) to bounded static data; production would insert into an audit table.

## Test it

```bash
# Splunk-style payload
curl -X POST "http://localhost:5678/webhook/siem-alert" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: REPLACE_ME" \
  -d '{
    "search_name": "ESCU - Windows Encoded PowerShell Command",
    "sid": "scheduler__admin__search__RMD5a1b2c3",
    "result": {
      "event_id": "evt-2026-000481",
      "_time": "2026-07-03T08:14:22Z",
      "severity": "high",
      "host": "WKS-FIN-042",
      "user": "j.smith",
      "src_ip": "10.20.14.55",
      "dest_ip": "185.220.101.34",
      "process": "powershell.exe -nop -w hidden -enc SQBFAFgAKABOAGUAdw...",
      "signature": "Encoded PowerShell launched by Office child process"
    }
  }'
```

```bash
# Elastic/Kibana-style payload
curl -X POST "http://localhost:5678/webhook/siem-alert" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: REPLACE_ME" \
  -d '{
    "kibana.alert.uuid": "d9c1e2f0-77aa-4a1b-9d10-52f011aa9f01",
    "kibana.alert.rule.name": "Multiple Failed Logins Followed by Success",
    "kibana.alert.severity": "medium",
    "kibana.alert.reason": "12 failed logins then success for user svc-backup from 91.240.118.7",
    "@timestamp": "2026-07-03T06:02:11Z",
    "host": {"name": "srv-ad-01"},
    "user": {"name": "svc-backup"},
    "source": {"ip": "91.240.118.7"}
  }'
```

Expected response (immediate): `{"alert_id":"evt-2026-000481","status":"accepted","duplicate":false}` — the verdict lands in Slack once the LLM finishes. Re-send the same payload and `duplicate:true` comes back with no second Slack card.

## MITRE ATT&CK

The LLM is asked to map techniques per alert. The two test payloads above typically map to:

- **T1059.001** — Command and Scripting Interpreter: PowerShell
- **T1027** — Obfuscated Files or Information (encoded command)
- **T1110** — Brute Force (second payload)
- **T1078** — Valid Accounts (successful login after spraying)

## What to change for a real environment

- **Credentials**: create `Webhook Shared Secret - PLACEHOLDER` (header auth, e.g. `X-Webhook-Token`), `OpenAI API - PLACEHOLDER` and `Slack API - PLACEHOLDER`; channel names are hardcoded (`#soc-alerts`, `#soc-escalations`).
- **Dedup store**: redelivery dedup uses `workflowStaticData` (bounded, single-instance); move to Redis for multi-instance n8n, and consider a second dedup key on `rule_name + entity` to stop noisy rules burning tokens.
- **Error workflow**: link `00 - Global Error Handler` in this workflow's settings so failures page `#soc-automation-health`.
- **Audit log**: replace the static-data audit node with an insert into a real audit table (Postgres node) — static data is not an audit trail.
- **Verdict feedback loop**: log verdicts + eventual analyst disposition somewhere queryable so you can measure LLM/analyst agreement before trusting the FP path for auto-closing.
- **Model choice**: first-pass triage runs on `gpt-4o-mini`; escalate low-confidence verdicts to a stronger model or to the agentic workflow 11.
- **Replay protection**: the shared-secret header stops casual abuse but is not HMAC — if your SIEM can sign payloads, verify the signature (+ timestamp window) in the Normalize node.
