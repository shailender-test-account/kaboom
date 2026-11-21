# Five-account qualification benchmark

Run from the workspace root:

```sh
INTENT_BATCH_BENCHMARK=baseline pnpm --filter @workspace/api-server exec vitest run src/__tests__/intent-batch-benchmark.test.ts
# After changing qualification internals:
INTENT_BATCH_BENCHMARK=compare pnpm --filter @workspace/api-server exec vitest run src/__tests__/intent-batch-benchmark.test.ts
```

The opt-in test uses the existing **development** database pool and a
read-only transaction. It imports the qualification functions, not the app
entrypoint: it starts no workers and makes no provider requests. SQL other
than SELECT is rejected. It selects five accounts with the most recent public
evidence and five roster accounts with no evidence/signals/inbound submissions.
It loads no unrelated evidence.

Each of three sequential calls performs fresh qualification. The comparison
reuses the original account IDs and JavaScript clock and checks a SHA-256
digest of the **entire** serialized result, not only score/tier. There is no
completed-result cache. Changes to development data between runs can
legitimately fail the digest assertion; take a new baseline before further
comparisons.

The report records query elapsed times, rows and JSON byte sizes in
`generated-artifacts/intent-batch-benchmark/` (excluded from Git and publishing).
It does not store source excerpts or personal details. Account IDs and result
digests remain local. Query timing includes waiting for the single transaction
connection. Byte counting adds instrumentation overhead; these are server
qualification measurements, **not** signed-in browser or HTTP latency.

## Observed development result

| Five-account batch | Before | After | Result |
| --- | --- | --- | --- |
| Heavy, 757 public evidence rows / 3,186 activity signals | 11.3–14.2 seconds | approximately 1.6–2.2 seconds | Full output identical |
| Light, no evidence | 1–14 milliseconds | 1–2 milliseconds | Full output identical |
| Heavy database result volume | 55.5 MB | 17.4 MB | About 69% less |
| Heavy SQL reads per fresh qualification | 9 | 8 | One shared public-evidence read |

The dominant repeated CPU work was evidence deduplication normalizing and
tokenizing source text for every pair. Qualification now prepares each row once
while preserving the same greedy ordering, identity/text checks, 21-day
comparison boundary and 80% overlap threshold. Product fitment prepares source
passages once per analysis instead of reparsing for every product.

Public evidence is loaded/validated once for both research and product-fit
analysis in the canonical batch. Activity projects only the geography facts it
uses, transfers each selected evidence source once even when many product
signals reference it, and retains signal-specific freshness and summary
fallbacks. Tenant, product, review, expiration and geography boundaries remain
in force. The HTTP candidate selection, filters, five-candidate budget,
continuation cursors and loaded-only totals are unchanged.
