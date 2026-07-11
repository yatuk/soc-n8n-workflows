# Architecture & Design Decisions

## Why n8n for SOC automation?

n8n is not a SOAR platform. It is a general-purpose workflow engine that happens to be very good at the 80% of SOC automation that is *glue*: receive an event, normalize it, enrich it, decide, notify, act. For a small team (or a portfolio), that trade-off is attractive:

- **Self-hostable and source-available** — no per-analyst licensing, runs in Docker next to the SIEM.
- **HTTP-native** — most SOC integrations are "call this REST API with this key", which n8n's HTTP Request node covers without waiting for a vendor content pack.
- **Code escape hatch** — the Code node (JavaScript) handles the normalization/scoring logic that visual nodes can't express cleanly.
- **First-class LLM nodes** — verdict-suggestion and summarization patterns plug in without custom services.
- **Readable playbooks** — a hiring manager or a new analyst can open the canvas and follow the logic; that legibility is itself an operational feature.

## Honest comparison: n8n vs. Cortex XSOAR (and SOAR platforms generally)

| Capability | n8n | Cortex XSOAR / mature SOAR |
|---|---|---|
| Playbook engine | ✅ Visual + code nodes | ✅ Visual + Python automations |
| Case / incident management | ❌ None — you must pair with Jira/TheHive | ✅ Native incidents, evidence, SLA timers |
| Alert deduplication & correlation | ❌ Manual (Code node + static data), fragile at scale | ✅ Built-in dedup, correlation rules, link analysis |
| Threat intel management (TIM) | ❌ You call TI APIs per-alert | ✅ Native indicator DB with scoring, expiration, feeds |
| Marketplace integrations | ~1,100 generic nodes, few security-specific | 1,000+ security-focused content packs |
| War room / analyst collaboration | ❌ (Slack threads at best) | ✅ Native |
| RBAC & audit for SecOps | Basic (n8n Enterprise improves this) | ✅ Granular, compliance-oriented |
| Cost | Free self-hosted / cheap cloud | Significant per-seat licensing |
| Time to first working playbook | Hours | Days–weeks (but scales further) |
| Custom logic | JavaScript/Python in-node | Python automations |
| Horizontal scaling | Queue mode + workers | Enterprise-grade |

**The honest conclusion:** these workflows demonstrate SOAR *patterns* (triage, enrichment, human-approved containment) on n8n, and this stack genuinely works for a small SOC or an MSSP's lightweight tier. A 24/7 enterprise SOC with thousands of alerts/day needs real case management, correlation, and TIM — n8n alone does not replace XSOAR, Swimlane, or Tines at that scale. n8n is best positioned as (a) the automation layer *around* a ticketing system that acts as the case store, or (b) a prototyping ground for playbooks later ported to a SOAR.

## Known limitations of this implementation

Stated plainly, because a reviewer will notice anyway:

1. **No persistent state store.** Dedup and baselines use `workflowStaticData` or inline mock data. Real deployments need Redis/Postgres for cross-execution state (e.g. "have we seen this breach before", user behavior baselines in workflow 10).
2. **Mock endpoints.** Containment calls (EDR isolate, Okta suspend), the cloud inventory API, and the SOC metrics store point at `*.example.com`. The request *shapes* mirror the real APIs (CrowdStrike RTR-style device action, Okta lifecycle API) so swapping the base URL + credential is the main change.
3. **LLM verdicts are advisory.** Model outputs are parsed defensively (JSON extraction with fallbacks) and never gate a destructive action without a human click (workflow 04). Prompt-injection via alert content is a real risk — alert fields are delimited and the system prompt instructs the model to treat them as data, but this mitigates rather than eliminates the risk.
4. **Partial retry/DLQ strategy.** After a production-hardening pass (see below), notification/ticket nodes retry with backoff and enrichment calls degrade gracefully, and workflow 00 provides a global error workflow — but there is still no dead-letter queue: an event that fails after retries is alerted on, not replayed. Queue mode + a persistent DLQ is the real fix.
5. **Detection logic is illustrative.** Thresholds (failed-login counts, risk score weights) are sane defaults, not tuned to any environment. Treat them as starting points for your own baselining.
6. **Single-tenant assumptions.** No RBAC separation between playbooks; an MSSP would need per-tenant credential scoping.

## Cross-cutting design decisions

### 1. Normalize-first pipelines
Every ingest workflow's first real node is a Code node producing a stable internal schema (`alert_id`, `source`, `severity`, `entity`, `raw`). Splunk's `result`-wrapped events and Elastic's ECS documents both collapse into it. Downstream nodes never touch vendor fields.

### 2. Deterministic gates before LLM calls
LLM calls cost money and add latency. IF/Switch nodes filter obvious noise (severity floors, allowlisted entities, dedup) *before* the model sees anything. The LLM is asked for structured JSON (`verdict`, `confidence`, `rationale`, `mitre_techniques`) and a Code node validates the parse — malformed model output routes to a "needs human review" path, never to a default-allow.

### 3. Human-in-the-loop for anything destructive
Workflow 04 implements approval via a Slack message containing signed `$execution.resumeUrl` links and an n8n Wait node (resume-on-webhook). Timeout = auto-no-action. This is the pattern I would defend in a design review: automation proposes, a named human approves, and the approval is auditable in both Slack and the n8n execution log.

### 4. Placeholder credentials, real API shapes
Nodes reference credentials by name (`VirusTotal API - PLACEHOLDER`) so the JSON imports cleanly with zero secrets. Request/response handling matches the real APIs (VT v3 `data.attributes.last_analysis_stats`, AbuseIPDB `abuseConfidenceScore`, HIBP `breachedaccount`, NVD 2.0 CVE schema) so the enrichment parsing code is genuinely reusable.

### 5. MITRE ATT&CK as the shared vocabulary
Where a workflow detects or triages, its README maps to ATT&CK techniques (e.g. T1110 Brute Force, T1566 Phishing, T1078 Valid Accounts) and the LLM prompts ask for technique suggestions — keeping analyst-facing output in the vocabulary the rest of the SOC already uses.

## Production-hardening pass

The workflows were run through a static workflow analyzer (kipn.ai) and hardened against every finding class it raised. The controls, applied consistently:

| Finding class | Control applied |
|---|---|
| AI call blocks webhook response (sender timeout → retry → duplicate processing) | Webhooks **respond 202 immediately** after normalization; LLM/API work continues async (01, 02, 10, 11). 03 stays synchronous by documented design (analyst tool, no delivery retries). 04 already used `onReceived`. |
| Webhook replays create duplicates | Static-data dedup on stable IDs (`alert_id`, `report_id`), bounded to the last 500 |
| Unauthenticated webhooks | Header-auth credential (`Webhook Shared Secret - PLACEHOLDER`) on every webhook trigger |
| Unbounded LLM cost | `maxTokens` cap, 30–90 s timeout, and `maxRetries` on every LLM call; deterministic gates (severity floor, dedup, relevance filters) run *before* the model |
| Missing timeouts / retries | All HTTP nodes carry timeouts; Slack/Jira/Email nodes retry with backoff, then `continueRegularOutput` so a notification outage can't kill a triage run (failures are flagged in the message content) |
| Silent failures | Workflow **00 - Global Error Handler** (error trigger → context extraction → failure-tolerant LLM hint → `#soc-automation-health`); link it in each workflow's settings |
| No audit trail on side effects | Audit Log code nodes append structured records (bounded static data; production: audit table) after every notification/ticket action |
| Fragile expressions | Optional chaining + `??` fallbacks on every expression that touches nested or LLM-derived fields |

A second, deeper audit pass (prompt-injection & fail-safe focused) added:

| Finding class | Control applied |
|---|---|
| LLM outage silently drops alerts (fail-open) | Every LLM node carries `onError: continueRegularOutput` + `alwaysOutputData`; parse nodes treat missing output as invalid → `needs_review`/`escalate` — a provider outage becomes "escalate to human", never a lost true positive. Double retry layers (node-level × client-level) collapsed to one. |
| Raw payload passthrough to the LLM | 01 sends a minimal `prompt_payload` (selected fields, 500-char caps, no `raw`) — smaller injection surface, less PII to the provider, fewer tokens |
| Delimiter escape | All prompts neutralize their closing tag (`</alert>` → `[/alert]` etc.) inside untrusted data |
| LLM output injection into Slack/Jira/HTML | All LLM prose is sanitized before rendering (`[<>@]` stripped + length caps for Slack mrkdwn; full HTML-escape in the report builder; TI bulletin links allow-listed to URLs actually present in the source feeds) |
| Garbage-in → billable LLM call | Webhook payloads are schema-validated (01: at least one identifying field; 02: subject/body/from); invalid input gets `rejected_invalid_payload` in the 202 body and never reaches the model |
| Random fallback ids defeat dedup | Id-less payloads get a deterministic content hash as their dedup key |
| Audit log could claim delivery that failed | Audit records now carry `delivery_ok`/`delivery_error` from the actual node result; archived/duplicate alerts are audited too |
| Execution data retention | All workflows ship with `saveDataSuccessExecution: none` (errors + manual runs still saved) so full alert payloads don't accumulate in the n8n DB |
| Cost tiering | First-pass triage (01) runs on `gpt-4o-mini`; the stronger model is reserved for the investigation-grade flows (04, 10, 11) |

Accepted residual risks, stated honestly: no HMAC/timestamp replay protection on webhooks (static shared secret only — the mock SIEM has no signing to verify), rate limiting and concurrency are n8n-instance/reverse-proxy concerns not expressible in workflow JSON, and `workflowStaticData` remains the (single-instance) store for dedup/audit.

## The agentic layer (workflow 11)

Workflow 11 moves from "LLM as advisor" to "LLM as investigator": an AI Agent node with a ReAct loop chooses its own enrichment calls. The guardrails are the design: **read-only tools only** (no containment in the toolset — authority ends at the verdict), `maxIterations: 6` with a prompt-level tool budget, structured output parsing with a fail-to-review path, and `returnIntermediateSteps` so every tool call is auditable after the fact. Cost-wise it belongs *behind* the cheap single-shot triage (01), handling only the alerts that need real investigation.

## What I would build next

- Replace `workflowStaticData` with Redis for dedup/baselines/audit (single-instance static data resets on re-import and doesn't scale to queue mode).
- A TheHive integration to give the stack a real case-management spine.
- Eval harness for the LLM triage prompts and the agent: replay 100 labeled historical alerts, measure verdict agreement vs. senior analysts before trusting the FP-suppression path.
- Multi-agent tiering (cheap triage model → strong investigator → critic/reviewer) with a cost model per 1,000 alerts.
