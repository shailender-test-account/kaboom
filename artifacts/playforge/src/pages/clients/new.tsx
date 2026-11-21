import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ClientForm, type ClientFormValues } from "./form";
import { useToast } from "@/hooks/use-toast";

export default function ClientNewPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: (data: ClientFormValues) =>
      fetch("/api/clients", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name,
          domain: data.domain || null,
          industry: data.industry || null,
          companySize: data.companySize || null,
          website: data.website || null,
          description: data.description || null,
          icpNotes: data.icpNotes || null,
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      }),
    onSuccess: (client) => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      toast({ title: "Client created", description: client.name });
      navigate(`/clients/${client.id}`);
    },
    onError: () => toast({ title: "Failed to create client", variant: "destructive" }),
  });

  return (
    <ClientForm
      title="New Client"
      submitLabel="Create Client"
      isLoading={mutation.isPending}
      onSubmit={(values) => mutation.mutate(values)}
    />
  );
}
