# Kaboom Remix — independent Render validation package

## Scope: deployable source, not a populated backup

This is a separate package built from the current working-tree source, not a
verified checkout of the latest GitHub backup. `SOURCE-MANIFEST.json` identifies
the source and every included file. Only the packaged copies are adapted.
The original application's code, services, Git remote and databases are untouched.

**Included:** API and PlayForge source; shared workspace packages; dependency
lockfile and patch; all journaled migrations and migration metadata; application
static assets and required brand logo; Render adapter, Blueprint and tests.
Other artifact package manifests are retained for workspace installation; their
slide/sandbox applications are not deployed or built.

**Excluded:** real `.env` files, secret values, database rows/dumps, original
sessions/credentials, customer workbooks, uploaded storage contents, Git history,
builds, node_modules, internal agent context, reports and customer screenshots.

## Safety defaults — read this before deploying

This package is deliberately **read-only validation hosting**, not an activated
outreach system. Authentication, first-login password change and two existing
read-only Analytics POST queries are allowed. Other writes return a clear
read-only error. Background jobs, routing, email, calls, Drive sync, paid
monitoring and startup migrations/seeds are not started. Public tracking,
unsubscribe links, contest submissions, webhook and storage endpoints are
disabled to avoid replaying interactions or using the original storage service.

The runtime enforces safe flags, even if someone sets the original automation
flags to true. `RENDER_DATA_READY=true` unlocks authenticated **reads**, not
outreach or general editing. A separately reviewed operational rollout is needed
to enable writes, workers, independent providers and file storage.
No customers should receive links to this validation copy.

## 1. Put the package in the backup repository

Extract the ZIP. Its `kaboomremix-render` folder contains the repository root.
Use a new private repository/branch, or review a diff against the existing backup
before copying files. Do not blindly overwrite a repository with newer changes.
Do not replace or attach the original live application's Git remote.

Keep `lib/`, `artifacts/`, `patches/`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
`package.json` and `deployment/render/` together. Put the contents of this folder,
not a ZIP or an extra nested directory, at the intended repository root.
The Blueprint is `render.yaml` at that root.

## 2. Create the Render services

In Render, connect that private repository and create a Blueprint from
`render.yaml`. Review the cost before approving: it requests a **paid Node web
service and a paid, persistent PostgreSQL database**. Choose their region and
capacity for your needs before approval; the small template sizes are a starting
point, not a promise of production capacity for the full dataset.

Leave **Root Directory blank** (repository root). The Blueprint installs the
locked pnpm workspace, builds only PlayForge and the API, then starts:

```sh
node deployment/render/server.mjs
```

Node is pinned to 24.22.3 and pnpm to 10.26.1. The build includes devDependencies
because Vite, TypeScript and esbuild are build tools. No database migration,
schema push, restore or seed is in the build/start commands.
Automatic Git-triggered deploys are off; deliberately redeploy reviewed changes.

Render creates `DATABASE_URL`, `SESSION_SECRET`, `PORT` and its own public URL.
`BASE_URL` defaults to Render's `RENDER_EXTERNAL_URL`. If using a new custom
domain, set its HTTPS origin explicitly in Render Environment. Do not use the
original Kaboom domain or a development preview URL.

`/api/healthz` is a **process-health** check, not proof that data was restored.
It can return 200 while the API intentionally returns 503 awaiting restoration.

## 3. Configure secrets without uploading `.env`

Use **Render → web service → Environment**. `.env.example` lists names only;
the application does not load that file automatically. A real `.env` is neither
necessary in GitHub nor included here. Never paste credentials into a commit,
issue, screenshot or chat.

Initial validation needs only the new database connection and new session
secret. Provider keys are not required to render existing dashboards; packaged
AI clients initialize only when used. Keep provider credentials absent.

For a later reviewed rollout:
- `OPENAI_API_KEY` / optional `OPENAI_BASE_URL`: your own direct OpenAI-compatible
  access. Replit proxy URLs/keys are not portable. The adapter clears them.
- `INTEGRATION_CREDENTIAL_KEYS`: encrypted saved credentials require their
  matching encryption keys or secure replacement. Do not assume changing this
  variable re-encrypts old records. Prefer configuring independent credentials.
- Resend: independent API-key transport and a verified sender/domain are needed;
  sending is still blocked in this package. Do not reuse the original sender
  until duplicate-outreach risks and authorization have been reviewed.
- Google Drive/Sheets and Perplexity: current connector paths depend on Replit.
  They need independent OAuth/direct API adapters; merely adding connector host
  variables will not work.
- Uploaded files: the Replit-local object-storage sidecar is unavailable here.
  A separate storage adapter, reviewed file transfer and URL mapping are needed.
- Queues: use a new, empty Redis instance for a later operational rollout.
  Never attach the original Redis queue. This validation runtime clears its URL.

## 4. Restore data separately, with explicit approval

**This step is NOT done by this package. No production database was contacted,
exported or restored while preparing it.** A database must be restored separately
to see your actual users, account/contact records, journeys, sequences, form
responses, monitoring/news analyses, feedback and analytics history.

Have the authorized operator select and securely transfer an approved full
snapshot. Restore into the **new, empty Render database**, never the source or an
occupied destination. Preserve account/contact IDs, foreign keys, timestamps,
JSON definitions, sequences/ID counters and the `drizzle` migration ledger.
Choose supported PostgreSQL versions/extensions and exclude provider-internal
management schemas. Do not use `--clean`, force-push or delete old migrations to
make a restore appear successful.

Database access is private by default (`ipAllowList: []`). Use an authorized
private-network shell, or temporarily allow only the operator's exact IP while
restoring, then remove that exception. Do not publicly expose PostgreSQL.

Before allowing access:
1. Verify the connection is the new Render database; verify the source and target
   independently. The runtime accepts Render `dpg-...` hosts and refuses Replit
   database hosts, but that is not a substitute for operator confirmation.
2. Review source migration hashes/schema against this package. A restored source
   can have schema changes newer than the source archive or an incomplete legacy
   ledger. Do not blindly replay or baseline migrations. The retained package
   command is `pnpm --filter @workspace/db run migrate`; run it **only manually,
   after reviewing pending SQL against the confirmed independent destination**.
   Check legacy objects, constraints and the `user_sessions` table as well.
3. In the destination only, arrange a separately approved sanitization of old
   login sessions, stored live integration/queue credentials, active syncs,
   monitoring schedules and pending outbound jobs. Preserve their necessary
   business history, but never reuse live connection/queue credentials.
   A source copy can include database-stored credentials even though this ZIP
   contains no secret files. Do not give unreviewed users access before checking.
4. Keep a pre-restoration target recovery point and an audit of changes. Do not
   put the snapshot or temporary exports into GitHub or this source ZIP.
5. Compare record counts to the snapshot, inspect representative records and
   check the restored schema, permissions, data ownership and historical totals.

Optional read-only inventory (run only in the new service's authorized shell):

```sh
node deployment/render/inspect-database.mjs
```

It prints table counts/missing tables, not customer rows or credentials. It does
not validate every column, foreign key, report calculation or stored file.
Only after verification set `RENDER_DATA_READY=true` in Render and redeploy.

No demo user/password is created. Login requires restored users and their
existing password hashes, or a separately approved secure administrator setup.

## 5. Validate the deployed copy

- `/` and a deep frontend path serve the built app from the same origin as `/api`.
- `/api/healthz` returns 200. Unknown API URLs remain API 404s, not frontend HTML.
- Login cookies are `HttpOnly`, `Secure`, `SameSite=Lax`; HTTPS proxy trust is
  configured. First-login password change remains available for temporary users.
- Verify admin plus a restricted Manager/Editor/Viewer. Original tab, client,
  ownership and View/Manage checks are retained; readonly mode adds a restriction.
- Inspect accounts/contacts, journey and sequence definitions, HP Analytics,
  GTM responses, sales feedback and saved news analyses against the snapshot.
- Existing storage-backed media can remain unavailable until the separate
  storage migration. Failed live connector reads are not missing database rows.
- Writes, sending, calls, imports, new research, public tracking and sync must
  remain blocked. No campaigns should resume.

Package checks (no database or external provider calls):

```sh
node --test deployment/render/package.test.mjs
corepack pnpm --filter @workspace/playforge run build
corepack pnpm --filter @workspace/api-server run build
node deployment/render/smoke.mjs
```

Some inherited parser tests need deliberately excluded customer spreadsheets.
Do not run the original unscoped full test suite against customer production data.
The included adapter tests use synthetic HTTP/session fixtures, not real logins.

## Known boundaries

This package is prepared for independent hosting, but was not deployed to your
Render account. A successful local build is not evidence of a completed database,
uploaded-file or integration migration. Restore, actual Render deployment,
authenticated verification with real destination users, storage/provider setup
and any operational activation remain separate steps.

References:
- https://render.com/docs/monorepo-support
- https://render.com/docs/configure-environment-variables
- https://render.com/docs/node-version
- https://render.com/docs/compute-plans
