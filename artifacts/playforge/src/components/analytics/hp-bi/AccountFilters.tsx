import { Search } from "lucide-react";
import type { HpBiFilters } from "./types";

export default function AccountFilters({ search, qualification, gtmSource, monitoring, onMonitoring, onSearch, onQualification, onSource, onClear }: {
  search: string;
  qualification: HpBiFilters["qualification"];
  gtmSource: HpBiFilters["gtmSource"];
  monitoring?: HpBiFilters["monitoring"];
  onMonitoring?: (value: HpBiFilters["monitoring"]) => void;
  onSearch: (value: string) => void;
  onQualification: (value: HpBiFilters["qualification"]) => void;
  onSource: (value: HpBiFilters["gtmSource"]) => void;
  onClear: () => void;
}) {
  const label = "flex min-w-0 flex-col gap-1 text-[11px] font-medium text-[#41586e]";
  const control = "h-9 w-full min-w-0 rounded-md border border-[#c5d3df] bg-white px-3 text-xs text-[#0B2A4A] focus:outline-none focus:ring-2 focus:ring-[#0096D6]";
  return <div className="space-y-2" data-testid="account-search-filters">
    <div className="grid grid-cols-1 gap-3 items-end @min-[420px]:grid-cols-2 @min-[760px]:grid-cols-[2fr_1fr_1fr_1fr_auto]">
      <label className={label}>Search accounts
        <span className="relative block">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5d7388]" />
          <input aria-label="Search accounts" data-testid="input-search" type="search" maxLength={200}
            value={search} onChange={e => onSearch(e.target.value)} placeholder="Account name or HP ID" className={`${control} pl-8`} />
        </span>
      </label>
      <label className={label}>Qualification
        <select aria-label="Filter accounts by qualification" value={qualification ?? ""} className={control}
          onChange={e => onQualification((e.target.value || undefined) as HpBiFilters["qualification"])}>
          <option value="">All statuses</option><option>Hot</option><option>Warm</option><option>Cold</option>
        </select>
      </label>
      <label className={label}>GTM Source
        <select aria-label="Filter accounts by GTM source" value={gtmSource ?? ""} className={control}
          onChange={e => onSource((e.target.value || undefined) as HpBiFilters["gtmSource"])}>
          <option value="">All sources</option><option value="lead_form">Lead Form</option>
          <option value="event_feedback">Event Feedback Form</option>
        </select>
      </label>
      <label className={label}>Monitoring coverage
        <select aria-label="Filter accounts by monitoring coverage" value={monitoring ?? ""} className={control}
          onChange={e => onMonitoring?.((e.target.value || undefined) as HpBiFilters["monitoring"])}>
          <option value="">All coverage</option>
          <option value="never">Never monitored members</option>
          <option value="overdue">Overdue · 7-day rule</option>
        </select>
      </label>
      <button type="button" onClick={onClear} disabled={!search && !qualification && !gtmSource && !monitoring}
        className="h-9 rounded-md border border-[#c5d3df] bg-white px-3 text-xs text-[#41586e] disabled:opacity-40">
        Clear
      </button>
    </div>
    <p className="text-[11px] text-[#5d7388]">
      Monitoring filters match any member in the filtered parent group. Never monitored includes partial coverage.
      Overdue means never checked or last successfully checked more than 7 days ago; exactly 7 days is still fresh.
      These filters affect the account list and account CSV only, not dashboard totals. Viewing does not start research or change schedules.
    </p>
    {(qualification || gtmSource) && <p className="text-[11px] text-[#5d7388]">
      Qualification and GTM Source filter the parent account list and its account CSV, not dashboard totals.
      Source matches any valid response in the account’s history; qualification is the account’s current status.
    </p>}
  </div>;
}
