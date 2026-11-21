// Render-only entry. No seed, migration, sync or background-runner imports.
import app from "./app";
import { pool } from "@workspace/db";
import { logger } from "./lib/logger";

const port = Number(process.env.PORT);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
const server = app.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "Render validation copy listening; all background automation is disabled");
});
function shutdown() {
  server.close(() => { pool.end().finally(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
