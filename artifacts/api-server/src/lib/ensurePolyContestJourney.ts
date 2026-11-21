import type { Pool } from "pg";
import { logger } from "./logger";

/**
 * Idempotent startup seed: ensures the poly-contest journey exists in the DB.
 *
 * The journey was originally created only in the dev database; on production it
 * was missing, causing every GET /api/public/journeys/poly-contest and every
 * POST /api/public/journeys/poly-contest/track to return 404 and blocking all
 * visitor analytics from kaboom-ai.com/poly-contest-rescue.html.
 *
 * Design:
 *   - A CTE first resolves (or creates) the HP client for tenant 1 so that
 *     journeys.client_id (NOT NULL) is always populated.
 *   - ON CONFLICT (slug) DO NOTHING makes the journey INSERT concurrent-safe:
 *     the unique index on slug ensures only one row is created even when multiple
 *     server instances start simultaneously.
 *   - Runs on every boot and is a no-op once both rows exist.
 */
export async function ensurePolyContestJourney(pool: Pool): Promise<void> {
  try {
    // One-time repair: the user manually rebuilt the contest journey on
    // production under this exact auto-generated slug (with their
    // scenario_videos saved on it). Rename that specific row to poly-contest
    // so its data is preserved instead of seeding an empty duplicate.
    // Exact slug + tenant match — cannot touch any other journey. Errors here
    // (e.g. a concurrent seed already created poly-contest) are isolated so
    // the fallback seed below still runs.
    try {
      const adopted = await pool.query(`
        UPDATE journeys
        SET slug = 'poly-contest', status = 'published', updated_at = NOW()
        WHERE slug = '2-minute-meeting-rescue-1786861832577'
          AND tenant_id = 1
          AND NOT EXISTS (SELECT 1 FROM journeys WHERE slug = 'poly-contest')
        RETURNING id
      `);
      if (adopted.rows.length > 0) {
        logger.info({ journeyId: adopted.rows[0].id }, "ensurePolyContestJourney: adopted existing contest journey (slug renamed to poly-contest)");
        return;
      }
    } catch (adoptErr) {
      logger.warn({ err: adoptErr }, "ensurePolyContestJourney: adoption step failed (non-fatal, falling through to seed)");
    }

    // Remediation: if poly-contest exists but was left in draft status
    // (e.g. adoption renamed it without publishing), force it to published.
    try {
      const repaired = await pool.query(`
        UPDATE journeys
        SET status = 'published', updated_at = NOW()
        WHERE slug = 'poly-contest' AND tenant_id = 1 AND status != 'published'
        RETURNING id
      `);
      if (repaired.rows.length > 0) {
        logger.info({ journeyId: repaired.rows[0].id }, "ensurePolyContestJourney: repaired draft poly-contest → published");
      }
    } catch (repairErr) {
      logger.warn({ err: repairErr }, "ensurePolyContestJourney: repair step failed (non-fatal)");
    }
    await pool.query(`
      WITH existing_hp AS (
        SELECT id FROM clients
        WHERE LOWER(name) = 'hp' AND tenant_id = 1
        LIMIT 1
      ),
      new_hp AS (
        INSERT INTO clients (name, tenant_id)
        SELECT 'HP', 1
        WHERE NOT EXISTS (SELECT 1 FROM existing_hp)
        RETURNING id
      ),
      hp_client AS (
        SELECT id FROM existing_hp
        UNION ALL
        SELECT id FROM new_hp
        LIMIT 1
      )
      INSERT INTO journeys (
        client_id, name, slug, description, status, tenant_id,
        theme, header_btn_text, header_btn_type, navigation_mode,
        header_logo_show_bg, created_at, updated_at
      )
      SELECT
        hp_client.id,
        'Poly Contest',
        'poly-contest',
        'HP Poly 2-Minute Meeting Rescue contest journey',
        'published',
        1,
        'light',
        'Book a Demo',
        'url',
        'free',
        true,
        NOW(),
        NOW()
      FROM hp_client
      ON CONFLICT (slug) DO NOTHING;
    `);
  } catch (err) {
    // Log but do not crash — a missing journey seed is bad, but it should
    // not take down the server. The error will surface in logs for ops to
    // investigate.
    logger.warn({ err }, "ensurePolyContestJourney: seed failed (non-fatal)");
  }
}
