# 09 — SOC Weekly Report Generator

## What it does

Every Monday morning, turns raw SOC metrics into a polished HTML report with **two sections written for two different audiences from the same numbers**:

- **Executive summary** (LLM #1): CISO-facing — trend, risk, resourcing implications, no jargon.
- **Analyst/operations detail** (LLM #2): detection-engineering-facing — which rules to tune (with expected impact), where time is lost, what the automation stats imply.

Two separate LLM calls with different system prompts run **in parallel** and are synchronized by a Merge node. The division of labor is strict: **all arithmetic happens in the `Compute KPIs` Code node** (TP/FP rates, MTTR week-over-week delta, auto-triage coverage, worst FP rule share); the LLMs receive finished numbers and are instructed to use them verbatim. The KPI tiles and tables in the HTML are rendered from the data, so even a hallucinating model can't corrupt the numbers a CISO sees.

Output: HTML email to CISO + team, and the same report saved to `/data/reports/soc-weekly-<date>.html`.

Metrics come from a mock internal API with an embedded fallback week (1,284 alerts, 87% LLM/analyst agreement, an "Impossible Travel" rule generating 30% of all FPs — realistic numbers that give the LLMs something meaty to write about).

## Trigger

Schedule — weekly, Monday 08:00. For a daily variant, duplicate the workflow, switch the schedule, and shorten the metrics window to 1 day.

## Test it

Execute manually (needs only the OpenAI and SMTP placeholders — or replace the Email node with a Slack node to test without SMTP). Check `/data/reports/` for the saved HTML and open it in a browser: KPI tiles, severity/category tables, tuning-recommendation table.

## Node flow

Schedule → Fetch SOC Metrics (HTTP, mock API) → Load Metrics w/ fallback (Code) → Compute KPIs (Code — the only place numbers are calculated) → [LLM Executive ∥ LLM Analyst] → Merge (combine by position) → Build HTML Report (Code) → Email ∥ Convert to File → Save to Disk.

## What to change for a real environment

- **Metrics source**: point at your real store — a SIEM summary index (Splunk `| tstats` saved search via REST), Elastic aggregations, or the ticket system's API. The interesting engineering problem is *upstream*: consistently recording dispositions and timestamps so MTTR is even computable. Workflow 01's response payload is designed to feed such a store.
- **PDF output**: n8n has no native HTML→PDF node; call Gotenberg (self-hosted, one HTTP node: `POST /forms/chromium/convert/html`) or a headless-Chrome microservice, then attach the PDF to the email instead.
- **Number-checking**: for extra safety add a Code node that greps the LLM prose for digit sequences and verifies each appears in the KPI set — flagging (not blocking) mismatches.
- **Distribution**: leadership reports often belong in a wiki; add a Confluence `PUT /content` node alongside the email.
