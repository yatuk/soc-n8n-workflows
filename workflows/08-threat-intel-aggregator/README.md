# 08 — Threat Intel Feed Aggregator

## What it does

Builds the SOC's daily threat intel bulletin from three source types in parallel:

- **CISA Cybersecurity Advisories** (RSS)
- **SANS ISC Diary** (RSS)
- **AlienVault OTX subscribed pulses** (REST, `X-OTX-API-KEY`-style header credential) — pulses also carry structured indicators, which are merged into the IOC appendix.

The pipeline does two distinct dedups, on purpose:

1. **Mechanical dedup** (Code): exact link/title within the batch, plus a 7-day `workflowStaticData` window across runs — yesterday's stories don't reappear.
2. **Semantic dedup** (LLM): items covering the *same campaign* from different feeds become one story, with the multi-source coverage listed (three feeds covering one campaign is itself a signal).

IOC extraction is deterministic: regex for IPs/domains/hashes/CVE-IDs over refanged text (`[.]` and `hxxp` handled), unioned with OTX's structured indicators. **The IOC appendix never comes from the model** — an LLM-hallucinated IP in a blocklist is the kind of failure this design rules out. IOCs are re-defanged for delivery.

Output: Slack bulletin in `#threat-intel` (top story, ranked stories with per-story SOC action, IOC appendix) + HTML email.

## Trigger

Schedule — daily 05:00. Both RSS feeds are public; only OTX needs a (free) key. If all three sources fail, an embedded mock set (a coherent FortiOS campaign seen across all three feeds — good for demoing semantic dedup) keeps the run alive.

## Test it

Execute manually. Run it twice: the second run should end at "No News" thanks to the 7-day dedup window. To watch the semantic dedup work, check that the mock's three FortiOS items collapse into one story with `sources: ["cisa", "sans_isc", "otx"]`.

## Node flow

Schedule → [CISA RSS ∥ SANS RSS ∥ OTX HTTP] → Merge (3 inputs) → Normalize, Dedup & Extract IOCs (Code) → IF new → LLM bulletin (semantic dedup + ranking) → Format Bulletin + IOC Appendix (Code) → Slack ∥ Email.

## What to change for a real environment

- **Feeds**: add your ISAC/sector feeds, vendor blogs, and Mastodon/Bluesky infosec lists as extra RSS nodes — bump the Merge node's `numberInputs` accordingly.
- **OTX**: `pulses/subscribed` requires you to actually subscribe to pulses/users in OTX first; otherwise it returns empty. Consider `/pulses/activity` for a firehose.
- **IOC destination**: the appendix is human-readable; the real win is pushing extracted IOCs to your TIP (MISP `POST /attributes/add`) or SIEM watchlists — add an HTTP node after the format step.
- **Dedup store**: the 7-day static-data window resets on re-import; use Redis for durability.
- **Regex limits**: domain regex is TLD-list based and will both over- and under-match; a proper IOC extraction library (e.g. `iocextract` via a Python Code node) is better in production.
