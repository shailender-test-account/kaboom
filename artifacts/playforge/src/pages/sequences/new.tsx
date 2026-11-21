import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

interface Play { id: number; name: string; status: string; }

const TRIGGER_TYPES = [
  { value: "MANUAL",         label: "Manual — enroll contacts individually" },
  { value: "FORM_SUBMITTED", label: "Form Submitted — journey CTA or gated PDF" },
  { value: "PAGE_VIEWED",    label: "Page Viewed — contact views a journey page" },
  { value: "LINK_CLICKED",   label: "Link Clicked — contact clicks a tracked link" },
];

export default function SequenceNewPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [playId, setPlayId] = useState("");
  const [triggerType, setTriggerType] = useState("MANUAL");

  const { data: plays = [] } = useQuery<Play[]>({
    queryKey: ["plays"],
    queryFn: () => fetch("/api/plays", { credentials: "include" }).then(r => r.json()),
  });

  const mutation = useMutation({
    mutationFn: (data: any) =>
      fetch("/api/email-sequences", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
    onSuccess: (seq) => {
      qc.invalidateQueries({ queryKey: ["email-sequences"] });
      toast({ title: "Sequence created" });
      navigate(`/sequences/${seq.id}`);
    },
    onError: () => toast({ title: "Failed to create sequence", variant: "destructive" }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    mutation.mutate({
      name: name.trim(),
      playId: playId ? parseInt(playId) : null,
      triggerType,
      status: "draft",
      nodesJson: { nodes: [], edges: [] },
    });
  };

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/sequences")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">New Sequence</h1>
          <p className="text-sm text-muted-foreground">Build an automated email workflow</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sequence Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="name">Sequence Name <span className="text-destructive">*</span></Label>
              <Input
                id="name"
                placeholder="e.g. TechNova Outreach Sequence"
                value={name}
                onChange={e => setName(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="play">Linked Play</Label>
              <Select value={playId} onValueChange={setPlayId}>
                <SelectTrigger id="play">
                  <SelectValue placeholder="Select a play (optional)..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No play</SelectItem>
                  {plays.map(p => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Trigger</Label>
              <div className="space-y-2">
                {TRIGGER_TYPES.map(t => (
                  <label key={t.value} className="flex items-start gap-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/30 transition-colors">
                    <input
                      type="radio"
                      name="trigger"
                      value={t.value}
                      checked={triggerType === t.value}
                      onChange={() => setTriggerType(t.value)}
                      className="mt-0.5"
                    />
                    <div>
                      <div className="text-sm font-medium">{t.label.split(" — ")[0]}</div>
                      <div className="text-xs text-muted-foreground">{t.label.split(" — ")[1]}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <Button
                type="submit"
                className="bg-indigo-600 hover:bg-indigo-700"
                disabled={!name.trim() || mutation.isPending}
              >
                {mutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Create & Open Editor
              </Button>
              <Button type="button" variant="outline" onClick={() => navigate("/sequences")}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
