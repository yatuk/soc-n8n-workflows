# 10 — Insider Threat / Anomalous Access Detection

## What it does

Scores batches of user access logs against per-user baselines, looking specifically for the **combination** of anomalies that characterizes insider risk — any single signal is usually noise:

| Signal | Weight |
|---|---|
| Activity outside the user's usual hours / weekends | +20 |
| Access from a country not in the user's baseline | +30 |
| Sensitive resource outside the user's role scope | +35 |
| Bulk transfer (> 500 MB in window) | +15 |
| **Combination bonus**: ≥ 3 independent signal families | +10 |

Routing is band-based, and deliberately different from the other workflows:

- **High (≥ 70)** → escalates *directly* — no LLM gate. When off-hours + new country + sensitive data line up, you don't want a model talking you out of it.
- **Medium (40–69)** → LLM plausibility check against the user's role ("engineer pulling source at night before a release" vs. "HR pulling customer PII from a new country"). `escalate` joins the high path; `watchlist` gets a lightweight Slack note. Malformed LLM output **defaults to escalate** — conservative in this domain.
- **Low (< 40)** → logged, no action.

Escalations open a **confidential Jira case** (labeled, with explicit need-to-know handling instructions and a "verify before confronting anyone" checklist) and ping `#soc-escalations`. Service accounts are exempt from hour-based scoring; users with no baseline are scored with defaults and flagged as such.

## Trigger

`POST /webhook/access-logs` — a DLP tool, CASB, or SIEM saved-search forwarder would post these.

## Test it

```bash
curl -X POST "http://localhost:5678/webhook/access-logs" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {"user": "a.yilmaz", "timestamp": "2026-07-04T02:15:00Z", "geo_country": "RO", "resource": "customer-pii-export", "action": "download", "bytes_transferred": 734003200},
      {"user": "a.yilmaz", "timestamp": "2026-07-04T02:30:00Z", "geo_country": "RO", "resource": "hr-payroll-db", "action": "query", "bytes_transferred": 1048576},
      {"user": "c.demir", "timestamp": "2026-07-03T22:40:00Z", "geo_country": "DE", "resource": "source-code-repo", "action": "clone", "bytes_transferred": 209715200},
      {"user": "j.smith", "timestamp": "2026-07-03T10:00:00Z", "geo_country": "TR", "resource": "finance-reports", "action": "view", "bytes_transferred": 2048}
    ]
  }'
```

Expected: `a.yilmaz` (HR, off-hours + Romania + PII export + bulk = risk ~100) escalates directly; `c.demir` (engineer, in-baseline country, in-role repo, late but within usual hours) scores low or lands in the LLM band and is deemed plausible; `j.smith` produces no anomaly at all.

## Node flow

Webhook → Score Access Anomalies (Code: baselines, weights, combination bonus, one item per risky user) → Switch by risk band → high: direct / medium: LLM plausibility → escalate-or-watchlist → Merge escalations → Jira confidential case → Slack escalation. Watchlist and low-risk paths get lighter handling. Webhook response summarizes all scored users.

## MITRE ATT&CK

- **T1078** — Valid Accounts (the access is authenticated — that's the point)
- **T1530** — Data from Cloud Storage
- **T1048 / T1567** — Exfiltration over alternative/web protocols (the bulk-transfer signal)

## What to change for a real environment

- **Baselines**: the inline `BASELINES` map must become computed state — a nightly job aggregating 30–90 days of history per user into a store the Code node reads. This is the difference between a demo and UEBA; be honest that real UEBA products model far more dimensions.
- **Timezone handling**: scoring uses UTC hours; map users to their home timezone or "off-hours" is wrong for half your workforce.
- **Privacy & process**: insider-risk automation touches employment law. Ticket visibility restrictions here are cosmetic — enforce them with real Jira security schemes, involve HR/legal in the SOP, and log who viewed what.
- **Watchlist**: the "14 days" in the Slack message is aspirational — implement it (static data or Redis set that lowers the escalation threshold for listed users).
- **Volume**: webhook-per-batch works for periodic SIEM forwards; for streaming volumes, aggregate upstream and send only pre-filtered candidates.
