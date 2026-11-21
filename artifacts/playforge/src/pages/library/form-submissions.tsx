import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, Download, Users, TrendingUp, Clock,
  User, Mail, Loader2, ClipboardList, FileText, Eye, ChevronDown, ChevronRight,
  Search, X, Filter,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SubmissionStats {
  total: number;
  unique_contacts: number;
  last_7d: number;
  last_30d: number;
  page_views: number;
  conversion_rate: number | null;
}

interface OverTimeEntry { day: string; count: number; }

interface Submission {
  id: number;
  submittedAt: string;
  visitorToken: string | null;
  fieldValues: Record<string, unknown>;
  actionType: string | null;
  journeyId: number | null;
  pageId: number | null;
  contactId: number | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  tags: string[] | null;
  leadScore: number | null;
  journeyName: string | null;
}

interface JourneyOption { id: number; name: string; }

interface SubmissionsData {
  form: { id: number; name: string };
  stats: SubmissionStats;
  overTime: OverTimeEntry[];
  journeys: JourneyOption[];
  submissions: Submission[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) return <span className="text-muted-foreground text-xs">—</span>;
  const cls =
    score >= 75 ? "bg-red-100 text-red-700 border-red-200" :
    score >= 50 ? "bg-orange-100 text-orange-700 border-orange-200" :
    score >= 25 ? "bg-blue-100 text-blue-700 border-blue-200" :
    "bg-gray-100 text-gray-600 border-gray-200";
  return <span className={cn("text-[11px] font-semibold px-1.5 py-0.5 rounded border", cls)}>{score}</span>;
}

function FieldValuesPreview({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values).filter(([, v]) => v !== "" && v != null && v !== false);
  if (!entries.length) return <span className="text-muted-foreground text-xs italic">empty</span>;
  return (
    <div className="space-y-0.5">
      {entries.slice(0, 2).map(([k, v]) => (
        <div key={k} className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/70">{k}:</span>{" "}
          {String(v).slice(0, 35)}{String(v).length > 35 ? "…" : ""}
        </div>
      ))}
      {entries.length > 2 && (
        <div className="text-[10px] text-muted-foreground italic">+{entries.length - 2} more fields</div>
      )}
    </div>
  );
}

function FieldValuesExpanded({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values).filter(([, v]) => v !== "" && v != null && v !== false);
  if (!entries.length) return <p className="text-xs text-muted-foreground italic">No field values recorded.</p>;
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{k}</dt>
          <dd className="text-xs text-foreground mt-0.5 break-words">{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon, label, value, sub, color,
}: { icon: React.ElementType; label: string; value: number | string; sub?: string; color: string }) {
  return (
    <div className="bg-card border rounded-xl p-4 flex items-start gap-3">
      <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center shrink-0", color)}>
        <Icon className="w-4.5 h-4.5" />
      </div>
      <div>
        <p className="text-2xl font-bold leading-none">{value}</p>
        <p className="text-xs text-muted-foreground mt-1">{label}</p>
        {sub && <p className="text-[11px] text-muted-foreground/70 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ── Custom chart tooltip ───────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover border rounded-lg shadow-lg px-3 py-2 text-sm">
      <p className="font-medium">{label}</p>
      <p className="text-indigo-600">{payload[0].value} submission{payload[0].value !== 1 ? "s" : ""}</p>
    </div>
  );
}

// ── FormSubmissionsPage ────────────────────────────────────────────────────────

export default function FormSubmissionsPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const formId = parseInt(id);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  // Filter state
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [journeyId, setJourneyId] = useState("");

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const hasFilters = search !== "" || fromDate !== "" || toDate !== "" || journeyId !== "";

  const clearFilters = useCallback(() => {
    setSearchInput("");
    setSearch("");
    setFromDate("");
    setToDate("");
    setJourneyId("");
  }, []);

  // Build query string
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (fromDate) params.set("from", fromDate);
  if (toDate) params.set("to", toDate);
  if (journeyId) params.set("journeyId", journeyId);
  const qs = params.toString();

  const { data, isLoading, error } = useQuery<SubmissionsData>({
    queryKey: ["form-submissions", formId, search, fromDate, toDate, journeyId],
    queryFn: async () => {
      const url = `/api/journey-forms/${formId}/submissions${qs ? `?${qs}` : ""}`;
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(`Failed: ${r.status}`);
      return r.json();
    },
    enabled: !isNaN(formId),
  });

  function handleExport() {
    const exportQs = qs ? `?${qs}` : "";
    window.open(`/api/journey-forms/${formId}/submissions/export${exportQs}`, "_blank");
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 text-center text-destructive">
        Failed to load submissions.
      </div>
    );
  }

  const { form, stats, overTime, journeys, submissions } = data;

  // Fill in missing days in overTime chart
  const chartData: { day: string; count: number }[] = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dayStr = d.toISOString().slice(0, 10);
    const found = overTime.find(e => e.day.slice(0, 10) === dayStr);
    chartData.push({
      day: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      count: found?.count ?? 0,
    });
  }
  const hasChartData = chartData.some(d => d.count > 0);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate("/library/forms")}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="w-9 h-9 bg-violet-100 rounded-lg flex items-center justify-center shrink-0">
            <ClipboardList className="w-5 h-5 text-violet-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{form.name}</h1>
            <p className="text-sm text-muted-foreground">Form submissions &amp; conversions</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={handleExport}
          disabled={stats.total === 0}
        >
          <Download className="w-3.5 h-3.5" />
          Export CSV
        </Button>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={FileText}
          label="Total submissions"
          value={stats.total}
          color="bg-indigo-100 text-indigo-600"
        />
        <StatCard
          icon={Users}
          label="Unique contacts"
          value={stats.unique_contacts}
          sub={stats.total > 0 ? `${Math.round((stats.unique_contacts / stats.total) * 100)}% unique rate` : undefined}
          color="bg-violet-100 text-violet-600"
        />
        <StatCard
          icon={Eye}
          label="Page views"
          value={stats.page_views ?? 0}
          sub={stats.conversion_rate != null ? `${stats.conversion_rate}% conversion rate` : "Not yet deployed on a page"}
          color="bg-sky-100 text-sky-600"
        />
        <StatCard
          icon={TrendingUp}
          label="Conversion rate"
          value={stats.conversion_rate != null ? `${stats.conversion_rate}%` : "—"}
          sub={stats.conversion_rate != null ? `${stats.total} submissions / ${stats.page_views} views` : "No page views recorded yet"}
          color="bg-emerald-100 text-emerald-600"
        />
      </div>

      {/* Over-time chart */}
      <div className="bg-card border rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-4">Submissions over last 30 days</h2>
        {hasChartData ? (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                tickLine={false}
                axisLine={false}
                interval={4}
              />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="count" fill="#6366f1" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[180px] flex items-center justify-center text-sm text-muted-foreground">
            No submissions in the last 30 days
          </div>
        )}
      </div>

      {/* Submissions table */}
      <div className="bg-card border rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              Submissions
              {stats.total > 0 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {hasFilters
                    ? `(${submissions.length} filtered of ${stats.total} total)`
                    : `(${stats.total} total${stats.total > 200 ? ", showing latest 200" : ""})`}
                </span>
              )}
            </h2>
            {hasFilters && (
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground" onClick={clearFilters}>
                <X className="w-3 h-3" />
                Clear filters
              </Button>
            )}
          </div>

          {/* Filter bar */}
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search contact name or email…"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                className="pl-8 h-8 text-xs"
              />
              {searchInput && (
                <button
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => { setSearchInput(""); setSearch(""); }}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground shrink-0">From</span>
              <Input
                type="date"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                className="h-8 text-xs w-36"
              />
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground shrink-0">To</span>
              <Input
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                className="h-8 text-xs w-36"
              />
            </div>

            {journeys && journeys.length > 0 && (
              <Select value={journeyId || "__all"} onValueChange={v => setJourneyId(v === "__all" ? "" : v)}>
                <SelectTrigger className="h-8 text-xs w-44 gap-1">
                  <Filter className="w-3 h-3 text-muted-foreground shrink-0" />
                  <SelectValue placeholder="All journeys" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">All journeys</SelectItem>
                  {journeys.map(j => (
                    <SelectItem key={j.id} value={String(j.id)}>{j.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        {submissions.length === 0 ? (
          <div className="py-16 text-center">
            <ClipboardList className="w-8 h-8 text-muted-foreground/20 mx-auto mb-3" />
            {hasFilters ? (
              <>
                <p className="text-sm font-medium text-muted-foreground">No submissions match your filters</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Try adjusting the search or date range.
                </p>
                <Button variant="ghost" size="sm" className="mt-3 text-xs" onClick={clearFilters}>
                  Clear filters
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-muted-foreground">No submissions yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  When visitors fill out this form in a journey, they'll appear here.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="w-6 px-3 py-2.5" />
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Contact</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Email</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Score</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Tags</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Journey</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Field Values</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map(sub => {
                  const isExpanded = expandedRow === sub.id;
                  const fv = (sub.fieldValues as Record<string, unknown>) ?? {};
                  return (
                    <>
                      <tr
                        key={sub.id}
                        className={cn(
                          "border-b border-border/60 cursor-pointer transition-colors",
                          isExpanded ? "bg-muted/30" : "hover:bg-muted/20",
                        )}
                        onClick={() => setExpandedRow(isExpanded ? null : sub.id)}
                      >
                        {/* Expand chevron */}
                        <td className="px-3 py-3 text-muted-foreground">
                          {isExpanded
                            ? <ChevronDown className="w-3.5 h-3.5" />
                            : <ChevronRight className="w-3.5 h-3.5" />}
                        </td>
                        {/* Contact */}
                        <td className="px-4 py-3">
                          {sub.contactId ? (
                            <div className="flex items-center gap-2">
                              <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                                <User className="w-3 h-3 text-indigo-600" />
                              </div>
                              <span className="font-medium text-xs">
                                {sub.firstName} {sub.lastName}
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">Anonymous</span>
                          )}
                        </td>
                        {/* Email */}
                        <td className="px-4 py-3">
                          {sub.email ? (
                            <div className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Mail className="w-3 h-3 shrink-0" />
                              <span>{sub.email}</span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        {/* Score */}
                        <td className="px-4 py-3">
                          <ScoreBadge score={sub.leadScore} />
                        </td>
                        {/* Tags */}
                        <td className="px-4 py-3">
                          {sub.tags && sub.tags.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {sub.tags.slice(0, 2).map(t => (
                                <Badge key={t} variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-normal">
                                  {t}
                                </Badge>
                              ))}
                              {sub.tags.length > 2 && (
                                <span className="text-[10px] text-muted-foreground">+{sub.tags.length - 2}</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        {/* Journey */}
                        <td className="px-4 py-3">
                          <span className="text-xs text-muted-foreground">
                            {sub.journeyName ?? "—"}
                          </span>
                        </td>
                        {/* Field Values preview */}
                        <td className="px-4 py-3 max-w-[200px]">
                          <FieldValuesPreview values={fv} />
                        </td>
                        {/* Submitted */}
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Clock className="w-3 h-3 shrink-0" />
                            <div>
                              <div>{fmtDate(sub.submittedAt)}</div>
                              <div className="text-[10px]">{fmtTime(sub.submittedAt)}</div>
                            </div>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${sub.id}-expanded`} className="border-b border-border/60 bg-muted/10">
                          <td />
                          <td colSpan={7} className="px-6 py-4">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">All submitted fields</p>
                            <FieldValuesExpanded values={fv} />
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
