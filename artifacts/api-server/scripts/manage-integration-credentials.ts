import { pool } from "@workspace/db";
import { integrationProviders, CredentialStoreError } from "../src/lib/credentialCipher";
import { rewriteIntegrationCredentials } from "../src/lib/integrationCredentials";

// No key or credential values are accepted through command-line arguments.
const args = process.argv.slice(2);
const allowed = ["--tenant", "--provider", "--mode", "--apply", "--approved-storage-change"];
function value(flag: string) { return args[args.indexOf(flag) + 1]; }
async function main() {
  for (let i = 0; i < args.length; i++) {
    if (!allowed.includes(args[i])) throw new Error("Invalid argument");
    if (["--tenant", "--provider", "--mode"].includes(args[i])) i++;
  }
  if (!args.includes("--tenant") || !args.includes("--provider") || !args.includes("--mode")) throw new Error("Missing scope");
  const tenantId = Number(value("--tenant")), provider = value("--provider"), mode = value("--mode");
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || !integrationProviders.includes(provider as any)
    || !["migrate", "rotate"].includes(mode)) throw new Error("Invalid scope");
  const apply = args.includes("--apply");
  if (apply && !args.includes("--approved-storage-change")) throw new Error("Approval required");
  const status = await rewriteIntegrationCredentials(tenantId, provider, mode as "migrate" | "rotate", apply);
  console.log(JSON.stringify({ tenantId, provider, mode, apply, status }));
}
try {
  await main();
} catch (err) {
  // Do not print errors from DB/drivers or command-line input.
  console.error(err instanceof CredentialStoreError ? err.message :
    "Credential operation not performed. Check scope, mode and explicit storage-change approval. See docs/integration-credentials.md.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
