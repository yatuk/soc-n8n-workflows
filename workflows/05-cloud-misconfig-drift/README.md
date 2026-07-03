# 05 — Cloud Misconfig Drift Detection

## What it does

Every 6 hours, pulls a cloud configuration snapshot (S3 buckets, IAM policies/users, security groups) and runs policy-as-code checks against it:

| Rule | Severity | Check |
|---|---|---|
| `S3-001-public-bucket` | critical | Publicly readable bucket without an `approved_public` exception tag |
| `S3-002-no-encryption` | medium | Default encryption disabled |
| `IAM-001-full-admin` | critical | `Action:*` on `Resource:*` |
| `IAM-002-service-wildcard` | high | Service-level wildcard (e.g. `s3:*`) on all resources |
| `IAM-003-no-mfa` | high | Console access without MFA |
| `IAM-004-stale-key` | medium | Access key older than 365 days |
| `NET-001-mgmt-open-world` | critical | 22/3389 open to `0.0.0.0/0` |

The **drift** part: finding IDs are remembered in `workflowStaticData` between runs, so each finding is labeled `NEW` vs `existing`, and findings that disappeared are reported as resolved. **New criticals** get an immediate Slack alert; everything lands in an HTML email report grouped by severity with remediation guidance per row.

The inventory HTTP call targets a mock internal API and falls back to an embedded mock snapshot (which intentionally contains violations of every rule plus a *tagged-and-approved* public bucket to show exception handling) — so the workflow demos end-to-end with zero setup.

## Trigger

Schedule — every 6 hours. For a demo, open the workflow in n8n and click **Execute Workflow**.

## Test it

No payload needed. Execute manually twice in a row and compare: the first run labels everything `NEW`; the second labels the same findings `existing` — that's the static-data drift tracking working.

Expected mock findings: 4 critical/high/medium S3+IAM issues and one open-to-world RDP security group; `corp-public-website-assets` is public but **suppressed** by its `approved_public: true` tag.

## Node flow

Schedule (6h) → Fetch Inventory (HTTP, mock URL, failure tolerated) → Load Inventory w/ mock fallback (Code) → Evaluate Policy Rules & Drift (Code, one item per finding, static-data diff) → IF findings → IF new critical → Slack immediate alert / queue → Merge → Build HTML Report (Code) → Email.

## What to change for a real environment

- **Real inventory source**: replace the mock endpoint with AWS Config aggregator queries, Steampipe, or direct SDK calls (S3 `GetBucketPolicyStatus`, IAM `GetAccountAuthorizationDetails`, EC2 `DescribeSecurityGroups`) — the rule engine consumes a plain JSON snapshot, so only the fetch layer changes. In practice AWS Config / Security Hub already does most of these checks; this workflow earns its keep for **custom org rules** (the exception-tag pattern) and for routing/dedup.
- **State store**: `workflowStaticData` resets if the workflow is re-imported and doesn't work across multiple n8n instances — move `known_findings` to Redis/Postgres for production.
- **Exception management**: the `approved_public` tag check is the seed of an exception register; back it with a reviewed list (owner + expiry date) rather than a raw tag anyone can set.
- **Ticketing**: for `NEW` criticals, open a ticket (see workflow 02's Jira node) instead of only Slack — misconfigs need owners and due dates, not just noise in a channel.
