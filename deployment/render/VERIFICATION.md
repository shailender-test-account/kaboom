# Local verification and remaining deployment checks

The isolated packaged application, not the running Replit app, was checked.

## Passed here

- Locked pnpm 10.26.1 workspace installation from the local package cache.
  Local verification used `--offline --ignore-scripts --prod=false`; Render's
  normal online installation and any native install scripts still need its
  build logs checked.
- Shared-library TypeScript build.
- API and PlayForge TypeScript checks.
- PlayForge production build and API production bundle.
- 11 adapter regressions: independent host/config validation, forced pause flags,
  frontend/assets/deep routes, API separation, private-file denial, restoration
  gate, HTTPS secure session-cookie behavior, allowed authentication/report
  requests, blocked writes/tracking and cross-origin changes.
- Actual compiled-server smoke check with a synthetic unavailable database host,
  synthetic session secret, and no real database or provider credentials:
  process health 200, built frontend and entry asset 200, deep frontend route
  200, login correctly gated 503, and `.env` 404.
- ZIP integrity, migration-journal completeness, source-literal credential-shape
  scan, and per-file SHA-256 manifest verification.
- Adaptations were made only in the generated copy. The original runtime source,
  managed services and databases were not changed or restarted.

Existing non-blocking frontend sourcemap/bundle-size warnings remain.

## Not performed

- Comparing this source against the latest private GitHub branch/commit.
- Pushing to GitHub, connecting a Render account, creating paid services or
  performing an actual Render deployment.
- Accessing, exporting, restoring, updating or inspecting a real database.
- Restoring uploaded files or porting Replit connector/storage implementations.
- Real user login, full restored-schema verification, or checking real customer
  analytics totals in the destination.
- Sending email, placing calls, executing sequences, syncing Drive or running
  paid research.

Source hashes identify the tested application code. Builds, caches and
node_modules are deliberately not included in the final ZIP.
