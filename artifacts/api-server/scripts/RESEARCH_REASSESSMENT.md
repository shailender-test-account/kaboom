# Review existing public-research findings locally

Run against the **development** database with an explicit tenant and account:

```sh
pnpm --filter @workspace/api-server research:reassess TENANT_ID ACCOUNT_ID ../../generated-artifacts/account-reassessment.json
```

Replace the IDs with positive integers. The output must be a new file (existing reports are not overwritten). The command uses the application's database pool inside a read-only, repeatable-read transaction. It refuses production mode and exports at most 1,000 findings per account, failing rather than truncating.

The report contains original facts, direction and actual growth headcount, old product fitments, proposed fitments/classification, removed product IDs, and an old/proposed public-research opportunity brief. It makes no provider calls and has **no apply mode**. Review the source URLs and proposed removals before any separate, explicitly approved correction of stored evidence/signals. Pending/rejected rows are shown individually but excluded from the proposed brief.

This is a public-research preview, not a BI recalculation. First-party form evidence is not included in the preview brief. Nothing writes form qualification, fiscal totals, Total Order Value, CRM scores, signals, review status, or automation state. Keep the report private: it can contain internal account research. Generated reports/bundles are ignored by Git and publishing.
