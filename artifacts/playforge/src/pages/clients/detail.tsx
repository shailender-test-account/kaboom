import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ArrowLeft, Pencil, Globe, Building2, Users, Zap,
  Loader2, Calendar, Briefcase, Map, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format } from "date-fns";

interface Client {
  id: number;
  name: string;
  domain: string | null;
  industry: string | null;
  companySize: string | null;
  website: string | null;
  logoUrl: string | null;
  description: string | null;
  icpNotes: string | null;
  playsCount: number;
  contactsCount: number;
  createdAt: string;
}

interface Play {
  id: number;
  name: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  pageViews: number;
  contactsEnrolled: number;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  active: "bg-emerald-100 text-emerald-700",
  paused: "bg-amber-100 text-amber-700",
  archived: "bg-red-100 text-red-700",
};

function ClientAvatar({ client }: { client: Client }) {
  if (client.logoUrl) {
    return (
      <img
        src={client.logoUrl}
        alt={client.name}
        className="w-12 h-12 rounded-xl object-contain border border-border bg-white"
      />
    );
  }
  const initials = client.name.slice(0, 2).toUpperCase();
  const colors = [
    "bg-indigo-100 text-indigo-700",
    "bg-violet-100 text-violet-700",
    "bg-sky-100 text-sky-700",
    "bg-emerald-100 text-emerald-700",
    "bg-orange-100 text-orange-700",
  ];
  const color = colors[client.id % colors.length];
  return (
    <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-base font-bold shrink-0 ${color}`}>
      {initials}
    </div>
  );
}

interface ClientDetailPageProps {
  id: string;
}

export default function ClientDetailPage({ id }: ClientDetailPageProps) {
  const [, navigate] = useLocation();

  const { data: client, isLoading: clientLoading } = useQuery<Client>({
    queryKey: ["clients", id],
    queryFn: () => fetch(`/api/clients/${id}`, { credentials: "include" }).then((r) => r.json()),
  });

  const { data: plays = [] } = useQuery<Play[]>({
    queryKey: ["plays", { clientId: id }],
    queryFn: () =>
      fetch(`/api/plays?clientId=${id}`, { credentials: "include" }).then((r) => r.json()),
    enabled: !!client,
  });

  const { data: journeys = [] } = useQuery<Array<{ id: number; name: string; slug: string; status: string; playId: number; playName: string }>>({
    queryKey: ["client-journeys", id],
    queryFn: () =>
      fetch(`/api/clients/${id}/journeys`, { credentials: "include" }).then((r) => r.json()),
    enabled: !!client,
  });

  if (clientLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!client) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm text-muted-foreground">Client not found.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate("/clients")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1 flex items-center gap-4">
          <ClientAvatar client={client} />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-foreground tracking-tight">{client.name}</h1>
            <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
              {client.domain && (
                <span className="flex items-center gap-1">
                  <Globe className="w-3 h-3" />
                  {client.domain}
                </span>
              )}
              {client.industry && (
                <span className="flex items-center gap-1">
                  <Briefcase className="w-3 h-3" />
                  {client.industry}
                </span>
              )}
              {client.companySize && (
                <span className="flex items-center gap-1">
                  <Users className="w-3 h-3" />
                  {client.companySize} employees
                </span>
              )}
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Added {format(new Date(client.createdAt), "MMM d, yyyy")}
              </span>
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate(`/clients/${id}/edit`)}>
          <Pencil className="w-3.5 h-3.5 mr-1.5" />
          Edit
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Active Plays", value: plays.filter(p => p.status === "active").length, icon: Zap, color: "text-indigo-600", bg: "bg-indigo-50" },
          { label: "Total Plays", value: client.playsCount, icon: Briefcase, color: "text-violet-600", bg: "bg-violet-50" },
          { label: "Contacts", value: client.contactsCount, icon: Users, color: "text-sky-600", bg: "bg-sky-50" },
        ].map((stat) => (
          <Card key={stat.label} className="shadow-xs">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{stat.label}</p>
                  <p className="text-2xl font-bold text-foreground mt-0.5">{stat.value}</p>
                </div>
                <div className={`w-9 h-9 rounded-lg ${stat.bg} flex items-center justify-center`}>
                  <stat.icon className={`w-4 h-4 ${stat.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Client info */}
        <div className="col-span-1 space-y-4">
          {client.description && (
            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  About
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <p className="text-sm text-foreground leading-relaxed">{client.description}</p>
              </CardContent>
            </Card>
          )}
          {client.icpNotes && (
            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  ICP Notes
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{client.icpNotes}</p>
              </CardContent>
            </Card>
          )}
          {client.website && (
            <Card className="shadow-xs">
              <CardContent className="py-3 px-4">
                <a
                  href={client.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline flex items-center gap-1.5"
                >
                  <Globe className="w-3.5 h-3.5" />
                  Visit website
                </a>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Plays list */}
        <div className="col-span-2">
          <Card className="shadow-xs">
            <CardHeader className="pb-3 pt-4 px-4 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold">ABM Plays</CardTitle>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => navigate("/plays/new")}>
                <Zap className="w-3 h-3 mr-1" />
                New Play
              </Button>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {plays.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-8 text-center">
                  <Zap className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">No plays yet for this client</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {plays.map((play) => (
                    <div
                      key={play.id}
                      className="flex items-center justify-between p-3 rounded-lg border border-border hover:bg-muted/30 cursor-pointer transition-colors"
                      onClick={() => navigate(`/plays/${play.id}`)}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{play.name}</p>
                        {(play.startDate || play.endDate) && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {play.startDate && format(new Date(play.startDate), "MMM d")}
                            {play.startDate && play.endDate && " → "}
                            {play.endDate && format(new Date(play.endDate), "MMM d, yyyy")}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="text-right">
                          <p className="text-xs font-medium">{play.pageViews}</p>
                          <p className="text-xs text-muted-foreground">views</p>
                        </div>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[play.status] ?? "bg-gray-100 text-gray-700"}`}>
                          {play.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Journeys for this client (via journey_plays) */}
          <Card className="shadow-xs mt-4">
            <CardHeader className="pb-3 pt-4 px-4 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold">Journeys</CardTitle>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => navigate("/journeys/new")}>
                <Map className="w-3 h-3 mr-1" />
                New Journey
              </Button>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {journeys.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-8 text-center">
                  <Map className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">
                    No journeys linked yet. Create a journey from one of this client's plays to see it here.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {journeys.map((j) => (
                    <div
                      key={`${j.playId}-${j.id}`}
                      className="flex items-center justify-between p-3 rounded-lg border border-border hover:bg-muted/30 cursor-pointer transition-colors"
                      onClick={() => navigate(`/journeys/${j.id}`)}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{j.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">via {j.playName}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[j.status] ?? "bg-gray-100 text-gray-700"}`}>
                          {j.status}
                        </span>
                        {j.slug && (
                          <a
                            href={`/j/${j.slug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-muted-foreground hover:text-primary"
                            title="Open public viewer"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
