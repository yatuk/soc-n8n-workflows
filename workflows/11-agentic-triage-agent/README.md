# 11 — Agentic Triage Agent (ReAct, read-only tools)

## What it does

The agentic evolution of workflow 01. Instead of a single-shot LLM call, an **n8n AI Agent** (ReAct loop) investigates the alert itself — deciding which tools to call, in what order, and when it has enough evidence:

| Tool | Type | What the agent gets |
|---|---|---|
| `virustotal_ip` | HTTP Request Tool | Engine detections for an IP |
| `abuseipdb` | HTTP Request Tool | Abuse confidence score, report count |
| `user_context` | Code Tool (mock IdP) | Role, MFA, usual countries, service-account flag |
| `host_context` | Code Tool (mock EDR) | Owner, criticality, sensor health, recent detections |
| `similar_past_alerts` | Code Tool (mock archive) | Past cases for the same rule/entity + final dispositions |
| `ioc_enrichment_pipeline` | Sub-workflow tool — **disabled** | Bulk enrichment via workflow 03 |

### The guardrails are the point

- **Read-only toolset.** The agent has no containment tools *by design* — its authority ends at the verdict. (Contrast with workflow 04, where actions exist but sit behind a human approval gate.)
- **Bounded loop.** `maxIterations: 6` plus a prompt-level tool-call budget; a confused agent terminates instead of spinning up cost.
- **Structured output enforced.** Output parser + a Code-node schema check; malformed output routes to `needs_review`, never to a default verdict.
- **Auditable reasoning.** `returnIntermediateSteps` captures every tool call; the Slack card and the 202-response include the full tool trail, so an analyst can replay *why* the agent decided what it decided.
- **Prompt-injection aware.** Alert content is delimited as untrusted data; the system message forbids following instructions found inside it.

## Trigger

`POST /webhook/agentic-triage` (header-auth protected). Responds **202 immediately** — agent investigation (10–60 s) runs async, results land in Slack.

## Test it

```bash
curl -X POST "http://localhost:5678/webhook/agentic-triage" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: REPLACE_ME" \
  -d '{
    "search_name": "Multiple Failed Logins Followed by Success",
    "result": {
      "event_id": "evt-2026-000512",
      "severity": "high",
      "host": "srv-ad-01",
      "user": "svc-backup",
      "src_ip": "91.240.118.7",
      "signature": "12 failed logins then success for svc-backup"
    }
  }'
```

Watch the execution in n8n: the agent should look up the IP (VT/AbuseIPDB), pull `svc-backup`'s directory record (service account, no MFA), check `srv-ad-01` (crown-jewel DC), and find case SOC-2198 in the archive (same account previously judged benign after a password rotation) — then weigh actively-flagged IP vs. benign precedent. That tension is exactly what makes a good demo.

## Node flow

Webhook (auth) → Normalize → **Respond 202** → AI Agent (chat model + 6 tools + structured parser) → Validate Agent Verdict (Code, extracts tool trail) → Slack verdict card with evidence chain.

## Enabling the sub-workflow tool

The disabled `ioc_enrichment_pipeline` tool calls workflow 03. To enable: add an **Execute Workflow Trigger** node to workflow 03 (wired into `Classify IOCs`), then select workflow 03 in this tool's picker and enable the node.

## What to change for a real environment

- **Real tool backends**: swap the three Code tools for Okta/Entra, CrowdStrike, and TheHive/Jira search calls — descriptions and schemas stay the same, which is the point of the tool abstraction.
- **Cost control**: gpt-4o with up to 6 tool calls costs real money per alert. Front this with workflow 01's cheap single-shot triage and only send `needs_review`/low-confidence alerts here (see workflow 12 for that tiering pattern).
- **Evals before trust**: replay labeled historical alerts and measure agent/analyst agreement before letting the verdicts drive anything. Log `tool_trail` for every run.
- **Timeouts**: set a workflow-level execution timeout (Settings) as the hard stop above `maxIterations`.
