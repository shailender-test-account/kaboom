# Browser regression gates

## Signed-in Command Center → progressive account details

Start the managed **PlayForge web** workflow, then run:

```sh
pnpm --filter @workspace/api-server exec playwright install chromium
pnpm --filter @workspace/api-server test:e2e:intent-detail
```

Set `INTENT_DETAIL_E2E_URL` to another running **development** frontend if
needed (default `http://localhost:80`). Do not target production. The gate needs
neither a database, a running workspace API server, nor provider/login credentials.
It returns a nonzero exit code on failure and uses the shared Playwright failure
traces, screenshots and error context described below.

The real protected app, auth context, Command Center account-name links, Wouter
navigation, generated detail client, query cache and account page run in Chromium.
A test-only, token-protected loopback service supplies a signed-in fixture identity
and deterministic read responses. It is never imported into production. This tests
the authenticated application journey, **not Clerk login or live backend result
correctness**; unit/route regressions cover canonical response parity separately.

Three scenarios cover:

- Client/audience/product scope with either a shared category name or legacy
  catalog category/subcategory IDs, preserved in links and actual detail requests.
- Identity before evidence, qualification and research; no premature empty
  conclusions; evidence failure (including the automatic retry), then manual
  panel-only retry while identity, qualification and delayed research remain usable.
  Contact and return links retain scope.
- An in-place switch from Alpha to Beta while Alpha panels are outstanding.
  Late Alpha evidence, qualification and research must not appear under Beta,
  and Beta must subsequently display its own evidence and contact.

Responses are released by explicit controls, not sleeps or live-service latency
thresholds. Condition waits allow cold frontend hydration; there are no automatic
whole-test retries. All writes are rejected and asserted absent, unknown API
requests fail the gate, external executable/provider traffic is blocked, and
service workers are disabled. No database, production router, research worker,
send/enroll path or provider client is loaded by the fixture.

This **detail-page correctness** gate is separate from account-batch performance
checks. Completion validation runs it sequentially after the backend and CRM
gates, avoiding CPU contention with existing latency assertions. Run this script
alone when changing account navigation or progressive panel behavior.

## CRM corrections → HP reporting

Start the managed **PlayForge web** workflow, then run:

```sh
pnpm --filter @workspace/api-server exec playwright install chromium
pnpm --filter @workspace/api-server test:e2e:hp-crm
```

The default frontend is `http://localhost:80`. Set `HP_CRM_E2E_URL` to another
running development frontend if needed. The test requires the development
database used by `@workspace/db` (`DATABASE_URL`); do **not** run against production.
It does not need a running workspace API server or Clerk credentials.

### Boundaries and isolation

- Each test creates a unique tenant, an HP client, two parent-linked accounts and
  named contacts. Backend reconciliation tests reuse the same roster fixture.
- Playwright loads the real protected app, editor, generated API hooks and HP
  views. Only authentication and unrelated navigation chrome are supplied by a
  private, token-protected loopback harness. This is not a login-provider test.
- All browser API requests are forwarded to that harness, where real deal and HP
  routes execute against the fixture tenant. Unknown routes fail the test.
  Legacy traffic readers mounted before HP client detection explicitly return
  an out-of-scope error, rather than fake analytics.
- Third-party requests are blocked, as are service workers. No send, enrollment,
  monitoring, email, or external integration router is mounted.
- Workbooks go through the real HP importer. No qualification/report arithmetic
  is copied into the browser test.
- `finally` closes the server and removes **only the tenant created by this test**,
  including failure during setup or UI assertions. Abrupt process termination
  cannot execute teardown; never use broad database cleanup commands.
- Dates are intentionally historical so empty periods remain selectable as zero
  rather than becoming “Not yet started”.

The gate creates both INR and USD opportunities through the UI, checks ToV
separately from booked money, verifies Jan/Feb actual dates, imports linked Excel
mirrors, corrects account/contact/date/currency/value into the next fiscal year,
reloads chosen names, checks mobile dialog width and reachable save controls,
then reopens and deletes the deal. Evidence and parent records must reflect the
current facts; neither fiscal year may resurrect a linked Excel result.

Failures retain a Playwright trace, screenshot and error context in
`artifacts/api-server/test-results/`. Inspect a trace with
`pnpm --filter @workspace/api-server exec playwright show-trace <trace.zip>`.
This command exits nonzero on any regression and can be used as a release/CI gate.
Condition-based assertions allow 15 seconds for cold frontend bundles when the
backend suite runs concurrently; the gate has no automatic retries.
The registered completion validation runs the backend suite **then** this browser
gate, not in parallel: existing backend wall-clock performance checks should not
compete with Chromium for CPU.
