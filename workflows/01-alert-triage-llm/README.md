# 01 — Alert Triage with LLM Verdict

## What it does

Receives a SIEM alert (Splunk alert-action or Elastic/Kibana alert payload) over a webhook, normalizes it into a vendor-agnostic schema, and asks an LLM — prompted as a Tier-2 SOC analyst — for a structured verdict: `true_positive`, `false_positive`, or `benign_true_positive`, with confidence, rationale, suggested MITRE ATT&CK techniques, and recommended Tier-1 actions. The verdict routes to different Slack messages; anything the model can't answer cleanly falls through to a human-review channel. Informational-severity alerts are archived *before* the LLM call to save tokens.

Key safety property: **the LLM output is validated by a Code node and a failed parse routes to `needs_review` — never to a default verdict.**

## Trigger

`POST /webhook/siem-alert` — point a Splunk webhook alert action or an Elastic watcher/connector at it.

## Node flow

1. **SIEM Alert Webhook** — receives the raw alert.
2. **Normalize Alert** (Code) — detects Splunk vs. ECS shape, emits `{alert_id, source, rule_name, severity, entity{host,user,src_ip,dest_ip,process}, description, raw}`.
3. **Severity Gate** (IF) — drops `informational` to an archive path.
4. **LLM Triage** (OpenAI, `temperature 0.1`, JSON output) — Tier-2 analyst prompt; alert content is wrapped in `<alert>` tags and declared as data to resist prompt injection.
5. **Parse & Validate Verdict** (Code) — schema-checks the model output; invalid → `needs_review`.
6. **Route by Verdict** (Switch) — TP / FP+Benign / fallback.
7. **Slack** — three differently formatted messages (`#soc-alerts` for TP and FP-digest, `#soc-escalations` for review).
8. **Respond to SIEM** — returns `{alert_id, verdict, confidence, mitre_techniques}` so the caller can log the outcome.

## Test it

```bash
# Splunk-style payload
curl -X POST "http://localhost:5678/webhook/siem-alert" \
  -H "Content-Type: application/json" \
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

Expected response: `{"alert_id":"evt-2026-000481","verdict":"true_positive","confidence":85,...}` (verdict varies with the model).

## MITRE ATT&CK

The LLM is asked to map techniques per alert. The two test payloads above typically map to:

- **T1059.001** — Command and Scripting Interpreter: PowerShell
- **T1027** — Obfuscated Files or Information (encoded command)
- **T1110** — Brute Force (second payload)
- **T1078** — Valid Accounts (successful login after spraying)

## What to change for a real environment

- **Webhook auth**: add a header-auth credential on the Webhook node (shared secret from Splunk/Elastic) — the demo accepts unauthenticated posts.
- **Credentials**: replace `OpenAI API - PLACEHOLDER` and `Slack API - PLACEHOLDER` with real credentials; channel names are hardcoded (`#soc-alerts`, `#soc-escalations`).
- **Dedup**: put a dedup gate (Redis or n8n static data keyed on `rule_name + entity`) before the LLM node, or a noisy rule will burn tokens.
- **Verdict feedback loop**: log verdicts + eventual analyst disposition somewhere queryable so you can measure LLM/analyst agreement before trusting the FP path for auto-closing.
- **Model choice**: `gpt-4o` is a placeholder; any JSON-mode-capable model works. Consider a cheaper model for the first pass and escalating to a stronger one on low confidence.
