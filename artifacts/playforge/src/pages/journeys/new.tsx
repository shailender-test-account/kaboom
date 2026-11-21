import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface Client {
  id: number;
  name: string;
  logoUrl: string | null;
}

export default function JourneyNewPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [description, setDescription] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ["clients"],
    queryFn: () => fetch("/api/clients", { credentials: "include" }).then(r => r.json()),
  });

  const mutation = useMutation({
    mutationFn: (data: { name: string; clientId: number; description: string | null; theme: "dark" | "light" }) =>
      fetch("/api/journeys", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then(async r => {
        if (!r.ok) {
          let body: unknown;
          try { body = await r.json(); } catch { body = null; }
          const b = body as Record<string, unknown> | null;
          const msg = (b && typeof b.error === "string" && b.error)
            || (b && typeof b.message === "string" && b.message)
            || `Server error ${r.status}`;
          throw new Error(msg);
        }
        return r.json();
      }),
    onSuccess: (journey) => {
      qc.invalidateQueries({ queryKey: ["journeys"] });
      toast({ title: "Journey created", description: journey.name });
      navigate(`/journeys/${journey.id}`);
    },
    onError: (err: Error) => toast({
      title: "Failed to create journey",
      description: err.message,
      variant: "destructive",
    }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !clientId) return;
    mutation.mutate({
      name: name.trim(),
      clientId: parseInt(clientId),
      description: description.trim() || null,
      theme,
    });
  };

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/journeys")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">New Journey</h1>
          <p className="text-sm text-muted-foreground">Create a content journey for your prospects</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Journey Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="name">Journey Name <span className="text-destructive">*</span></Label>
              <Input
                id="name"
                placeholder="e.g. Q3 AI Analytics Journey"
                value={name}
                onChange={e => setName(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="client">Client <span className="text-destructive">*</span></Label>
              <Select value={clientId} onValueChange={setClientId} required>
                <SelectTrigger id="client">
                  <SelectValue placeholder="Select a client..." />
                </SelectTrigger>
                <SelectContent>
                  {clients.map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="What is this journey about? Who is it for?"
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label>Viewer Theme</Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setTheme("dark")}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all",
                    theme === "dark"
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white text-gray-600 border-gray-200 hover:border-gray-300",
                  )}
                >
                  <Moon className="w-4 h-4" />
                  Dark
                </button>
                <button
                  type="button"
                  onClick={() => setTheme("light")}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all",
                    theme === "light"
                      ? "bg-white text-gray-900 border-gray-300 shadow-sm"
                      : "bg-white text-gray-400 border-gray-200 hover:border-gray-300",
                  )}
                >
                  <Sun className="w-4 h-4" />
                  Light
                </button>
              </div>
              <p className="text-xs text-muted-foreground">Controls the background style of the public viewer</p>
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="submit" className="bg-indigo-600 hover:bg-indigo-700" disabled={!name.trim() || !clientId || mutation.isPending}>
                {mutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Create Journey
              </Button>
              <Button type="button" variant="outline" onClick={() => navigate("/journeys")}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
