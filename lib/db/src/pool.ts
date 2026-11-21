import pg from "pg";

/** Bound connection acquisition, not SQL execution (whose outcome may be unknown). */
export function createDatabasePool(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  });
  // pg removes an errored idle client before emitting this event. Let the next
  // acquisition create a replacement; never replay SQL or end the shared pool.
  pool.on("error", error => {
    // Do not log connection strings or server messages, which can contain secrets.
    process.stderr.write(`${JSON.stringify({
      level: "error",
      event: "database_idle_connection_error",
      code: typeof (error as NodeJS.ErrnoException).code === "string"
        ? (error as NodeJS.ErrnoException).code : "UNKNOWN",
      message: "Idle database connection dropped; the pool will replace it on demand.",
    })}\n`);
  });
  return pool;
}
