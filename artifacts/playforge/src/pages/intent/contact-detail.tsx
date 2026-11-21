import { useProgressiveIntentContact, useIntentContactScoreBreakdown } from "@/hooks/use-intent";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Phone, Mail, Building2, TrendingUp, Activity, ChevronLeft, Target } from "lucide-react";
import { Link, useLocation } from "wouter";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { IntentPageHeader, TierBadge } from "@/components/intent/ui";
import { IntentDetailPanel } from "@/components/intent/detail-panel";
import { getScopeParams } from "@/lib/intent-scope";
import { formatReportDate } from "@/lib/reportTime";
import ContactEngagementEvidence from "@/components/intent/ContactEngagementEvidence";

export default function IntentContactPage({ id }: { id: string }) {
  const [location] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const qs = searchParams.toString();
  const intentListUrl = `/intent/contacts${qs ? `?${qs}` : ''}`;

  const scopeParams = getScopeParams(searchParams);

  const { data: contact, identity, evidence, analysis, recommendations } = useProgressiveIntentContact(id, scopeParams);
  const { isPending: isLoading, isError, error } = identity;
  const scoreBreakdown = useIntentContactScoreBreakdown(id, scopeParams, identity.isSuccess);

  if (isLoading) {
    return <div className="p-6 max-w-[1200px] mx-auto"><Skeleton className="h-32 w-full mb-6 rounded-lg" /><Skeleton className="h-64 w-full rounded-lg" /></div>;
  }

  if (isError || !contact) {
    return (
      <div className="p-6 max-w-5xl mx-auto text-center py-20 font-sans">
        <AlertCircle className="w-10 h-10 text-rose-300 mx-auto mb-4" />
        <h2 className="text-lg font-bold text-stone-900">{isError ? "Failed to load contact" : "Contact not found"}</h2>
        {isError && <p className="text-sm font-semibold text-stone-500 mt-1">{error?.message}</p>}
        {isError && <button className="mt-4 text-sm font-bold underline" onClick={() => void identity.refetch()}>Retry contact details</button>}
        <Link href={intentListUrl} className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-emerald-700 hover:text-emerald-800 transition-colors">
          <ChevronLeft className="w-4 h-4" /> Return to Contacts
        </Link>
      </div>
    );
  }

  const chartData = (contact.scoreHistory || []).map((h: any) => ({
    date: formatReportDate(h.date),
    score: h.score,
  }));

  const initials = contact.name.split(' ').map((n: string) => n[0]).join('').substring(0, 2).toUpperCase();
  const kaboomEvidence = contact.evidence?.contactKaboom ?? [];
  const externalEvidence = [
    ...(contact.evidence?.public ?? []),
    ...(contact.evidence?.uploaded ?? []),
    ...(contact.signals ?? []),
  ];

  return (
    <div className="min-h-[100dvh] min-w-0 max-w-full bg-stone-50 flex flex-col font-sans text-stone-900">
      <IntentPageHeader
        title={<span className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-[#0F2B20] text-white flex items-center justify-center text-xs font-bold shrink-0 shadow-sm">
            {initials}
          </div>
          {contact.name}
        </span>}
        subtitle={
          <div className="flex flex-wrap items-center gap-4 text-xs font-semibold text-stone-500 mt-2">
            <span className="flex items-center gap-1.5">{contact.title || "No Title"}</span>
            {contact.companyId ? <Link href={`/intent/accounts/${contact.companyId}${qs ? `?${qs}` : ''}`} className="flex items-center gap-1.5 hover:text-emerald-700 transition-colors">
              <Building2 className="w-3.5 h-3.5" /> {contact.companyName || "Account"}
            </Link> : <span>No linked account</span>}
          </div>
        }
        breadcrumbs={<Link href={intentListUrl} className="hover:text-stone-900 flex items-center gap-1 transition-colors"><ChevronLeft className="w-3.5 h-3.5" /> Buying Contacts</Link>}
        actions={
          <div className="flex items-center gap-4 bg-stone-50 border border-stone-200 px-4 py-2 rounded">
            <IntentDetailPanel query={analysis} label="Contact score">
            <div className="flex flex-col text-right">
              <span className="text-[10px] uppercase tracking-widest font-bold text-stone-400">Score</span>
              <span className="text-stone-900 text-xl font-black tabular-nums leading-none">{contact.score}</span>
            </div>
            <div className="w-px h-8 bg-stone-200"></div>
            <div className="flex flex-col gap-1 items-start">
              <TierBadge tier={contact.tierLabel ?? ""} />
            </div>
            </IntentDetailPanel>
          </div>
        }
      />

      <div className="flex-1 min-w-0 max-w-[1200px] mx-auto w-full p-6 space-y-6">

        <div className="bg-white border border-stone-200 rounded-lg shadow-sm overflow-hidden flex flex-wrap items-center gap-6 p-5">
          {contact.email && (
            <a href={`mailto:${contact.email}`} className="flex min-w-0 items-center gap-2 break-all text-sm font-bold text-stone-700 hover:text-emerald-700 transition-colors">
              <Mail className="w-4 h-4 text-stone-400" /> {contact.email}
            </a>
          )}
          {contact.phone && (
            <a href={`tel:${contact.phone}`} className="flex items-center gap-2 text-sm font-bold text-stone-700 hover:text-emerald-700 transition-colors">
              <Phone className="w-4 h-4 text-stone-400" /> {contact.phone}
            </a>
          )}
          {!contact.email && !contact.phone && (
            <span className="text-sm font-bold text-stone-400">No contact info available</span>
          )}
        </div>

        <section className="rounded-lg border border-emerald-200 bg-white shadow-sm" aria-label="Additive score breakdown">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-100 bg-emerald-50/50 px-4 py-3">
            <div>
              <h2 className="text-[10px] font-black uppercase tracking-widest text-emerald-900">Additive score breakdown</h2>
              <p className="mt-1 text-[10px] font-medium text-stone-600">Separate from the validated 0–100 intent score above.</p>
            </div>
            {!scoreBreakdown.isLoading && !scoreBreakdown.isError && scoreBreakdown.data && (
              <div className="text-right">
                <p className="text-[9px] font-black uppercase tracking-widest text-stone-500">Additive total</p>
                <p className="text-xl font-black tabular-nums leading-none text-emerald-800" data-testid="text-additive-contact-total">{scoreBreakdown.data.total}</p>
              </div>
            )}
          </div>
          <div className="px-4 py-3">
            {scoreBreakdown.isLoading ? (
              <div className="space-y-2" aria-label="Loading additive score breakdown">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-36" />
              </div>
            ) : scoreBreakdown.isError ? (
              <p role="alert" className="text-[11px] font-semibold text-rose-700">
                Failed to load additive score breakdown{scoreBreakdown.error?.message ? `: ${scoreBreakdown.error.message}` : "."}
                {" "}<button className="font-bold underline" onClick={() => void scoreBreakdown.refetch()}>Retry additive score breakdown</button>
              </p>
            ) : scoreBreakdown.data ? (
              <>
                <p className="text-[11px] font-semibold text-stone-700">
                  Journey points {scoreBreakdown.data.journeyPoints} + affinity points {scoreBreakdown.data.affinityPoints} = additive total {scoreBreakdown.data.total}
                </p>
                {scoreBreakdown.data.affinities.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {scoreBreakdown.data.affinities.map(affinity => (
                      <span key={affinity} className="rounded border border-stone-200 bg-stone-50 px-2 py-1 text-[9px] font-bold text-stone-600">{affinity}</span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-[10px] font-medium text-stone-400">No affinity points or labels.</p>
                )}
              </>
            ) : (
              <p className="text-[11px] font-medium text-stone-500">No additive score breakdown is available.</p>
            )}
          </div>
        </section>

        <ContactEngagementEvidence key={`${id}:${JSON.stringify(scopeParams)}`} id={id} scope={scopeParams} enabled={identity.isSuccess} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="min-w-0 overflow-hidden bg-white border border-stone-200 rounded-lg shadow-sm flex flex-col h-[400px]">
            <div className="px-5 py-4 border-b border-stone-200 bg-stone-50/50 flex items-center justify-between">
              <h2 className="text-sm font-bold text-stone-900 flex items-center gap-2"><Activity className="w-4 h-4 shrink-0 text-emerald-600" /> Score evidence &amp; account research</h2>
            </div>
            <div className="p-0 flex-1 overflow-y-auto">
              <IntentDetailPanel query={evidence} label="Supporting evidence">
              <div className="divide-y divide-stone-100">
                {(!kaboomEvidence.length && !externalEvidence.length) ? (
                  <p className="p-8 text-xs font-semibold text-center text-stone-400">No recent evidence signals.</p>
                ) : (
                  <>
                    {kaboomEvidence.map((s: any, i: number) => (
                      <div key={`k-${i}`} className="p-5 hover:bg-stone-50 transition-colors bg-white group">
                        <div className="flex items-start justify-between mb-1.5 gap-4">
                          <div className="flex min-w-0 items-start gap-2.5">
                            <Activity className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                            <span className="min-w-0 break-words font-bold text-[13px] text-stone-900 leading-snug">{s.summary}</span>
                          </div>
                          <span className="text-[10px] font-bold tracking-widest uppercase text-stone-400 shrink-0">
                            {formatReportDate(s.capturedAt)}
                          </span>
                        </div>
                        <p className="text-[11px] font-medium text-stone-500 ml-6.5">
                          Source: <span className="font-bold text-stone-700">Kaboom Journey</span>
                           {s.contribution != null && <span> · {s.contribution} points</span>}
                        </p>
                         {s.details && <details className="mt-2 text-xs text-stone-500"><summary>Activity details</summary><pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify(s.details, null, 2)}</pre></details>}
                      </div>
                    ))}
                    {externalEvidence.map((s: any, i: number) => (
                      <div key={`e-${i}`} className="p-5 hover:bg-stone-50 transition-colors bg-stone-50/30 group">
                        <p className="mb-2 text-[10px] font-semibold text-stone-500">Account / external context · not evidence of this contact’s engagement</p>
                        <div className="flex items-start justify-between mb-1.5 gap-4">
                          <div className="flex min-w-0 items-start gap-2.5">
                            <Target className="w-4 h-4 text-stone-400 shrink-0 mt-0.5" />
                            <span className="min-w-0 break-words font-bold text-[13px] text-stone-900 leading-snug">{s.summary || s.excerpt || s.title || s.typeLabel || s.eventType}</span>
                          </div>
                          <span className="text-[10px] font-bold tracking-widest uppercase text-stone-400 shrink-0">
                            {formatReportDate(s.eventDate || s.capturedAt || s.occurredAt)}
                          </span>
                        </div>
                        <p className="text-[11px] font-medium text-stone-500 ml-6.5">
                          Source: <span className="font-bold text-stone-700">{s.source || s.provider || s.evidenceKind || "Evidence"}</span>
                          {s.productName && <span> · {s.productName}</span>}
                          {s.reviewStatus && <span> · {s.reviewStatus}</span>}
                        </p>
                        {s.sourceUrl && <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs font-semibold text-emerald-700 underline">View source</a>}
                        {(s.context || s.rawPayload || s.rawEvidence) && <details className="mt-2 text-xs text-stone-500"><summary>Evidence details</summary><pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify({ context: s.context, payload: s.rawPayload, rawEvidence: s.rawEvidence }, null, 2)}</pre></details>}
                      </div>
                    ))}
                  </>
                )}
              </div>
              </IntentDetailPanel>
            </div>
          </div>

          <div className="min-w-0 overflow-hidden bg-white border border-stone-200 rounded-lg shadow-sm flex flex-col h-[400px]">
            <div className="px-5 py-4 border-b border-stone-200 bg-stone-50/50 flex items-center justify-between">
              <h2 className="text-sm font-bold text-stone-900 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-600" /> 30-Day Activity Trend</h2>
            </div>
            <div className="min-w-0 p-5 flex-1">
              <IntentDetailPanel query={evidence} label="Activity trend">
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f5f5f4" />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fontWeight: 700, fill: '#a8a29e' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fontWeight: 700, fill: '#a8a29e' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ borderRadius: '6px', border: '1px solid #e7e5e4', boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.05)', fontSize: '12px', fontWeight: 600 }} />
                    <Line type="monotone" dataKey="score" stroke="#059669" strokeWidth={2} dot={{ r: 3, strokeWidth: 0, fill: '#059669' }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs font-semibold text-stone-400">Not enough data to display trend</div>
              )}
              </IntentDetailPanel>
            </div>
          </div>
        </div>
        <section className="rounded-lg border border-stone-200 bg-white shadow-sm" aria-label="Contact recommendations">
          <h2 className="border-b border-stone-100 px-5 py-4 text-sm font-bold">Recommendations</h2>
          <IntentDetailPanel query={recommendations} label="Recommendations">
            {contact.recommendations?.length ? <div className="divide-y divide-stone-100">
              {contact.recommendations.map(item => <article key={item.id} className="p-5">
                <h3 className="text-sm font-bold">{item.title}</h3>
                <p className="mt-1 text-xs text-stone-600">{item.summary}</p>
                <p className="mt-2 text-xs text-stone-500">{item.playType} · {item.status}</p>
                <details className="mt-2 text-xs text-stone-500"><summary>Recommendation details</summary><pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify(item, null, 2)}</pre></details>
              </article>)}
            </div> : <p className="p-5 text-xs text-stone-500">No recommendations in this scope.</p>}
          </IntentDetailPanel>
        </section>
      </div>
    </div>
  );
}