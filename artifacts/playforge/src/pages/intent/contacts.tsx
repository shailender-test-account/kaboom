import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useIntentAccounts } from "@/hooks/use-intent";
import { IntentPageHeader } from "@/components/intent/ui";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, ArrowRight, Briefcase } from "lucide-react";
import { Input } from "@/components/ui/input";
import { getScopeParams, buildScopeQs } from "@/lib/intent-scope";

export default function IntentContactsPage() {
  const searchParams = new URLSearchParams(window.location.search);
  const scopeParams = getScopeParams(searchParams);
  const qs = buildScopeQs(scopeParams);
  
  const { data: accountsData, isLoading, isError } = useIntentAccounts({ ...scopeParams, page: 1, pageSize: 50 });
  const [searchInput, setSearchInput] = useState("");

  const allContacts = useMemo(() => {
    return (accountsData?.accounts || []).flatMap((acc: any) => 
      (acc.contacts || []).map((c: any) => ({
        ...c,
        companyName: acc.name,
        companyId: acc.id,
        relevance: c.score || 0
      }))
    ).sort((a: any, b: any) => b.relevance - a.relevance);
  }, [accountsData]);

  const contacts = useMemo(() => {
    if (!searchInput.trim()) return allContacts.slice(0, 15);
    const term = searchInput.toLowerCase();
    return allContacts.filter((c: any) => 
      c.name.toLowerCase().includes(term) || 
      (c.title && c.title.toLowerCase().includes(term)) || 
      c.companyName.toLowerCase().includes(term)
    ).slice(0, 15);
  }, [allContacts, searchInput]);

  const economicBuyers = allContacts.filter((c: any) => /founder|ceo|cfo|president|director|vp/i.test(c.title || "")).length;
  const problemOwners = allContacts.filter((c: any) => /manager|head|lead|operations|compliance/i.test(c.title || "")).length;
  const techEvaluators = allContacts.filter((c: any) => /it|tech|engineer|developer|architect|security/i.test(c.title || "")).length;
  const influencers = allContacts.length - economicBuyers - problemOwners - techEvaluators;

  return (
    <div className="flex flex-col min-h-full font-sans text-stone-900">
      <IntentPageHeader 
        title="Buying-contact priorities"
        breadcrumbs="ROLE AND ENGAGEMENT FIT"
      />
      
      <div className="p-6 max-w-[1200px] mx-auto w-full grid grid-cols-1 xl:grid-cols-3 gap-6">
        
        {/* Left Column: People list */}
        <div className="xl:col-span-2 space-y-4">
          <div className="bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden flex flex-col">
            <div className="p-5 border-b border-stone-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="font-bold text-sm text-stone-900">People to involve now</h2>
                <p className="text-[11px] font-medium text-stone-500 mt-0.5">Ranked by buying-role fit and account evidence.</p>
              </div>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
                <Input 
                  placeholder="Filter contacts..." 
                  className="pl-9 h-8 w-full sm:w-48 text-xs font-medium border-stone-200 bg-stone-50 focus-visible:ring-emerald-500"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
              </div>
            </div>
            
            <div className="divide-y divide-stone-100">
              {isError ? (
                <div className="p-10 text-center">
                  <Briefcase className="w-8 h-8 text-rose-300 mx-auto mb-3" />
                  <p className="text-sm font-bold text-stone-900">Unable to load buying contacts</p>
                  <p className="text-xs text-stone-500 mt-1">Refresh the page or adjust the current scope.</p>
                </div>
              ) : isLoading ? (
                Array.from({length: 5}).map((_, i) => (
                  <div key={i} className="p-5 flex gap-4 items-center">
                    <Skeleton className="w-10 h-10 rounded-full shrink-0" />
                    <div className="space-y-2 flex-1"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-64" /></div>
                    <Skeleton className="w-12 h-8 rounded" />
                  </div>
                ))
              ) : contacts.length === 0 ? (
                <div className="p-10 text-center">
                  <Briefcase className="w-8 h-8 text-stone-300 mx-auto mb-3" />
                  <p className="text-sm font-bold text-stone-900">No contacts found</p>
                </div>
              ) : (
                contacts.map((contact: any, i: number) => {
                  const initials = contact.name.split(' ').map((n: string) => n[0]).join('').substring(0, 2).toUpperCase();
                  const roleDescription = /finance|cfo|tax|accounting/i.test(contact.title || "") ? "Financial exposure + indirect tax oversight" 
                                        : /compliance|legal|secretary/i.test(contact.title || "") ? "Disclosure and regulatory workflow ownership"
                                        : /operations|customer|service/i.test(contact.title || "") ? "Owns service efficiency and automation"
                                        : "Direct category ownership + engagement";
                  
                  return (
                    <div key={contact.id || i} className="p-5 flex items-center gap-4 hover:bg-stone-50 transition-colors group">
                      <div className="w-10 h-10 rounded-full bg-[#0F2B20] text-white flex items-center justify-center text-[10px] font-bold shrink-0 shadow-sm">
                        {initials}
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-2 mb-1">
                          <Link href={`/intent/contacts/${contact.id}${qs ? `?${qs}` : ''}`} className="text-[13px] font-bold text-stone-900 hover:text-emerald-700 transition-colors truncate">
                            {contact.name}
                          </Link>
                        </div>
                        <p className="text-[11px] font-medium text-stone-500 truncate mb-1">
                          {contact.title} • {contact.companyName}
                        </p>
                        <p className="text-[10px] font-semibold text-stone-400 truncate">
                          {roleDescription}
                        </p>
                      </div>
                      
                      <div className="shrink-0 flex items-center gap-4">
                        <div className="text-right">
                          <div className="text-lg font-black text-stone-900 leading-none">{contact.relevance}</div>
                          <div className="text-[9px] font-bold uppercase tracking-widest text-stone-400 mt-1">score</div>
                        </div>
                        <Link href={`/intent/contacts/${contact.id}${qs ? `?${qs}` : ''}`} className="w-7 h-7 rounded-full bg-emerald-700 text-white flex items-center justify-center hover:bg-emerald-800 transition-colors">
                          <ArrowRight className="w-3.5 h-3.5" />
                        </Link>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
        
        {/* Right Column */}
        <div className="xl:col-span-1 space-y-6">
          <div className="bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden">
            <div className="p-5 border-b border-stone-100 bg-stone-50/50">
              <Briefcase className="w-4 h-4 text-stone-500 mb-4" />
              <h2 className="text-sm font-bold text-stone-900">Buying-role map (Loaded)</h2>
            </div>
            
            <div className="p-5 space-y-3">
              {[
                { role: "Economic buyer", count: isLoading ? "-" : economicBuyers },
                { role: "Problem owner", count: isLoading ? "-" : problemOwners },
                { role: "Technical evaluator", count: isLoading ? "-" : techEvaluators },
                { role: "Influencer", count: isLoading ? "-" : (influencers > 0 ? influencers : 0) }
              ].map((item, i) => (
                <div key={i} className="flex items-center justify-between text-xs font-semibold p-2.5 rounded-lg bg-stone-50 border border-stone-100">
                  <span className="text-stone-600">{item.role}</span>
                  <span className="text-stone-900 font-black">{item.count}</span>
                </div>
              ))}
            </div>
          </div>
          
          <div className="bg-[#0F2B20] text-stone-300 rounded-xl p-6 shadow-lg relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-[#bef264]/5 rounded-full blur-2xl -translate-y-1/2 translate-x-1/2" />
            <h2 className="text-sm font-bold text-white mb-2 relative z-10">Contact-level signals</h2>
            <p className="text-[11px] font-medium text-[#8BAA9D] leading-relaxed relative z-10">
              A hot company should not automatically make every contact hot. Form and event activity score the respondent separately.
            </p>
          </div>
        </div>
        
      </div>
    </div>
  );
}