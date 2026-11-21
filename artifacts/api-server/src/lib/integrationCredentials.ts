import { pool } from "@workspace/db";
import {
  CredentialStoreError, decryptIntegrationConfig, encryptIntegrationConfig, needsCredentialRewrite,
} from "./credentialCipher";

export { CredentialStoreError } from "./credentialCipher";

export async function getIntegrationConfig(tenantId: number, provider: string): Promise<Record<string, any> | null> {
  try {
    const result = await pool.query<{ config: Record<string, any> }>(
      "SELECT config FROM tenant_integrations WHERE tenant_id=$1 AND provider=$2 LIMIT 1",
      [tenantId, provider],
    );
    const config = result.rows[0]?.config;
    return config ? decryptIntegrationConfig(tenantId, provider, config) : null;
  } catch {
    // Database errors may contain query parameters. Do not propagate their details.
    throw new CredentialStoreError();
  }
}

export async function saveIntegrationConfig(tenantId: number, provider: string, config: Record<string, any>): Promise<void> {
  const encrypted = encryptIntegrationConfig(tenantId, provider, config);
  try {
    await pool.query(`INSERT INTO tenant_integrations (tenant_id,provider,config,updated_at)
      VALUES ($1,$2,$3::jsonb,NOW()) ON CONFLICT (tenant_id,provider)
      DO UPDATE SET config=EXCLUDED.config,updated_at=NOW()`, [tenantId, provider, JSON.stringify(encrypted)]);
  } catch {
    throw new CredentialStoreError();
  }
}

/**
 * Explicit operator operation only. Never invoked at startup, from reads, or by a scheduler.
 * Row locks serialize rotation/migration with ordinary UPSERTs; no plaintext enters SQL.
 * A transaction failure leaves the original record intact.
 */
export async function rewriteIntegrationCredentials(
  tenantId: number, provider: string, mode: "migrate" | "rotate", apply = false,
): Promise<"absent" | "unchanged" | "would-change" | "changed"> {
  needsCredentialRewrite({}, mode);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT config FROM tenant_integrations WHERE tenant_id=$1 AND provider=$2 FOR UPDATE", [tenantId, provider]);
    const config = result.rows[0]?.config;
    let status: "absent" | "unchanged" | "would-change" | "changed" = "absent";
    if (config) {
      // Verify decryption even for already-current records before declaring success.
      const resolved = decryptIntegrationConfig(tenantId, provider, config);
      if (!needsCredentialRewrite(config, mode) || provider === "elevenlabs") status = "unchanged";
      else {
        const encrypted = encryptIntegrationConfig(tenantId, provider, resolved);
        status = apply ? "changed" : "would-change";
        if (apply) await client.query(
          "UPDATE tenant_integrations SET config=$3::jsonb,updated_at=NOW() WHERE tenant_id=$1 AND provider=$2",
          [tenantId, provider, JSON.stringify(encrypted)],
        );
      }
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return status;
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new CredentialStoreError();
  } finally {
    client.release();
  }
}
