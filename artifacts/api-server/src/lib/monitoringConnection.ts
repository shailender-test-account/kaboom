import type { PoolClient } from "pg";
import { logger } from "./logger";

/** Guard a checked-out monitoring session; never replay its transaction. */
export function guardMonitoringConnection(client: PoolClient, operation: string) {
  let connectionError: Error | undefined;
  let rollbackFailed = false;
  const onError = (error: Error) => {
    connectionError = error;
    logger.warn({ operation }, "Monitoring database connection lost");
  };
  client.on("error", onError);
  return {
    check() { if (connectionError) throw connectionError; },
    async rollback() {
      if (connectionError) return;
      await client.query("ROLLBACK").catch(error => {
        rollbackFailed = true;
        logger.warn({ operation, err: error }, "Monitoring transaction rollback failed");
      });
    },
    release() {
      client.release(Boolean(connectionError || rollbackFailed));
      client.removeListener("error", onError);
    },
  };
}
