# 07 — Credential Leak Monitor

## What it does

Daily check of HaveIBeenPwned's **domain search** API for new breach exposures of company accounts, with an automated but *proportionate* response:

- `workflowStaticData` remembers every `(account, breach)` pair already handled, so each exposure alerts **exactly once** — the second run after a breach is silent.
- Accounts whose breach included **password data** get an automatic (mock) Okta `lifecycle/expire_password` call — forced reset at next login, no temp password.
- Accounts exposed **without** password data (email/phone only) are listed as *monitor only* — resetting passwords over a phone-number leak just burns helpdesk goodwill.
- Failed reset API calls are counted and loudly flagged for manual handling, never silently dropped.

Summary goes to Slack (`#soc-alerts`) and as an HTML email to the IAM team with concrete follow-ups (verify resets, watch for credential stuffing — cross-reference workflow 04).

If the HIBP call fails or isn't configured, an embedded mock response (same shape as the real API: `{alias: [breachNames]}`) keeps the demo runnable.

## Trigger

Schedule — daily 06:30.

## Test it

Execute manually. First run: the mock data yields 6 new `(account, breach)` exposures, 3 of which involve passwords → 3 reset calls (they fail against the mock Okta URL, which itself demos the failure-handling path). Second run: static data suppresses everything → "Nothing New - End".

To reset the dedup state, edit the **Detect New Exposures** node and temporarily add `sd.seen_exposures = {};` at the top (or re-import the workflow).

## Node flow

Schedule → HIBP Domain Breach Search (HTTP, `hibp-api-key` header credential) → Detect New Exposures (Code: fallback mock, static-data dedup, split reset/monitor) → IF new → Split Out Reset Candidates → Okta Expire Password (mock, failures tolerated) → Summarize Response Actions (Code) → Slack ∥ Email.

## MITRE ATT&CK

- **T1078** — Valid Accounts (what leaked credentials enable)
- **T1110.004** — Brute Force: Credential Stuffing (the follow-on attack this pre-empts)

## What to change for a real environment

- **HIBP subscription**: domain search requires a verified domain and a paid API key (`hibp-api-key` header). Replace `example.com` in the URL and the Code node's `DOMAIN` constant. Mind the rate limits on your tier.
- **Breach metadata**: the mock `BREACH_META` map should become a real call to `GET /api/v3/breach/{name}` (unauthenticated) so `data_classes` reflect reality.
- **Reset action**: point the Okta call at your tenant (`SSWS` token). Consider `/lifecycle/reset_password?sendEmail=true` instead of `expire_password` if you want user-driven resets, and add session revocation (`/sessions`) for password-exposed accounts.
- **Human gate for VIPs**: auto-reset is fine for the general population; for executives/service accounts route through the approval pattern from workflow 04 (a broken service account at 6 AM is its own incident).
- **User notification**: pair the reset with an email to the affected user explaining why, or the helpdesk gets the ticket instead of you.
