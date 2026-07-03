# 01 — Alert Triage with LLM Verdict — Flow

```mermaid
flowchart LR
    A[/"Webhook<br/>POST /siem-alert"/] --> B["Normalize Alert<br/>(Splunk | Elastic → internal schema)"]
    B --> C{"Severity Gate<br/>severity ≥ low?"}
    C -- "informational" --> H["Archive: Below Severity Floor<br/>(no LLM call)"]
    C -- "yes" --> D["LLM Triage<br/>Tier-2 analyst prompt, JSON out"]
    D --> E["Parse & Validate Verdict<br/>(schema check, fail → needs_review)"]
    E --> F{"Route by Verdict"}
    F -- "true_positive" --> G1["Slack: Escalate TP<br/>#soc-alerts"]
    F -- "false_positive / benign" --> G2["Slack: FP/Benign Digest<br/>#soc-alerts"]
    F -- "fallback (needs_review)" --> G3["Slack: Needs Analyst Review<br/>#soc-escalations"]
    G1 --> R[/"Respond to SIEM<br/>{alert_id, verdict, confidence}"/]
    G2 --> R
    G3 --> R
    H --> R
```
