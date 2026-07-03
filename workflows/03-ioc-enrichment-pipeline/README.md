# 03 — IOC Enrichment Pipeline

## What it does

Accepts a batch of raw IOCs (up to 50), classifies each by shape (IPv4 / MD5-SHA1-SHA256 hash / domain), fans them out to the right intel sources in parallel branches, and collapses everything into one normalized, sorted risk report:

- **IPs** → VirusTotal `ip_addresses` → AbuseIPDB `check` → Shodan host lookup (optional branch node, **disabled by default** — enable it and set your key to add open-port context).
- **Hashes** → VirusTotal `files`.
- **Domains** → VirusTotal `domains`.
- **Anything unrecognized** → flows through tagged `unsupported` so the report accounts for every submitted IOC.

Each row gets a composite **risk score 0–100** (VT detection ratio weighted 70%, AbuseIPDB confidence 30%; VT-only types 100% VT) and a level: `high ≥ 70`, `medium ≥ 40`, `low ≥ 10`, `clean`, or `lookup_failed`. Output is returned as JSON to the caller **and** written as a timestamped CSV to `/data/reports/`.

Design detail worth noticing: every intel HTTP node has `onError: continueRegularOutput` + `alwaysOutputData`, and the combine nodes treat each source as nullable — a TI API outage degrades the row to `lookup_failed` instead of killing the batch.

## Trigger

`POST /webhook/ioc-enrich`

## Test it

```bash
curl -X POST "http://localhost:5678/webhook/ioc-enrich" \
  -H "Content-Type: application/json" \
  -d '{
    "batch_id": "ir-case-2026-042",
    "iocs": [
      "185.220.101.34",
      "91.240.118.7",
      "login-examp1e-corp.web-verify.top",
      "44d88612fea8a8f36de82e1278abb02f",
      "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f",
      "not_an_ioc%%"
    ]
  }'
```

The two example hashes are the EICAR test file (MD5 and SHA256) — safe to look up and guaranteed to have VT detections, which makes them ideal for demoing the scoring. Expected response shape:

```json
{
  "batch_id": "ir-case-2026-042",
  "count": 6,
  "results": [
    { "ioc": "275a02...", "type": "hash", "risk_score": 92, "risk_level": "high", "vt_malicious": 62, ... },
    { "ioc": "not_an_ioc%%", "type": "unsupported", "risk_level": "unknown", ... }
  ]
}
```

## Node flow

Webhook → Classify IOCs (Code) → Switch by type → [VT IP → AbuseIPDB → Shodan (disabled) → Combine] / [VT File → Tag] / [VT Domain → Tag] / [Mark Unsupported] → Merge (4 inputs, append) → Normalize & Risk Score (Code, sorted desc) → CSV to disk + JSON response.

## What to change for a real environment

- **Rate limits**: VT free tier = 4 req/min. For batches > 4, insert `Loop Over Items` + a `Wait` node (15 s) around the VT calls, or upgrade the key.
- **Shodan**: enable the disabled node and replace the `SHODAN_API_KEY_PLACEHOLDER` query param with a real credential (Shodan auths via `?key=`).
- **Score weights**: the 70/30 split and the VT ratio normalization (`malicious + 0.5·suspicious` over 25% of engines) are starting points — tune against IOCs you've already adjudicated.
- **Output path**: `/data/reports/` assumes the n8n Docker volume; change for your host, or replace the file nodes with an S3/SharePoint upload.
- **IOC types**: URLs, IPv6, and email addresses fall into `unsupported` today; add branches (VT `urls` needs base64url-encoded IDs — do that in the classify node).
