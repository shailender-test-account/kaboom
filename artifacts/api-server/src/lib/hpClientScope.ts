/** One eligibility policy for HP API reads and background operational sweeps. */
export const HP_CLIENT_NAME_PATTERN = "^(hp|hp india|hewlett[ -]packard( india)?|hp inc[.]?)$";
const hpName = new RegExp(HP_CLIENT_NAME_PATTERN, "i");
export const isHpClientName = (name: unknown) => hpName.test(String(name ?? "").trim());
/** Column names are internal constants, never request input. */
export const hpClientNameSql = (column: "name" | "cl.name") =>
  `btrim(${column}) ~* '${HP_CLIENT_NAME_PATTERN}'`;
