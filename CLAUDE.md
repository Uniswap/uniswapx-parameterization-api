# CLAUDE.md

Guidance for AI agents (and humans) working in this repo.

## Analytics tables are defined in another repo — verify columns before relying on them

This repo no longer has a Redshift cluster and runs no SQL against analytics tables. Its analytics
role is to emit log lines (`QuoteRequest`, `QuoteResponse`, `HardRequest`, `HardResponse`) that
the analytics stack's Firehose streams deliver to S3, from which data-eng loads BigQuery
(`uniswap_x.*`). The fade circuit breaker reads the `PostedOrders` DynamoDB table plus the order
service (`lib/cron/order-service-fades-source.ts`), not any analytics table. The table schemas are
**not defined here**; they are owned by the `data-eng-workflows` repo, in the load configs:

```
data-eng-workflows/lib/spaces/uniswap_x/functions/uniswap_x_hourly_config/tables/load/*.yaml
```

e.g. `rfq_requests.yaml`, `rfq_responses.yaml`, `hard_requests.yaml`, `hard_responses.yaml`, and
(written by the order service, not this repo) `posted_orders.yaml` / `archived_orders.yaml`.

### The trap: "emitted" ≠ "loaded"

A field being emitted — by this service's log lines or by `x-service`'s `analytics-service.ts` —
does **not** mean it lands in the table. Only fields listed in the load YAML are loaded; the rest
are dropped. Concretely, V3 emits `startBlock` (= `cosignerData.decayStartBlock`), but
`posted_orders.yaml` has no `startBlock` column, so it does not exist in `posted_orders`. Likewise,
a column may exist but only be populated for some order types (e.g. `auctionStartBlock` is emitted
for Priority/Hybrid orders but is null for Dutch_V3). Adding a field to a log line here is not
enough for it to reach BigQuery: add it to the load YAML too. Before relying on a column (in a
backtest or analysis), grep the matching `*.yaml` (`../data-eng-workflows` if checked out) and
check that it is populated for the rows you care about.

## Backtesting fade circuit-breaker changes against real order history

Any change to the circuit-breaker knobs in `lib/cron/fade-rate-v2.ts` (threshold, Laplace
prior, block backoff/cap, decay rules, windowing) should be replayed against real order data
before shipping — the PR #482 backtest reversed two confidently-held design opinions, cheaply.
Method: pull the extract below, then simulate 10-minute cron runs over it, treating orders
posted while a filler would have been benched as prevented (see PR #482 discussion for the
full harness design, per-filler duty-cycle/allowed-fades metrics, and baseline numbers).

The breaker's fade semantics live in `classifyOutcome` / `buildFadeRows` in
`lib/cron/order-service-fades-source.ts` (the Redshift SQL that used to define them is in git
history at `lib/repositories/fades-repository.ts`). The long-history source for a backtest is now
BigQuery (`uniswap_x.posted_orders` / `uniswap_x.archived_orders`); the Redshift copies stopped
updating on 2026-09-24 and the cluster has since been deleted (a final snapshot was kept). The
extract below is still written in Redshift SQL and needs porting to BigQuery before its next use. It reproduces those semantics with **no 24h window, no latest-100
cap, and no row limit** (the replay applies windowing itself).
**Keep the `faded` CASE in sync with `classifyOutcome`** — e.g. #461 changed Dutch*V3 to
`fillTimeBlocks > 0` (a fill at the decay-start block is \_not* a fade); an extract using the
old `>= 0` inflates V3 fade rates and mis-calibrates every knob. Two Redshift-specific caveats:
`archivedorders` never receives `expired` or `insufficient-funds` orders and its `cancelled` rows
carry no token columns, so (a) the `ao.fillTimestamp IS NULL THEN 1` branch is how an expiry
shows up (correct: the live breaker counts expiries as fades), and (b) the replay must apply the
cancelled / insufficient-funds / error policy itself (`FADES_COUNT_NEVER_FILLED_TERMINAL_AS_FADE`,
default: excluded, no row) and cannot tell those apart from expiries in this extract — use the
order service's status for that if it matters. The raw columns are included so the replay can
recompute `faded` locally if the semantics change again:

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
      WHEN po.ordertype = 'Dutch_V3' AND ao.fillTimeBlocks > 0 THEN 1
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
  per address. Use the per-address rows (`pk` = checksummed address, `filler` = endpoint);
  ignore the legacy rows keyed by endpoint URL with an `addresses` set, which stopped being
  updated when attribution moved to per-address rows. Per-address replay is a usable
  approximation but under-counts multi-address fillers.
- Dedupe on `quoteId` (the `archivedorders` join can rarely fan out).
