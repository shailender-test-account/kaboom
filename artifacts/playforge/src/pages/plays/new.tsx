import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import {
  ArrowLeft, ArrowRight, Check, Building2, Zap, Loader2, Calendar,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

interface Client {
  id: number;
  name: string;
  domain: string | null;
  industry: string | null;
  logoUrl: string | null;
}

interface Step2Values {
  name: string;
  targetAudience: string;
  startDate: string;
  endDate: string;
  description: string;
}

const STEPS = [
  { label: "Select Client", icon: Building2 },
  { label: "Play Details", icon: Zap },
  { label: "Confirm", icon: Check },
];

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-2 mb-8 flex-wrap">
      {STEPS.map((step, i) => {
        const done = i < current;
        const active = i === current;
        const Icon = step.icon;
        return (
          <div key={i} className="flex items-center gap-2">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors",
                  done ? "bg-primary text-primary-foreground"
                    : active ? "bg-primary/10 text-primary ring-2 ring-primary/30"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {done ? <Check className="w-3.5 h-3.5" /> : <Icon className="w-3.5 h-3.5" />}
              </div>
              <span className={cn(
                "text-xs font-medium",
                active ? "text-foreground" : done ? "text-muted-foreground" : "text-muted-foreground/60",
              )}>
                {step.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={cn("w-8 h-px", done ? "bg-primary/40" : "bg-border")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function PlayNewPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);
  const [clientSearch, setClientSearch] = useState("");

  const { data: clients = [], isLoading: clientsLoading } = useQuery<Client[]>({
    queryKey: ["clients"],
    queryFn: () => fetch("/api/clients", { credentials: "include" }).then((r) => r.json()),
  });

  const { register, handleSubmit, watch, formState: { errors } } = useForm<Step2Values>({
    defaultValues: {
      name: "",
      targetAudience: "",
      startDate: "",
      endDate: "",
      description: "",
    },
  });

  const formValues = watch();

  const selectedClient = clients.find((c) => c.id === selectedClientId);
  const filteredClients = clients.filter((c) =>
    c.name.toLowerCase().includes(clientSearch.toLowerCase()),
  );

  const mutation = useMutation({
    mutationFn: async (data: Step2Values) => {
      const r = await fetch("/api/plays", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: selectedClientId,
          name: data.name,
          description: data.description || null,
          targetAudience: data.targetAudience || null,
          startDate: data.startDate ? new Date(data.startDate).toISOString() : null,
          endDate: data.endDate ? new Date(data.endDate).toISOString() : null,
          status: "draft",
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: (play) => {
      qc.invalidateQueries({ queryKey: ["plays"] });
      toast({ title: "Play created", description: play.name });
      navigate(`/plays/${play.id}`);
    },
    onError: () => toast({ title: "Failed to create play", variant: "destructive" }),
  });

  function ClientCard({ client }: { client: Client }) {
    const initials = client.name.slice(0, 2).toUpperCase();
    const colors = ["bg-indigo-100 text-indigo-700", "bg-violet-100 text-violet-700", "bg-sky-100 text-sky-700", "bg-emerald-100 text-emerald-700"];
    const color = colors[client.id % colors.length];
    const isSelected = selectedClientId === client.id;

    return (
      <button
        type="button"
        onClick={() => setSelectedClientId(client.id)}
        className={cn(
          "w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-all",
          isSelected
            ? "border-primary bg-primary/5 ring-1 ring-primary/30"
            : "border-border hover:border-border/60 hover:bg-muted/30",
        )}
      >
        {client.logoUrl ? (
          <img src={client.logoUrl} alt={client.name} className="w-9 h-9 rounded-lg object-contain border border-border bg-white shrink-0" />
        ) : (
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${color}`}>
            {initials}
          </div>
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{client.name}</p>
          {(client.domain || client.industry) && (
            <p className="text-xs text-muted-foreground truncate">
              {[client.domain, client.industry].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
        {isSelected && <Check className="w-4 h-4 text-primary ml-auto shrink-0" />}
      </button>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate("/plays")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold text-foreground tracking-tight">New Play</h1>
          <p className="text-sm text-muted-foreground">Create a new ABM play</p>
        </div>
      </div>

      <StepIndicator current={step} />

      {/* Step 0: Select Client */}
      {step === 0 && (
        <div className="space-y-4">
          <Input
            placeholder="Search clients..."
            value={clientSearch}
            onChange={(e) => setClientSearch(e.target.value)}
            className="h-9 text-sm"
          />
          {clientsLoading ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : filteredClients.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <Building2 className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No clients found</p>
              <Button size="sm" className="mt-3" onClick={() => navigate("/clients/new")}>
                Create a client first
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredClients.map((c) => (
                <ClientCard key={c.id} client={c} />
              ))}
            </div>
          )}
          <div className="flex justify-end pt-2">
            <Button
              size="sm"
              onClick={() => setStep(1)}
              disabled={!selectedClientId}
            >
              Next <ArrowRight className="w-4 h-4 ml-1.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 1: Play Details */}
      {step === 1 && (
        <form className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name" className="text-xs font-medium">
              Play Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="name"
              placeholder="e.g. Q3 Enterprise Expansion Play"
              className="h-9 text-sm"
              {...register("name", { required: "Play name is required" })}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="targetAudience" className="text-xs font-medium">Target Audience</Label>
            <Textarea
              id="targetAudience"
              placeholder="e.g. VP of Sales at SaaS companies with 100-500 employees in North America"
              className="text-sm resize-none"
              rows={2}
              {...register("targetAudience")}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="startDate" className="text-xs font-medium flex items-center gap-1">
                <Calendar className="w-3 h-3" /> Start Date
              </Label>
              <Input
                id="startDate"
                type="date"
                className="h-9 text-sm"
                {...register("startDate")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="endDate" className="text-xs font-medium flex items-center gap-1">
                <Calendar className="w-3 h-3" /> End Date
              </Label>
              <Input
                id="endDate"
                type="date"
                className="h-9 text-sm"
                {...register("endDate")}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description" className="text-xs font-medium">Description</Label>
            <Textarea
              id="description"
              placeholder="Brief description of this play's goals and strategy..."
              className="text-sm resize-none"
              rows={3}
              {...register("description")}
            />
          </div>

          <div className="flex items-center justify-between pt-2">
            <Button variant="outline" size="sm" onClick={() => setStep(0)}>
              <ArrowLeft className="w-4 h-4 mr-1.5" /> Back
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit(() => setStep(2))}
            >
              Next <ArrowRight className="w-4 h-4 ml-1.5" />
            </Button>
          </div>
        </form>
      )}

      {/* Step 2: Confirm */}
      {step === 2 && (
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-4 pb-4 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Review</h3>

              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Client</span>
                  <span className="font-medium">{selectedClient?.name}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Play Name</span>
                  <span className="font-medium">{formValues.name}</span>
                </div>
                {formValues.targetAudience && (
                  <div className="flex justify-between text-sm gap-4">
                    <span className="text-muted-foreground shrink-0">Target Audience</span>
                    <span className="text-right text-xs">{formValues.targetAudience}</span>
                  </div>
                )}
                {(formValues.startDate || formValues.endDate) && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Date Range</span>
                    <span className="text-xs">
                      {formValues.startDate && format(new Date(formValues.startDate), "MMM d, yyyy")}
                      {formValues.startDate && formValues.endDate && " – "}
                      {formValues.endDate && format(new Date(formValues.endDate), "MMM d, yyyy")}
                    </span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Status</span>
                  <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full font-medium">Draft</span>
                </div>
              </div>

              <p className="text-xs text-muted-foreground pt-1 border-t border-border">
                You can link journeys to this play from the Journeys tab after it's created.
              </p>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" onClick={() => setStep(1)}>
              <ArrowLeft className="w-4 h-4 mr-1.5" /> Back
            </Button>
            <Button
              size="sm"
              disabled={mutation.isPending}
              onClick={handleSubmit((values) => mutation.mutate(values))}
            >
              {mutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              <Check className="w-3.5 h-3.5 mr-1.5" />
              Create Play
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
