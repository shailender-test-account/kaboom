import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ClientForm, type ClientFormValues } from "./form";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

interface ClientEditPageProps {
  id: string;
}

export default function ClientEditPage({ id }: ClientEditPageProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: client, isLoading } = useQuery({
    queryKey: ["clients", id],
    queryFn: () => fetch(`/api/clients/${id}`, { credentials: "include" }).then((r) => r.json()),
  });

  const mutation = useMutation({
    mutationFn: (data: ClientFormValues) =>
      fetch(`/api/clients/${id}`, {
        method: "PATCH",
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["clients", id] });
      toast({ title: "Client updated" });
      navigate(`/clients/${id}`);
    },
    onError: () => toast({ title: "Failed to update client", variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ClientForm
      title="Edit Client"
      submitLabel="Save Changes"
      isLoading={mutation.isPending}
      defaultValues={{
        name: client?.name ?? "",
        domain: client?.domain ?? "",
        industry: client?.industry ?? "",
        companySize: client?.companySize ?? "",
        website: client?.website ?? "",
        description: client?.description ?? "",
        icpNotes: client?.icpNotes ?? "",
      }}
      onSubmit={(values) => mutation.mutate(values)}
    />
  );
}
