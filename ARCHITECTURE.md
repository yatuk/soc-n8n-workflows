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
4. **No retry/DLQ strategy shown.** Production would enable n8n's error workflows + queue mode; here each workflow keeps `onError: continueRegularOutput` on enrichment calls so a TI API outage degrades gracefully instead of dropping alerts.
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

## What I would build next

- Replace `workflowStaticData` with Redis for dedup/baselines.
- An error-handler workflow (n8n's global error trigger) posting failed executions to a `#soc-automation-health` channel — automation you can't observe is automation you can't trust.
- A TheHive integration to give the stack a real case-management spine.
- Eval harness for the LLM triage prompts: replay 100 labeled historical alerts, measure verdict agreement vs. senior analysts before trusting the FP-suppression path.
