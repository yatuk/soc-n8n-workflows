# 00 — Global Error Handler

## What it does

The meta-workflow that makes every other workflow's failures **visible**: automation you can't observe is automation you can't trust. When any workflow that has this set as its *Error Workflow* fails, n8n triggers this flow with the failure context. It:

1. Extracts a stable failure record (workflow, node, error message, execution URL, retry lineage).
2. Asks a **cheap** LLM (gpt-4o-mini, 256-token cap) for a one-line root-cause hypothesis and first debugging step — with `onError: continue`, because **the error handler must never depend on the LLM working**. If the hint fails, the alert still goes out.
3. Posts to `#soc-automation-health` with retry (3 tries, 5 s apart).

## Setup (important)

Importing this workflow is not enough — n8n error workflows are opt-in per workflow:

1. Import `workflow.json` and activate it.
2. In **each** of the other workflows: **Settings (⚙) → Error Workflow → "00 - Global Error Handler"**.
3. Create a `#soc-automation-health` Slack channel (separate from `#soc-alerts` — infrastructure noise must not drown out security signal).

## Test it

Temporarily break any node in another workflow (e.g. change a URL to an invalid host and disable its `onError` setting), execute it, and watch the health channel.

## What to change for a real environment

- **Paging**: for workflows on the response path (04), add a PagerDuty Events API call next to the Slack node — a broken containment workflow is an incident, not a chat message.
- **Dedup/throttle**: a webhook workflow failing on every delivery will flood the channel; add a static-data rate limit (e.g. max 1 alert per workflow per 10 min, with a counter of suppressed occurrences).
- **Metrics**: also increment a failure counter somewhere queryable (Prometheus pushgateway, a DB table) so workflow 09 can report automation reliability alongside SOC KPIs.
