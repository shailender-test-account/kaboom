/** Configuration for the independent, read-only Render validation copy. */
export function configureEnvironment(env = process.env) {
  for (const name of ["DATABASE_URL", "SESSION_SECRET"]) {
    if (!env[name]?.trim()) throw new Error(`${name} must be configured in Render Environment.`);
  }
  if (env.SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters.");
  let database;
  try { database = new URL(env.DATABASE_URL); } catch { throw new Error("DATABASE_URL is not a valid PostgreSQL URL."); }
  if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new Error("DATABASE_URL must use PostgreSQL.");
  // This package is intentionally restricted to the new Render PostgreSQL service.
  if (!/^dpg-[a-z0-9-]+(?:\.[a-z0-9.-]+\.render\.com)?$/.test(database.hostname)) {
    throw new Error("Use the independent Render PostgreSQL connection, not an original Replit database.");
  }
  let origin;
  try {
    const url = new URL(env.BASE_URL || env.RENDER_EXTERNAL_URL || "");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw 0;
    origin = url.origin;
  } catch { throw new Error("BASE_URL must be the new app's HTTPS origin with no path or credentials."); }
  if (/(?:^|\.)(?:replit\.(?:app|dev)|kaboomremix\.com)$/.test(new URL(origin).hostname)) {
    throw new Error("BASE_URL must identify the independent Render copy, not the original app.");
  }
  env.BASE_URL = origin;
  env.USER_WELCOME_BASE_URL = origin;
  env.BASE_PATH = "/";
  env.NODE_ENV = "production";
  env.COPIED_DATA_SAFE_MODE = "true";
  for (const name of ["MONITORING_RESEARCH_ENABLED", "HP_WARM_JOURNEY_ROUTING_ENABLED",
    "HP_RULE_SEQUENCE_ROUTING_ENABLED", "SALES_FEEDBACK_SYNC_ENABLED",
    "USER_WELCOME_EMAIL_ENABLED", "AUTO_APPLY_SCHEMA_DRIFT"]) env[name] = "false";
  // Managed proxies, buckets and shared queues are not portable credentials.
  for (const name of ["REPLIT_CONNECTORS_HOSTNAME", "CONNECTORS_HOSTNAME", "UPSTASH_REDIS_URL",
    "AI_INTEGRATIONS_OPENAI_BASE_URL", "AI_INTEGRATIONS_OPENAI_API_KEY",
    "PRIVATE_OBJECT_DIR", "PUBLIC_OBJECT_SEARCH_PATHS"]) delete env[name];
  return origin;
}
