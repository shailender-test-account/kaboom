import { pool } from "@workspace/db";
import { logger } from "./lib/logger";

export function startScheduledActionsRunner(): void {
  setInterval(async () => {
    try {
      const { rows } = await pool.query<{
        id: number;
        action_type: string;
        payload: { play_id: number; play_name: string };
        tenant_id: number;
      }>(
        `SELECT id, action_type, payload, tenant_id
         FROM scheduled_actions
         WHERE status = 'pending' AND execute_at <= NOW()
         ORDER BY execute_at ASC
         LIMIT 20`
      );

      for (const row of rows) {
        try {
          const { action_type, payload } = row;

          if (action_type === "pause_play" || action_type === "resume_play") {
            const newStatus = action_type === "pause_play" ? "paused" : "active";
            const { rowCount } = await pool.query(
              `UPDATE abm_plays SET status = $1, updated_at = NOW()
               WHERE id = $2 AND tenant_id = $3`,
              [newStatus, payload.play_id, row.tenant_id]
            );
            logger.info(
              { actionId: row.id, action_type, playId: payload.play_id, rowCount },
              "Scheduled play action executed"
            );
          }

          await pool.query(
            `UPDATE scheduled_actions SET status = 'executed', executed_at = NOW() WHERE id = $1`,
            [row.id]
          );
        } catch (err) {
          logger.warn({ err, actionId: row.id }, "Scheduled action execution failed");
          await pool.query(
            `UPDATE scheduled_actions SET status = 'failed', error = $2 WHERE id = $1`,
            [row.id, String(err)]
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, "Scheduled actions runner error");
    }
  }, 60_000);

  logger.info("Scheduled actions runner started (60s tick)");
}
