// ISO region codes keep person-country selection finite and separate from employer HQ.
const codes = `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(" ");
const names = new Intl.DisplayNames(["en"], { type: "region" });
const extra: Record<string, string[]> = {
  US: ["USA", "U.S.A.", "United States of America"], GB: ["UK", "U.K.", "Great Britain"],
  TR: ["Turkey"], CZ: ["Czech Republic"], KR: ["South Korea", "Republic of Korea"],
  VN: ["Viet Nam"], RU: ["Russian Federation"], TW: ["Taiwan"],
};
const entries = codes.map(code => ({ code, name: names.of(code)!, aliases: extra[code] ?? [] }));
const key = (value: string) => value.trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const lookup = new Map(entries.flatMap(e => [e.code, e.name, ...e.aliases].map(v => [key(v), e] as const)));
export const committeeCountries = entries.map(e => e.name).sort((a, b) => a.localeCompare(b, "en"));
export const committeeCountry = (value: unknown) => typeof value === "string" ? lookup.get(key(value))?.name : undefined;
export function committeeCountryValues(country?: string): string[] | null {
  if (!country) return null;
  const entry = lookup.get(key(country));
  if (!entry) throw Object.assign(new Error("Select a valid contact country."), { status: 400 });
  return [entry.name, entry.code, ...entry.aliases].map(v => v.toLowerCase());
}
