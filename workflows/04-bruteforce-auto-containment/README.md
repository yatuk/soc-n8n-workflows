# 04 — Brute-Force → Auto-Containment (Human-in-the-Loop)

## What it does

The flagship response playbook. Ingests a batch of Okta System Log-style authentication events, detects two attack patterns deterministically, enriches, asks an LLM whether it looks like a real attack, and — only for high-confidence attacks — asks a **human** for containment approval before touching anything:

- **Brute force**: ≥ 10 failures against one account from one IP.
- **Password spray**: ≥ 5 distinct accounts targeted from one IP.
- **Severity bump to critical** if a *success* from the same IP follows the failures (possible compromise, maps to T1078).

The approval gate is the point of this workflow:

1. Slack message to `#soc-escalations` with the evidence and two links built from n8n's `$execution.resumeUrl`.
2. A **Wait node** (resume-on-webhook) parks the execution for up to 30 minutes.
3. Clicking *APPROVE* resumes with `?action=approve`; anything else — deny link, timeout, malformed query — evaluates to **deny**. Containment is fail-safe: it only fires on an explicit approve.
4. On approval: mock CrowdStrike device-containment call + mock Okta `lifecycle/suspend` call, then a confirmation message with next steps.

The webhook responds immediately (`onReceived`), so the event source is never blocked by a pending approval.

## Trigger

`POST /webhook/okta-auth-events` — shape matches Okta System Log entries (an event-hook receiver or a SIEM forwarder would post these).

## Test it

```bash
python - <<'EOF' > /tmp/bf-events.json
import json
events = [{"eventType": "user.authentication.auth_via_mfa", "outcome": {"result": "FAILURE"},
           "actor": {"alternateId": "c.demir@example.com"},
           "client": {"ipAddress": "91.240.118.7", "geographicalContext": {"country": "Netherlands"}},
           "published": f"2026-07-03T04:1{i%10}:00Z"} for i in range(12)]
events.append({"eventType": "user.authentication.auth_via_mfa", "outcome": {"result": "SUCCESS"},
               "actor": {"alternateId": "c.demir@example.com"},
               "client": {"ipAddress": "91.240.118.7", "geographicalContext": {"country": "Netherlands"}},
               "published": "2026-07-03T04:20:00Z"})
print(json.dumps({"events": events}))
EOF
curl -X POST "http://localhost:5678/webhook/okta-auth-events" \
  -H "Content-Type: application/json" --data @/tmp/bf-events.json
```

This produces 12 failures + 1 success from the same IP → `brute_force`, severity `critical`. Watch `#soc-escalations` for the approval card, click a link (or open the resume URL from the n8n execution view with `?action=approve`), and observe the containment branch.

## Node flow

Webhook (respond immediately) → Detect Pattern (Code) → IF detected → AbuseIPDB reputation → LLM assessment → Parse (invalid → `uncertain`) → IF `likely_attack` ∧ confidence ≥ 70 ∧ containment recommended → Slack approval → **Wait (30 m, resume webhook)** → Evaluate (timeout = deny) → IF approved → EDR contain (mock) → Okta suspend (mock) → Slack confirmation. Low-confidence and denied paths each get their own Slack message; no-pattern ends silently.

## MITRE ATT&CK

- **T1110.001** — Brute Force: Password Guessing
- **T1110.003** — Brute Force: Password Spraying
- **T1078** — Valid Accounts (success-after-failures path)

## What to change for a real environment

- **Real containment APIs**: the EDR call mirrors CrowdStrike's `POST /devices/entities/devices-actions/v2?action_name=contain` but with a placeholder device ID — you'd first resolve host → device ID via `/devices/queries/devices`. The Okta call is the real `lifecycle/suspend` path shape; point the base URL at your tenant and use an `SSWS` token credential.
- **Approval UX**: plain resume-URL links work everywhere but Slack's native **Send and Wait for Approval** operation (n8n Slack node ≥ v2.2) gives you real buttons and captures the clicker's identity properly — swap it in if your n8n version has it. Also restrict who can hit the resume URL (n8n webhook auth) — anyone with the link can approve.
- **Stateful detection**: this detects patterns *within one posted batch*. Real Okta event hooks deliver events one at a time — you'd aggregate in Redis or run this on a schedule against the System Log API with a sliding window.
- **Thresholds**: 10/5 are demo values; baseline per-tenant.
- **Audit**: persist `detection_id`, decision, approver, and timestamps to your case system — Slack history is not an audit trail.
