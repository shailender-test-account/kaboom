import { configureEnvironment } from "./runtime.mjs";

try {
  configureEnvironment();
  // Dynamic import is deliberate: safety settings precede all API imports.
  await import("../../artifacts/api-server/dist/index.mjs");
} catch (error) {
  // Do not log an error object or connection string supplied by a provider.
  console.error("Render startup failed. Check required environment settings, the independent database, and build output.");
  if (error instanceof Error && /^(?:DATABASE_URL|SESSION_SECRET|BASE_URL|Use the independent|Build PlayForge)/.test(error.message)) {
    console.error(error.message);
  }
  process.exitCode = 1;
}
