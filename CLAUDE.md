# CLAUDE.md

Guidance for AI agents (and humans) working in this repo.

## Redshift analytics tables are defined in another repo — verify columns before using them

This service reads Redshift tables (`postedorders`, `archivedorders`, `rfqrequests`,
`rfqresponses`, etc.) via raw SQL in `lib/repositories/*.ts` (see `BaseRedshiftRepository`)
and `lib/cron/*.ts`. These tables are **not defined here**. Their schemas are owned by the
`data-eng-workflows` repo, in the load configs:

```
data-eng-workflows/lib/spaces/uniswap_x/functions/uniswap_x_hourly_config/tables/load/*.yaml
```

Table → YAML mapping (table names are lowercased in Redshift; YAML uses snake_case):

| Redshift table   | Load schema YAML       |
|------------------|------------------------|
| `postedorders`   | `posted_orders.yaml`   |
| `archivedorders` | `archived_orders.yaml` |
| `rfqrequests`    | `rfq_requests.yaml`    |
| `rfqresponses`   | `rfq_responses.yaml`   |

**Rule: before referencing any column in Redshift SQL, confirm it exists as a `name:` field
in the corresponding YAML.** The view/query column references are validated only at runtime
against the live cluster — there is no compile-time or unit-test check — so a typo or a
non-loaded column fails the cron in production (and a column that exists but is null for the
relevant rows fails *silently*).

### The trap: "emitted" ≠ "loaded"

A field being emitted by `x-service`'s `analytics-service.ts` does **not** mean it lands in
the table. Only fields listed in the load YAML are loaded; the rest are dropped. Concretely,
V3 emits `startBlock` (= `cosignerData.decayStartBlock`), but `posted_orders.yaml` has no
`startBlock` column, so it does not exist in `postedorders`. Likewise, a column may exist but
only be populated for some order types (e.g. `auctionStartBlock` is emitted for Priority/Hybrid
orders but is null for Dutch_V3). Check both that the column exists **and** that it is populated
for the rows you care about.

### How to verify

1. If `../data-eng-workflows` is checked out locally, grep the matching `*.yaml` for the column.
2. Otherwise (or to be sure it's populated), query the live cluster:
   ```sql
   SELECT column_name FROM information_schema.columns
   WHERE table_name = '<table>' AND column_name = '<column>';
   -- and, for null-for-some-rows risk:
   SELECT ordertype, COUNT(*), COUNT(<column>) FROM <table> GROUP BY 1;
   ```
3. New columns must be added to the `data-eng-workflows` load YAML (and the table) **before**
   any SQL here references them.
