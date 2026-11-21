import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useAskAiAnswer, useListClients } from "@workspace/api-client-react";
import type { AIAnswerGroup, AIAnswerResult } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sparkles, Search, RotateCcw, AlertTriangle, HelpCircle, Info, ChevronLeft, ChevronRight, ShieldAlert, ShieldCheck } from "lucide-react";
import AccountResults from "./AccountResults";

const EXAMPLES = [
  "Show me all accounts which have engaged with us at least once.",
  "Show me all people from North India who are from IT function and have shown interest in HP Poly products.",
  "How many people in the Finance function have a global score above 60?",
  "Show people who engaged with HP Poly products since 1 January 2025 in Maharashtra.",
];

function filterLines(g: AIAnswerGroup): string[] {
  const out: string[] = [];
  const list = (label: string, v?: string[]) => { if (v?.length) out.push(`${label}: ${v.join(", ")}`); };
  list("Region", g.regions as string[] | undefined);
  list("State", g.states); list("City", g.cities); list("Country", g.countries);
  list("Function", g.functions); list("Title", g.titles); list("Company", g.companies);
  list("Industry", g.industries);
  if (g.products?.length) out.push(`Product (${g.productMatch === "all" ? "all of" : "any of"}): ${g.products.join(", ")}`);
  if (g.interest && g.interest !== "any") out.push(`Interest: ${g.interest === "declared" ? "recorded stated interest" : "observed engagement"}`);
  if (g.scoreMin != null) out.push(`Global score at least ${g.scoreMin}`);
  if (g.scoreMax != null) out.push(`Global score at most ${g.scoreMax}`);
  if (g.since) out.push(`Since ${g.since}`);
  if (g.until) out.push(`Until ${g.until}`);
  return out;
}

const fmtDate = (s: string | null) => { if (!s) return "date unknown"; const d = new Date(s); return isNaN(+d) ? s : d.toLocaleDateString(); };

interface Held { result: AIAnswerResult; clientId: number; question: string }

export default function AiAnswerPage() {
  const clients = useListClients();
  const ask = useAskAiAnswer();
  const [clientId, setClientId] = useState(() => {
    const value = new URLSearchParams(window.location.search).get("clientId") ?? "";
    return /^[1-9]\d*$/.test(value) ? value : "";
  });
  const [question, setQuestion] = useState("");
  const [held, setHeld] = useState<Held | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);

  const clear = () => { revision.current++; setHeld(null); setError(null); setBusy(false); };

  async function run(cid: number, q: string, page?: number, plan?: AIAnswerResult["plan"]) {
    const rev = ++revision.current;
    setBusy(true); setError(null);
    if (!plan) setHeld(null);
    try {
      const result = await ask.mutateAsync({ data: { clientId: cid, question: q, ...(page ? { page } : {}), ...(plan ? { plan } : {}) } });
      if (!mounted.current || rev !== revision.current) return;
      setHeld({ result, clientId: cid, question: q });
    } catch (e) {
      if (!mounted.current || rev !== revision.current) return;
      setError(e instanceof Error ? e.message : "The search failed. Try again.");
    } finally {
      if (mounted.current && rev === revision.current) setBusy(false);
    }
  }

  const canSearch = !!clientId && question.trim().length >= 5 && !busy;
  const r = held?.result;
  const pages = r ? Math.max(1, Math.ceil(r.total / Math.max(1, r.pageSize))) : 1;
  const goPage = (p: number) => held && run(held.clientId, held.question, p, held.result.plan);
  const regions = r ? Object.entries(r.regionDefinitions ?? {}) : [];
  const needsClarify = !!r && r.clarification.length > 0;

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-8 space-y-6" data-testid="page-ai-answer">
      <header>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary"><Sparkles className="w-3.5 h-3.5" />AI Answer</div>
        <h1 className="text-2xl md:text-3xl font-semibold mt-1">Ask who to talk to</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">Search people or accounts using first-party evidence in your CRM, not guessed intent. Only your question is sent to the model, never personal records. Search is read only and never sends messages.</p>
      </header>

      <section className="rounded-lg border bg-card p-4 space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Client</label>
          <Select value={clientId} onValueChange={v => { setClientId(v); clear(); }} disabled={busy || clients.isLoading}>
            <SelectTrigger className="w-full md:w-80" data-testid="select-client"><SelectValue placeholder={clients.isLoading ? "Loading clients" : "Choose a client"} /></SelectTrigger>
            <SelectContent>{(clients.data ?? []).map(c => <SelectItem key={c.id} value={String(c.id)} data-testid={`option-client-${c.id}`}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
          {clients.isError && <p className="text-xs text-destructive" data-testid="error-clients">Could not load clients. <button className="underline" onClick={() => clients.refetch()} data-testid="button-retry-clients">Retry</button></p>}
          {!clients.isLoading && !clients.isError && (clients.data ?? []).length === 0 && <p className="text-xs text-muted-foreground" data-testid="empty-clients">No clients yet. Create one first.</p>}
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Question</label>
          <Textarea value={question} maxLength={2000} rows={3} disabled={busy} onChange={e => { setQuestion(e.target.value); if (held || error) clear(); }}
            placeholder="Show me all people from North India who are from IT function and have shown interest in HP Poly products" data-testid="input-question" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => run(Number(clientId), question.trim())} disabled={!canSearch} data-testid="button-ask"><Search className="w-4 h-4 mr-2" />{busy ? "Searching" : "Search"}</Button>
          <Button variant="outline" onClick={() => { clear(); setQuestion(""); }} disabled={!question && !held && !error} data-testid="button-reset"><RotateCcw className="w-4 h-4 mr-2" />Reset</Button>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Supported examples</p>
          <div className="flex flex-col gap-1.5">
            {EXAMPLES.map((ex, i) => (
              <button key={i} disabled={busy} onClick={() => { setQuestion(ex); clear(); }} className="text-left text-sm rounded-md border px-3 py-2 hover:bg-muted disabled:opacity-50" data-testid={`button-example-${i}`}>{ex}</button>
            ))}
          </div>
        </div>
      </section>

      {busy && !held && (
        <div className="space-y-3" data-testid="state-loading">
          <p className="text-sm text-muted-foreground">Interpreting your question and searching evidence</p>
          <Skeleton className="h-16 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 flex items-start gap-3" data-testid="state-error">
          <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />
          <div className="flex-1 text-sm"><p className="font-medium">Search failed</p><p className="text-muted-foreground break-words">{error}</p></div>
          <Button size="sm" variant="outline" onClick={() => held ? goPage(held.result.page) : run(Number(clientId), question.trim())} disabled={!clientId || busy} data-testid="button-retry">Retry</Button>
        </div>
      )}

      {r && (
        <div className="space-y-5" data-testid="section-result">
          <div className="rounded-lg border bg-card p-4">
            {needsClarify ? (
              <div data-testid="state-clarification">
                <div className="flex items-center gap-2 font-medium text-sm"><HelpCircle className="w-4 h-4 text-primary" />More detail needed. This is not a zero result.</div>
                <ul className="list-disc pl-5 mt-2 text-sm space-y-1">{r.clarification.map((c, i) => <li key={i} data-testid={`text-clarification-${i}`}>{c}</li>)}</ul>
                <p className="text-xs text-muted-foreground mt-2">No search was performed. Refine the question above and search again.</p>
              </div>
            ) : (
              <div>
                <div className="flex items-baseline gap-2"><span className="text-4xl font-semibold tabular-nums" data-testid="text-total">{r.total.toLocaleString()}</span>
                  <span className="text-sm text-muted-foreground">{r.plan.mode === "accounts" || r.plan.mode === "account-count" ?
                    (r.total === 1 ? "account matches" : "accounts match") : (r.total === 1 ? "person matches" : "people match")}</span></div>
                <p className="text-sm mt-2" data-testid="text-answer">{r.answer}</p>
              </div>
            )}
          </div>

          <div className="rounded-lg border p-4 space-y-2" data-testid="section-interpretation">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">How we read it ({r.plan.mode === "accounts" ? "accounts" : r.plan.mode === "account-count" ? "account count" : r.plan.mode === "count" ? "people count" : "people"})</p>
            <p className="text-sm" data-testid="text-interpretation">{r.plan.interpretation}</p>
            {r.plan.groups.length === 0 ? <p className="text-sm text-muted-foreground">{needsClarify ? "No search was performed." : "No filters applied."}</p> : r.plan.groups.map((g, gi) => (
              <div key={gi}>
                {gi > 0 && <div className="text-xs font-semibold text-primary py-1">OR</div>}
                <div className="rounded-md bg-muted/50 p-2.5 flex flex-wrap gap-1.5 items-center" data-testid={`group-${gi}`}>
                  {filterLines(g).map((l, li) => (<span key={li} className="contents"><Badge variant="secondary" className="font-normal">{l}</Badge>{li < filterLines(g).length - 1 && <span className="text-[10px] text-muted-foreground">AND</span>}</span>))}
                  {filterLines(g).length === 0 && <span className="text-xs text-muted-foreground">Empty group</span>}
                </div>
              </div>
            ))}
            {r.plan.unsupported.length > 0 && (
              <div className="text-sm rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5" data-testid="section-unsupported">
                <p className="font-medium">Not applied</p>
                <ul className="list-disc pl-5">{r.plan.unsupported.map((u, i) => <li key={i}>{u}</li>)}</ul>
              </div>
            )}
          </div>

          {(r.notes.length > 0 || regions.length > 0) && (
            <details className="rounded-lg border p-4 text-sm" data-testid="section-notes">
              <summary className="cursor-pointer font-medium flex items-center gap-2 inline-flex" data-testid="button-toggle-notes"><Info className="w-4 h-4" />Notes and definitions</summary>
              <ul className="list-disc pl-5 mt-2 space-y-1">{r.notes.map((n, i) => <li key={i} data-testid={`text-note-${i}`}>{n}</li>)}</ul>
              {regions.map(([name, def]) => (
                <div key={name} className="mt-3" data-testid={`region-${name}`}>
                  <p className="font-medium">{name}</p>
                  <p className="text-muted-foreground"><span className="font-medium text-foreground">States:</span> {def.states.join(", ") || "none"}</p>
                  {def.cities.length > 0 && <p className="text-muted-foreground"><span className="font-medium text-foreground">Cities:</span> {def.cities.join(", ")}</p>}
                </div>
              ))}
            </details>
          )}

          {!needsClarify && r.plan.mode === "people" && (
            r.people.length === 0 ? (
              <div className="rounded-lg border border-dashed p-8 text-center" data-testid="state-empty">
                <p className="font-medium">No one matched these filters</p>
                <p className="text-sm text-muted-foreground">The question was understood; the evidence has no matching people for this client.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground" data-testid="text-page-info">Page {r.page} of {pages}. Paging reuses the interpreted filters and does not call the AI again.</p>
                <ul className={`space-y-3 transition-opacity ${busy ? "opacity-50" : ""}`}>
                  {r.people.map(p => (
                    <li key={p.id} className="rounded-lg border bg-card p-4" data-testid={`card-person-${p.id}`}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <Link href={`/crm/contacts/${p.id}`} className="font-medium text-primary hover:underline" data-testid={`link-person-${p.id}`}>{p.name}</Link>
                          <p className="text-sm text-muted-foreground break-words">{[p.title, p.function, p.company].filter(Boolean).join(" / ") || "No role details"}</p>
                          <p className="text-xs text-muted-foreground break-all">{[p.email, [p.city, p.state, p.country].filter(Boolean).join(", ")].filter(Boolean).join(" - ")}</p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <Badge variant="outline" data-testid={`text-score-${p.id}`}>Global score {p.score}</Badge>
                          {p.dnc ? <Badge variant="destructive" data-testid={`badge-dnc-${p.id}`}><ShieldAlert className="w-3 h-3 mr-1" />Do not contact</Badge>
                            : <Badge variant="secondary"><ShieldCheck className="w-3 h-3 mr-1" />Contactable</Badge>}
                        </div>
                      </div>
                      {p.dnc && <p className="text-xs text-destructive mt-2" data-testid={`warning-dnc-${p.id}`}>On the do-not-contact list. Do not reach out.</p>}
                      {p.evidence.length > 0 && (
                        <ul className="mt-3 space-y-1.5 border-t pt-3">
                          {p.evidence.map((e, i) => (
                            <li key={`${e.reference}-${i}`} className="text-sm flex flex-wrap items-center gap-2" data-testid={`evidence-${p.id}-${i}`}>
                              <Badge variant={e.basis === "declared" ? "secondary" : "default"} className="font-normal">{e.basis === "declared" ? "Stated interest" : "Observed engagement"}</Badge>
                              <span>{e.product || "General engagement"}</span>
                              <span className="text-xs text-muted-foreground">{fmtDate(e.occurredAt)}{e.source ? ` via ${e.source}` : ""} (ref {e.reference})</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between">
                  <Button variant="outline" size="sm" disabled={busy || r.page <= 1} onClick={() => goPage(r.page - 1)} data-testid="button-prev-page"><ChevronLeft className="w-4 h-4" />Previous</Button>
                  <span className="text-xs text-muted-foreground">{r.page} / {pages}</span>
                  <Button variant="outline" size="sm" disabled={busy || r.page >= pages} onClick={() => goPage(r.page + 1)} data-testid="button-next-page">Next<ChevronRight className="w-4 h-4" /></Button>
                </div>
              </div>
            )
          )}
          {!needsClarify && r.plan.mode === "accounts" && <AccountResults accounts={r.accounts ?? []} page={r.page} pages={pages} busy={busy} goPage={goPage} />}
        </div>
      )}
    </div>
  );
}
