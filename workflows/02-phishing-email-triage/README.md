# 02 — Phishing Email Triage

## What it does

Takes a user-reported email (pre-parsed EML as JSON — the shape a mail-parsing service or an abuse-mailbox handler would emit), then works through the same checklist a phishing analyst would:

1. **Header analysis** — SPF/DKIM/DMARC results from `Authentication-Results`, From vs. Reply-To domain mismatch.
2. **URL extraction & reputation** — regex-extracts URLs from text/HTML body, deduplicates domains, queries VirusTotal per domain (max 10, failures degrade gracefully).
3. **Attachment risk** — flags executable/macro/container extensions (`.exe .js .iso .lnk .docm .one` …).
4. **Social-engineering language** — LLM scores urgency/impersonation/credential-lure phrasing *only* (technical signals are scored deterministically, so the model can't be tricked into whitelisting a bad URL).
5. **Composite score** — weighted sum (auth 25 / VT up to 35 / attachments 15 / reply-to 10 / LLM ≤25). Score ≥ 60 → `phishing`, ≥ 30 → `suspicious`, else `likely_benign`.

Actionable results open a Jira ticket with the full evidence trail and ping Slack; benign reports get a lightweight Slack log and auto-close.

## Trigger

`POST /webhook/phishing-report`. An IMAP trigger (`Email Trigger (IMAP)` node watching an abuse mailbox) is the drop-in alternative — see "real environment" below.

## Test it

```bash
curl -X POST "http://localhost:5678/webhook/phishing-report" \
  -H "Content-Type: application/json" \
  -d '{
    "report_id": "phish-2026-0193",
    "reported_by": "a.yilmaz@example.com",
    "subject": "URGENT: Your mailbox will be deactivated in 24 hours",
    "headers": {
      "from": "IT Support <it-support@examp1e-corp.com>",
      "reply-to": "recovery@mail-secure-portal.ru",
      "authentication-results": "spf=fail smtp.mailfrom=examp1e-corp.com; dkim=none; dmarc=fail"
    },
    "body_text": "Dear user, we detected unusual sign-in activity. To avoid permanent deactivation you must verify your credentials within 24 hours: https://login-examp1e-corp.web-verify.top/session/renew Click now to keep access. IT Helpdesk.",
    "attachments": [
      {"filename": "Account_Notice.html", "content_type": "text/html", "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}
    ]
  }'
```

Expected response: `{"report_id":"phish-2026-0193","verdict":"phishing","phishing_score":85}` (score varies with VT results and the LLM).

## Node flow

Webhook → Parse Email & Extract IOCs (Code) → Fan Out URL Domains (Code) → VirusTotal Domain Reputation (HTTP, `onError: continue`) → Aggregate VT Enrichment (Code) → LLM Social Engineering Analysis → Compute Phishing Score (Code) → IF actionable → Jira ticket → Slack notify / Slack benign log → Respond.

## MITRE ATT&CK

- **T1566.001** — Phishing: Spearphishing Attachment
- **T1566.002** — Phishing: Spearphishing Link
- **T1598** — Phishing for Information (credential-harvest pages)

## What to change for a real environment

- **Ingest**: swap the webhook for the IMAP trigger on the abuse mailbox, plus a real EML parser (the `Extract from File` node handles `.eml`, or use `mailparser` in a Code node) — this workflow assumes pre-parsed JSON.
- **VT quota**: the free tier allows 4 lookups/min; the fan-out is capped at 10 domains but you'll want request throttling (Loop Over Items + Wait) on the free tier.
- **URL detonation**: domain reputation misses freshly registered domains; add urlscan.io submission or a sandbox for the `suspicious` band.
- **Response actions**: on confirmed `phishing`, extend with mailbox search-and-purge (M365 Graph `security/threatSubmission` or Gmail API) to pull the same message from other inboxes.
- **Jira fields**: project key `SOC` and issue type ID `10001` are placeholders; map to your project scheme and set a priority field from the verdict.
