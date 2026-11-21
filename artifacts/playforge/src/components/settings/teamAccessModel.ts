import { SECTIONS, sectionLevel } from "@workspace/api-zod";
import type { AccessLevel, SectionKey, SectionPermissions } from "@workspace/api-zod";

export const ROLES = ["admin", "manager", "editor", "viewer"] as const;
export type Role = typeof ROLES[number];
export const LEVELS: AccessLevel[] = ["none", "view", "manage"];

/** Settings team/user management is always admin-only, regardless of the matrix. */
export const ADMIN_ONLY_SECTIONS: SectionKey[] = [];

/** Resolve a full, explicit matrix for editing (null permissions resolve to legacy role defaults). */
export function resolveMatrix(role: string, perms: SectionPermissions | null | undefined): Record<SectionKey, AccessLevel> {
  const out = {} as Record<SectionKey, AccessLevel>;
  for (const [key] of SECTIONS) out[key] = sectionLevel({ role, sectionPermissions: perms ?? null }, key);
  return out;
}

/** Build the explicit map to send: omit "none" keys (omitted means none). */
export function toPermissions(matrix: Record<SectionKey, AccessLevel>): SectionPermissions {
  const out: SectionPermissions = {};
  for (const [key] of SECTIONS) if (matrix[key] && matrix[key] !== "none") out[key] = matrix[key];
  return out;
}

export function fillMatrix(level: AccessLevel): Record<SectionKey, AccessLevel> {
  const out = {} as Record<SectionKey, AccessLevel>;
  for (const [key] of SECTIONS) out[key] = level;
  return out;
}

export function errorMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === "string" && data.error) return data.error;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function sameMatrix(a: Record<string, string>, b: Record<string, string>) {
  return SECTIONS.every(([k]) => a[k] === b[k]);
}
