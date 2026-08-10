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

## Backtesting fade circuit-breaker changes against real order history

Any change to the circuit-breaker knobs in `lib/cron/fade-rate-v2.ts` (threshold, Laplace
prior, block backoff/cap, decay rules, windowing) should be replayed against real order data
before shipping — the PR #482 backtest reversed two confidently-held design opinions, cheaply.
Method: pull the extract below, then simulate 10-minute cron runs over it, treating orders
posted while a filler would have been benched as prevented (see PR #482 discussion for the
full harness design, per-filler duty-cycle/allowed-fades metrics, and baseline numbers).

Extract query (matches the breaker's fade semantics from `V2_FADE_RATE_SQL`, but with **no
24h window, no latest-100 cap, and no row limit** — the replay applies windowing itself):

```sql
SELECT
    po.filler   AS rfqFiller,       -- quoted exclusive filler address
    po.quoteid  AS quoteId,
    po.chainid  AS chainId,
    po.ordertype AS orderType,
    po.createdat AS postTimestamp,  -- epoch secs
    po.deadline AS deadline,        -- epoch secs, completion time
    po.starttime AS decayStartTime,
    ao.fillTimestamp AS fillTimestamp,
    ao.fillTimeBlocks AS fillTimeBlocks,
    ao.filler AS actualFiller,
    ao.tokenIn AS tokenIn,
    ao.tokenOut AS tokenOut,
    CASE
      WHEN ao.fillTimestamp IS NULL THEN 1
      WHEN po.ordertype = 'Dutch_V3' AND ao.fillTimeBlocks >= 0 THEN 1
      WHEN po.ordertype = 'Dutch_V2' AND po.starttime < ao.fillTimestamp THEN 1
      ELSE 0
    END AS faded
FROM postedorders po
LEFT OUTER JOIN archivedorders ao ON po.quoteid = ao.quoteid
WHERE po.ordertype IN ('Dutch_V2', 'Dutch_V3')
  AND po.quoteid IS NOT NULL
  AND po.filler IS NOT NULL
  AND po.filler != '0x0000000000000000000000000000000000000000'
  AND po.chainid NOT IN (5, 8001, 420, 421613)
  AND po.deadline < EXTRACT(EPOCH FROM GETDATE())                          -- completed only
  AND po.deadline >= EXTRACT(EPOCH FROM (GETDATE() - INTERVAL '28 DAYS'))  -- replay window
ORDER BY po.deadline ASC;
```

Post-processing the replay must do itself (deliberately not in the SQL):

- **Filter permissioned-token orders** using `PERMISSIONED_TOKENS` from `@uniswap/uniswapx-sdk`
  (the breaker excludes them); the SQL keeps `tokenIn`/`tokenOut` for this so the list can't
  drift from the code.
- **Aggregate addresses to fillers** with the `FillerAddress` DynamoDB table
  (`aws dynamodb scan --table-name FillerAddress`) — the breaker scores per filler hash, not
  per address. Per-address replay is a usable approximation but under-counts multi-address
  fillers.
- Dedupe on `quoteId` (the `archivedorders` join can rarely fan out).
