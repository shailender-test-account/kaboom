import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Search, Users, Building2, Zap, BookOpen } from "lucide-react";
import { ScoreBadge } from "./ScoreBadge";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

type SearchResults = {
  contacts: { id: number; firstName: string; lastName: string; email: string; leadScore: number }[];
  companies: { id: number; name: string; domain: string | null; industry: string | null }[];
  plays: { id: number; name: string; status: string }[];
  journeys: { id: number; name: string; status: string; slug: string }[];
};

interface GlobalSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GlobalSearch({ open, onOpenChange }: GlobalSearchProps) {
  const [, navigate] = useLocation();
  const [q, setQ] = useState("");

  const { data } = useQuery<SearchResults>({
    queryKey: ["search", q],
    queryFn: () => fetch(`/api/search?q=${encodeURIComponent(q)}`, { credentials: "include" }).then(r => r.json()),
    enabled: q.trim().length >= 2,
    staleTime: 5000,
  });

  const go = useCallback((href: string) => {
    navigate(href);
    onOpenChange(false);
    setQ("");
  }, [navigate, onOpenChange]);

  const hasResults = data && (data.contacts.length + data.companies.length + data.plays.length + data.journeys.length) > 0;

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Search contacts, companies, plays, journeys…"
        value={q}
        onValueChange={setQ}
      />
      <CommandList>
        {q.trim().length >= 2 && !hasResults && (
          <CommandEmpty>No results for "{q}"</CommandEmpty>
        )}
        {q.trim().length < 2 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Type at least 2 characters to search…
          </div>
        )}

        {data?.contacts && data.contacts.length > 0 && (
          <CommandGroup heading="Contacts">
            {data.contacts.map(c => (
              <CommandItem key={`contact-${c.id}`} value={`contact-${c.id}-${c.firstName}-${c.lastName}`} onSelect={() => go(`/crm/contacts/${c.id}`)}>
                <div className="flex items-center gap-2.5 w-full">
                  <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold shrink-0">
                    {c.firstName[0]}{c.lastName[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-sm">{c.firstName} {c.lastName}</span>
                    <span className="text-muted-foreground text-xs ml-2">{c.email}</span>
                  </div>
                  <ScoreBadge score={c.leadScore} size="sm" />
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {data?.companies && data.companies.length > 0 && (
          <>
            {data.contacts.length > 0 && <CommandSeparator />}
            <CommandGroup heading="Companies">
              {data.companies.map(c => (
                <CommandItem key={`company-${c.id}`} value={`company-${c.id}-${c.name}`} onSelect={() => go(`/crm/companies`)}>
                  <div className="flex items-center gap-2.5 w-full">
                    <div className="w-6 h-6 rounded bg-slate-100 text-slate-700 flex items-center justify-center text-xs font-semibold shrink-0">
                      {c.name[0]}
                    </div>
                    <span className="font-medium text-sm">{c.name}</span>
                    {c.domain && <span className="text-muted-foreground text-xs">{c.domain}</span>}
                    {c.industry && <span className="text-xs text-muted-foreground ml-auto">{c.industry}</span>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {data?.plays && data.plays.length > 0 && (
          <>
            {(data.contacts.length > 0 || data.companies.length > 0) && <CommandSeparator />}
            <CommandGroup heading="Plays">
              {data.plays.map(p => (
                <CommandItem key={`play-${p.id}`} value={`play-${p.id}-${p.name}`} onSelect={() => go(`/plays/${p.id}`)}>
                  <Zap className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="font-medium text-sm ml-2">{p.name}</span>
                  <span className={cn("text-xs ml-auto capitalize px-1.5 py-0.5 rounded-full", p.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-600")}>
                    {p.status}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {data?.journeys && data.journeys.length > 0 && (
          <>
            {(data.contacts.length > 0 || data.companies.length > 0 || data.plays.length > 0) && <CommandSeparator />}
            <CommandGroup heading="Journeys">
              {data.journeys.map(j => (
                <CommandItem key={`journey-${j.id}`} value={`journey-${j.id}-${j.name}`} onSelect={() => go(`/journeys/${j.id}`)}>
                  <BookOpen className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="font-medium text-sm ml-2">{j.name}</span>
                  <span className={cn("text-xs ml-auto capitalize px-1.5 py-0.5 rounded-full", j.status === "published" ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-600")}>
                    {j.status}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

export function useGlobalSearch() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(v => !v);
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return { open, setOpen };
}
