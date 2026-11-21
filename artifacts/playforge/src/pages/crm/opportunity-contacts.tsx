import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";

export default function OpportunityContacts({ dealId }: { dealId: number }) {
  const q = useQuery<{ id: number; name: string; title: string | null; isPrimary: boolean }[]>({
    queryKey: ["deal-contacts", dealId],
    queryFn: async () => {
      const r = await fetch(`${import.meta.env.BASE_URL}api/deals/${dealId}/contacts`, { credentials: "include" });
      if (!r.ok) throw new Error("Linked contacts could not be loaded.");
      return r.json();
    },
  });
  return <section className="space-y-1 rounded border p-3 text-xs" data-testid="opportunity-linked-contacts">
    <h3 className="font-semibold">Linked contacts</h3>
    {q.isLoading && <p>Loading contacts…</p>}
    {q.isError && <p role="alert">Could not load linked contacts. <button type="button" className="underline" onClick={() => q.refetch()}>Retry</button></p>}
    {q.data?.map(c => <div key={c.id}><Link href={`/crm/contacts/${c.id}`} className="underline font-medium">{c.name}</Link>
      {c.title && <span> · {c.title}</span>}<span className="text-muted-foreground"> · {c.isPrimary ? "Primary contact" : "Stakeholder"}</span></div>)}
    {q.data?.length === 0 && <p className="text-muted-foreground">No contacts linked.</p>}
  </section>;
}
