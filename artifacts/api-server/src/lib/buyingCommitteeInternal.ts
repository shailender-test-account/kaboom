import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import { committeeCountryValues } from "./buyingCommitteeCountry";

const roleAliases: Record<string, string[]> = {
  "chief information security officer": ["ciso"],
  "chief information officer": ["cio"],
  "chief operating officer": ["coo"],
  "it director": ["director of it", "director information technology", "director of information technology"],
  "head of it": ["head of information technology"],
};
const normalize = (s: string) => s.toLowerCase().replace(/\./g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Phrase-boundary matching, with explicit equivalent titles; never a fuzzy name match. */
export function committeeTitlePatterns(designations: string[]) {
  const titles = new Set(designations.map(normalize).filter(Boolean));
  for (const [title, aliases] of Object.entries(roleAliases)) {
    if (titles.has(title) || aliases.some(alias => titles.has(alias)))
      for (const value of [title, ...aliases]) titles.add(value);
  }
  return [...titles].map(title => `% ${title} %`);
}

/** Only current contacts in the exact owned legal account and selected person-country. */
export async function findInternalCommitteeContacts(tenantId: number, clientId: number, companyId: number,
  country: string, designations: string[], limit: number, connection: Pick<PoolClient, "query"> = pool) {
  const result = await connection.query<{ id: number }>(`SELECT c.id FROM contacts c
    JOIN companies co ON co.id=c.company_id AND co.tenant_id=c.tenant_id AND co.client_id=c.client_id
    WHERE c.tenant_id=$1 AND c.client_id=$2 AND c.company_id=$3
      AND NOT COALESCE(c.is_anonymous,false)
      AND lower(btrim(c.country))=ANY($4::text[])
      AND (' '||btrim(regexp_replace(lower(replace(concat_ws(' ',c.title,c.designation),'.','')), '[^[:alnum:]]+', ' ', 'g'))||' ')
        LIKE ANY($5::text[])
      AND (NULLIF(btrim(concat_ws(' ',c.first_name,c.last_name)),'') IS NOT NULL
        OR NULLIF(btrim(c.email),'') IS NOT NULL)
    ORDER BY (NULLIF(btrim(c.email),'') IS NOT NULL) DESC,c.id LIMIT $6`,
  [tenantId, clientId, companyId, committeeCountryValues(country), committeeTitlePatterns(designations), limit]);
  return result.rows.map(row => row.id);
}
