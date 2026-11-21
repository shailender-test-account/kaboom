import { useState } from "react";
import { useIntentRecommendations, useUpdateRecommendation } from "@/hooks/use-intent";
import { IntentPageHeader } from "@/components/intent/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckSquare, XSquare, Clock, ArrowRight, Zap, Target, Building2, User, ChevronDown, AlertCircle } from "lucide-react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { formatReportDate } from "@/lib/reportTime";

export default function IntentRecommendationsPage() {
  const [location] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const qs = searchParams.toString();

  const [status, setStatus] = useState("pending");
  const { data: recData, isLoading, isError, error } = useIntentRecommendations({
    status,
    page: 1,
    pageSize: 50,
    clientId: searchParams.get("client") || undefined,
    audienceId: searchParams.get("audience") || undefined,
    categoryId: searchParams.get("category") || undefined,
    subcategoryId: searchParams.get("subcategory") || undefined,
    productId: searchParams.get("product") || undefined
  });
  const updateRec = useUpdateRecommendation();

  const handleAction = (id: number, actionStatus: string) => {
    updateRec.mutate({ id, data: { status: actionStatus } });
  };

  return (
    <div className="flex flex-col min-h-full font-sans text-stone-900">
      <IntentPageHeader
        title="Recommended Plays"
        subtitle="AI-generated actions based on account intent and contact movement."
        breadcrumbs="COMMAND CENTER"
      />

      <div className="p-6 max-w-[1200px] mx-auto w-full space-y-6">
        <div className="flex items-center justify-between border-b border-stone-200 pb-4">
          <Tabs value={status} onValueChange={setStatus} className="w-[400px]">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="pending">Pending</TabsTrigger>
              <TabsTrigger value="actioned">Actioned</TabsTrigger>
              <TabsTrigger value="dismissed">Dismissed</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="space-y-4">
          {isError ? (
            <div className="p-4 text-center text-red-500 bg-red-50 border border-red-200 rounded-lg">
              <AlertCircle className="w-8 h-8 mx-auto text-red-300 mb-3" />
              <p className="font-medium">Failed to load recommendations</p>
              <p className="text-xs mt-1">{error?.message}</p>
            </div>
          ) : isLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="shadow-xs border"><CardContent className="p-6"><Skeleton className="h-24 w-full" /></CardContent></Card>
            ))
          ) : (recData?.recommendations || []).length === 0 ? (
            <div className="text-center py-20 bg-card border rounded-lg shadow-xs">
              <CheckSquare className="w-12 h-12 text-slate-200 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-foreground">No recommendations</h3>
              <p className="text-sm text-muted-foreground mt-1">You're all caught up for now.</p>
            </div>
          ) : (
            (recData?.recommendations || []).map((rec: any) => (
              <Card key={rec.id} className="shadow-xs border overflow-hidden group">
                <div className="flex flex-col md:flex-row">
                  <div className={cn("p-6 flex-1", status === "pending" ? "bg-white" : "bg-slate-50")}>
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1.5">
                          <Badge variant="outline" className={cn("text-[10px] uppercase tracking-wider font-bold",
                            rec.tierKey === "hot" ? "bg-rose-50 text-rose-700 border-rose-200" :
                            rec.tierKey === "warm" ? "bg-amber-50 text-amber-700 border-amber-200" :
                            "bg-slate-50 text-slate-700 border-slate-200"
                          )}>
                            {rec.tierKey}
                          </Badge>
                          <span className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded flex items-center gap-1">
                            {rec.generationStatus === 'generated' ? <Zap className="w-3 h-3" /> : <Target className="w-3 h-3" />}
                            {rec.playType.replace(/_/g, " ")}
                          </span>
                          {rec.generationStatus === 'generated' && (
                            <span className="text-[10px] text-muted-foreground ml-2 flex items-center gap-1">
                              <Zap className="w-3 h-3" /> AI
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground ml-2 flex items-center gap-1">
                            <Clock className="w-3 h-3" /> {formatReportDate(rec.generatedAt)}
                          </span>
                        </div>
                        <h3 className="text-lg font-bold text-foreground">{rec.title}</h3>
                      </div>
                      {rec.targetIdentity && (
                        <Link href={rec.targetType === 'account' ? `/intent/accounts/${rec.targetId}${qs ? `?${qs}` : ''}` : `/intent/contacts/${rec.targetId}${qs ? `?${qs}` : ''}`} className="text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-md flex items-center gap-1.5 transition-colors">
                          {rec.targetType === 'account' ? <Building2 className="w-3 h-3" /> : <User className="w-3 h-3" />}
                          {rec.targetIdentity} <ArrowRight className="w-3 h-3 ml-1 opacity-50" />
                        </Link>
                      )}
                    </div>

                    <p className="text-sm text-slate-700 mb-4 leading-relaxed">{rec.summary}</p>

                    <div className="bg-slate-50 border rounded-md p-3 space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Action Plan</p>
                      <div className="space-y-2">
                        {(rec.options || []).map((opt: any, i: number) => (
                          <div key={i} className="flex items-start gap-3 bg-white p-2.5 rounded border shadow-sm">
                            <Target className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                            <div>
                              <p className="text-sm font-semibold text-foreground">{opt.title}</p>
                              <p className="text-xs text-muted-foreground mt-0.5">{opt.rationale}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {status === "pending" && (
                    <div className="bg-slate-50/50 border-l md:w-48 p-4 flex flex-col justify-center gap-3 shrink-0">
                      <Button
                        data-testid={`button-accept-play-${rec.id}`}
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white gap-2 font-semibold"
                        onClick={() => handleAction(rec.id, "actioned")}
                        disabled={updateRec.isPending}
                      >
                        <CheckSquare className="w-4 h-4" /> Accept Play
                      </Button>
                      <Button
                        data-testid={`button-dismiss-play-${rec.id}`}
                        variant="outline"
                        className="w-full gap-2 text-slate-600 hover:text-red-600 hover:bg-red-50"
                        onClick={() => handleAction(rec.id, "dismissed")}
                        disabled={updateRec.isPending}
                      >
                        <XSquare className="w-4 h-4" /> Dismiss
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
