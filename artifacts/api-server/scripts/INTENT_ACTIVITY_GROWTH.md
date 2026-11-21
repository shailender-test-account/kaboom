# Account activity lookup growth check

Run from the workspace root:

```sh
INTENT_ACTIVITY_GROWTH=1 pnpm --filter @workspace/api-server exec vitest run src/__tests__/intent-activity-growth.test.ts src/__tests__/intent-activity-read.test.ts
```

Without the flag, the SQL eligibility/projection regression still runs against
isolated temporary tables; large fixtures and current-data plans are opt-in.
The probe imports the configured development pool and query, not the server
entry point. It starts no workers, makes no provider requests, and uses no
score caches. It does not access production.

## Safety and comparisons

- Current development histories: a `BEGIN READ ONLY` transaction selects up
  to five accounts with the most product signals. Three fresh
  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` runs compare the independent legacy
  resolver, bounded resolver, legacy full projection, and new full projection.
- Growth histories: only temporary, connection-local tables/indexes are
  populated and analyzed, with automatic rollback. Application records and
  indexes are unchanged. A 3,200-signal shared-source batch is held constant
  while unrelated evidence grows to 10,000, 100,000 and 500,000 rows, split
  between the selected tenant and another tenant.
- The full projections transfer the same source facts, using the same JSON
  expressions. The new transport has additional source-only rows; comparisons
  normalize row ordering and source ownership rather than compare row counts.
- Eligibility assertions cover competing linked/payload IDs, newest approved
  versus newer rejected evidence, rejected-only signal guards, foreign-tenant
  signal and payload evidence, malformed IDs, inactive types, missing categories,
  account/product scope, expiration and the exact one-year signal boundary.
  Approval changes are reread. Existing reader tests cover India attribution,
  signal-specific freshness and uncached per-signal summary fallbacks.
- Generated plans go into ignored `generated-artifacts/intent-activity-growth/`.
  No excerpts, summaries or provider payloads are saved. Plans may contain
  local fixture or development identifiers.

## Observed development plans (2026-10-23)

The live development database had 28,411 evidence records and 43,311 signals.
The selected five-account batch returned 3,275 eligible activity signals,
489 distinct payload references and 533 selected source records.

| Work | Legacy full query | Bounded full query |
| --- | ---: | ---: |
| Development batch, three runs | 248–303 ms | 314–338 ms |
| Shared-buffer hits | 65,235 | 57,368 |
| 10,000 unrelated fixture records | 64 ms | 44 ms |
| 100,000 unrelated fixture records | 187 ms | 23 ms |
| 500,000 unrelated fixture records | 46 ms | 35 ms |

Times are database execution times, not HTTP/browser latency, and are sensitive
to cache warmth and concurrent work. In particular, the new query is **not**
a universal current-data latency improvement. Its benefit is bounded evidence
access as unrelated history grows, without tenant preloads or retained results.
Do not treat these single fixture timings as absolute performance thresholds.

The old eligibility `EXISTS` subplans chose whole-evidence scans at intermediate
fixture sizes, then switched back to indexed probes at 500,000 rows. Thus more
history did not produce monotonically increasing times. The new query used
only indexed evidence reads at every fixture size, with five distinct payload
ID probes and four selected-source probes instead of approximately 3,200
repeated payload probes. Local-buffer hits were about 6,500–9,700 versus
16,000–32,000 for the old query. The opt-in test asserts this access shape,
not a noisy millisecond limit.

## Index versus batch decision

The existing primary key on evidence ID and `(tenant_id, signal_id)` index are
sufficient for the chosen batch strategy. Each ID probe also checks tenant and
approval. Signal-linked evidence is read only for qualifying signals and one
aggregate supplies both the newest-approved ID and the review guard.
No production/development schema migration is needed.

An additional approved `(tenant_id, signal_id, id DESC)` partial index could
help exceptionally large **per-signal** review histories, but would not dedup
shared payload probes or remove the old tenant-wide review subplans on its own.
It was not added speculatively. Per-signal linked work still scales with that
signal's own evidence history, not unrelated tenant history.

Separately materializing sources and then joining them to every signal is not
sufficient: development plans underestimated CTE cardinalities and chose
signals-by-sources nested loops, repeatedly reading wide values. The final
query transports narrow signal rows and one source-only row per selected ID
using `UNION ALL`. The reader hydrates sources locally before applying unchanged
freshness/geography rules, so row order is irrelevant and missing excerpts
still fall back to each individual signal's summary.
