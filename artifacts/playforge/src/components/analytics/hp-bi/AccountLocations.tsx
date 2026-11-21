import { gccSourceRows, type GccMember } from "./GccProfiling";

const city = (value: unknown) => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^(?:|-|n\/?a|null|none|not supplied|not available)$/i.test(text) ? null : text;
};
const uniqueCities = (values: unknown[]) => {
  const seen = new Set<string>();
  return values.flatMap(value => {
    const name = city(value);
    if (!name || seen.has(name.toLowerCase())) return [];
    seen.add(name.toLowerCase());
    return [name];
  });
};

/** Contact locations are evidence, not corrections to a legal account's address. */
export default function AccountLocations({ members }: { members: GccMember[] }) {
  const accountCities = uniqueCities(members.map(m => city(m.dimensions.city) ?? m.dimensions.CITY));
  const contactCities = uniqueCities(gccSourceRows(members).map(r => r.record.values.city));
  return <div data-testid="account-locations" className="space-y-1">
    {!accountCities.length && !contactCities.length && <span>Not available</span>}
    {!!accountCities.length && <div>{accountCities.join(", ")} <span className="text-[11px] font-normal text-[#5d7388]">(account profile)</span></div>}
    {!!contactCities.length && <div>{contactCities.join(", ")} <span className="text-[11px] font-normal text-[#5d7388]">(GCC contact locations)</span></div>}
  </div>;
}
