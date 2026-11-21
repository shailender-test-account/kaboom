export type MappingAction = "map" | "ignore" | "custom";

export interface ColMapping {
  action: MappingAction;
  mapTo?: string;
}

export const KABOOM_FIELDS: { key: string; label: string }[] = [
  { key: "firstName",          label: "First Name" },
  { key: "lastName",           label: "Last Name" },
  { key: "email",              label: "Email" },
  { key: "phone",              label: "Phone" },
  { key: "title",              label: "Title" },
  { key: "companyName",        label: "Company" },
  { key: "designation",        label: "Designation" },
  { key: "function",           label: "Function / Industry" },
  { key: "employeeSize",       label: "Employee Size" },
  { key: "companyRevenue",     label: "Company Revenue" },
  { key: "linkedinUrl",        label: "LinkedIn URL" },
  { key: "companyLinkedinUrl", label: "Company LinkedIn URL" },
  { key: "city",               label: "City" },
  { key: "pin",                label: "Pin" },
  { key: "state",              label: "State" },
  { key: "country",            label: "Country" },
  { key: "identifier",         label: "Identifier" },
];

export const KABOOM_FIELD_KEY_BY_LABEL: Record<string, string> = KABOOM_FIELDS.reduce(
  (acc, f) => { acc[f.label] = f.key; return acc; },
  {} as Record<string, string>,
);
