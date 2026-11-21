import { expect, it } from "vitest";
import { pool } from "@workspace/db";
import { isHpClientName, hpClientNameSql } from "./hpClientScope";

it.each(["HP", " hp ", "HP India", "Hewlett-Packard", "Hewlett Packard India", "HP Inc", "HP INC.",
  "Other", "HP Enterprise", "HPX", "", "Not HP India"])("keeps SQL discovery and API eligibility identical for %j", async name => {
  const result = await pool.query(`SELECT ${hpClientNameSql("name")} AS eligible FROM (SELECT $1::text AS name) input`, [name]);
  expect(result.rows[0].eligible).toBe(isHpClientName(name));
});
