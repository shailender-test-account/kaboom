import { useState, useEffect } from "react";
import { useIntentConfig, useUpdateIntentConfig, useIntentAccounts } from "@/hooks/use-intent";
import { IntentPageHeader } from "@/components/intent/ui";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Save, Loader2, RotateCcw, HelpCircle } from "lucide-react";
import { IntentCatalogManager } from "@/components/intent/IntentCatalogManager";
import { IntentInboundRouting } from "@/components/intent/IntentInboundRouting";
import { useAuthContext } from "@/contexts/AuthContext";

export default function IntentSettingsPage() {
  const { user } = useAuthContext();
  const { data: config, isLoading, isError, error } = useIntentConfig();
  const updateConfig = useUpdateIntentConfig();
  const { toast } = useToast();

  const { data: accountsData } = useIntentAccounts({ page: 1, pageSize: 1, sortBy: "score", sortDir: "desc" });
  const topAccount = accountsData?.accounts?.[0];

  const [formData, setFormData] = useState<any>(null);

  useEffect(() => {
    if (config && !formData) {
      setFormData(JSON.parse(JSON.stringify(config)));
    }
  }, [config, formData]);

  const handleSave = () => {
    updateConfig.mutate(formData, {
      onSuccess: () => {
        toast({ title: "Configuration saved", description: "Intent engine parameters updated." });
      },
      onError: (err) => {
        toast({ title: "Failed to save", description: err.message, variant: "destructive" });
      }
    });
  };

  const restoreQuestionnaireDefaults = () => {
    const currentByKey = new Map<string, any>((formData.questionnaireDimensions || []).map((dimension: any) => [dimension.key, dimension]));
    const restored = (config.questionnaireDefaults || []).map((defaults: any) => ({
      ...JSON.parse(JSON.stringify(defaults)),
      id: currentByKey.get(defaults.key)?.id,
    }));
    setFormData({ ...formData, questionnaireDimensions: restored });
    toast({ title: "Defaults restored", description: "Review the built-in questionnaire model, then save to apply it." });
  };

  if (isLoading || !formData) {
    return <div className="p-6 max-w-4xl mx-auto flex items-center justify-center min-h-[400px]"><Loader2 className="w-8 h-8 animate-spin text-stone-400" /></div>;
  }

  if (isError) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="p-4 text-rose-600 bg-rose-50 border border-rose-200 rounded-lg text-center">
          <p className="font-bold">Failed to load configuration</p>
          <p className="text-sm mt-1">{error?.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full font-sans text-stone-900">
      <IntentPageHeader
        title="Transparent scoring model"
        breadcrumbs="CATEGORY-SPECIFIC INTENT"
      />

      <div className="p-6 max-w-[1200px] mx-auto w-full space-y-6">

        {/* Top visual reference section matching screenshots */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Left Column */}
          <div className="xl:col-span-2">
            <div className="bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden h-full">
              <div className="p-6">
                <div className="flex items-start gap-3 mb-8">
                  <div className="w-8 h-8 rounded-full bg-stone-100 flex items-center justify-center shrink-0">
                    <HelpCircle className="w-4 h-4 text-stone-500" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-stone-900">Account × category score</h2>
                    <p className="text-[11px] font-medium text-stone-500 mt-1 max-w-xl leading-relaxed">
                      Scores are calculated independently for each solution. One company can score high for one product category and low for another.
                    </p>
                  </div>
                </div>

                <div className="space-y-6">
                  {[
                    { title: "First-party engagement", desc: "Forms, event answers, demos and declared timing", percent: 30, color: "bg-blue-500" },
                    { title: "Web-trigger strength", desc: "Severity, specificity and category relevance", percent: 25, color: "bg-[#0F2B20]" },
                    { title: "Account-category fit", desc: "Industry, scale, technology and use case", percent: 20, color: "bg-violet-500" },
                    { title: "Recency", desc: "Time decay based on the expected buying window", percent: 15, color: "bg-amber-500" },
                    { title: "Multi-source confirmation", desc: "Independent evidence supporting the same need", percent: 10, color: "bg-rose-500" },
                  ].map((item, i) => (
                    <div key={i} className="flex items-center gap-4">
                      <div className="flex-1">
                        <p className="text-xs font-bold text-stone-900">{item.title}</p>
                        <p className="text-[10px] font-medium text-stone-400 mt-0.5">{item.desc}</p>
                        <div className="w-full h-1.5 bg-stone-100 rounded-full mt-2 overflow-hidden">
                          <div className={`h-full ${item.color} rounded-full`} style={{ width: `${item.percent}%` }} />
                        </div>
                      </div>
                      <div className="text-sm font-black text-stone-900 w-12 text-right">{item.percent}%</div>
                    </div>
                  ))}
                </div>

                <div className="mt-8 bg-emerald-50 rounded-lg p-3 flex items-center gap-2 border border-emerald-100">
                  <div className="w-4 h-4 rounded-full bg-emerald-100 flex items-center justify-center shrink-0 text-emerald-600">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-2.5 h-2.5" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  </div>
                  <p className="text-[11px] font-bold text-emerald-800">Confidence is separate: it measures source quality and completeness, not buying intensity.</p>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column */}
          <div className="xl:col-span-1 space-y-6">
            <div className="bg-[#1A382A] text-white rounded-xl p-6 shadow-lg relative overflow-hidden">
              <p className="text-[10px] font-bold uppercase tracking-widest text-[#bef264] mb-1 relative z-10">Worked example</p>

              {topAccount ? (
                <>
                  <h2 className="text-sm font-bold text-white mb-6 relative z-10 truncate" title={`${topAccount.name} × ${topAccount.productAnalysis?.bestProduct?.productName || 'General Intent'}`}>
                    {topAccount.name} × {topAccount.productAnalysis?.bestProduct?.productName || 'General Intent'}
                  </h2>

                  <div className="flex items-center gap-6 relative z-10">
                    <div className="relative w-24 h-24 shrink-0">
                      <svg className="w-full h-full transform -rotate-90" viewBox="0 0 36 36">
                        <path className="text-[#0F2B20]" strokeWidth="4" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                        <path className="text-[#bef264]" strokeDasharray={`${Math.min(100, Math.max(0, topAccount.score))}, 100`} strokeWidth="4" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                      </svg>
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="text-2xl font-black">{topAccount.score}</span>
                        <span className="text-[9px] font-bold uppercase tracking-widest text-[#8BAA9D]">{topAccount.tierLabel || 'Ranked'}</span>
                      </div>
                    </div>

                    <div className="flex-1 space-y-2">
                      <div className="flex justify-between text-[10px] font-bold">
                        <span className="text-[#8BAA9D]">Contributions</span>
                        <span className="text-white">{topAccount.contributions?.length || 0} active</span>
                      </div>
                      <div className="flex justify-between text-[10px] font-bold">
                        <span className="text-[#8BAA9D]">Signals</span>
                        <span className="text-white">{topAccount.signals?.length || 0} verified</span>
                      </div>
                      <div className="flex justify-between text-[10px] font-bold">
                        <span className="text-[#8BAA9D]">Contacts</span>
                        <span className="text-white">{topAccount.contacts?.length || 0} active</span>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center h-24 relative z-10 text-[#8BAA9D]">
                  <p className="text-xs font-bold text-center">No active account available for example</p>
                </div>
              )}
            </div>

            <div className="bg-white rounded-xl border border-stone-200 shadow-sm p-6">
              <h2 className="text-sm font-bold text-stone-900 mb-5">Status thresholds (Live config)</h2>
              <div className="space-y-4">
                {(formData.tiers || []).map((tier: any) => {
                  let colorClass = "bg-stone-500";
                  let hint = "Track for confirmation";
                  if (tier.key === "hot") {
                    colorClass = "bg-rose-500";
                    hint = "Sales action within 48 hours";
                  } else if (tier.key === "warm") {
                    colorClass = "bg-amber-500";
                    hint = "Nurture + monitor";
                  }

                  // Calculate the top range based on next tier
                  const nextTier = formData.tiers.find((t: any) => t.minScore > tier.minScore);
                  const topRange = nextTier ? nextTier.minScore - 1 : 100;

                  return (
                    <div key={tier.key} className="flex items-center justify-between border-b border-stone-100 last:border-0 pb-4 last:pb-0">
                      <div>
                        <div className="flex items-center gap-1.5">
                          <div className={`w-1.5 h-1.5 rounded-full ${colorClass}`} />
                          <span className="text-[13px] font-bold text-stone-900">{tier.label}</span>
                        </div>
                        <p className="text-[10px] font-medium text-stone-400 mt-1">{hint}</p>
                      </div>
                      <span className="text-xs font-black text-stone-900">{tier.minScore}-{topRange}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Editable Configuration Below */}
        <div className="pt-8 border-t border-stone-200 mt-8">
          <h3 className="text-lg font-bold text-stone-900 mb-6">Editable Configuration</h3>

          <div className="grid gap-6">
            <Card className="shadow-sm border-stone-200">
              <CardHeader className="border-b bg-stone-50/50 pb-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <CardTitle className="text-base">Questionnaire answer scoring</CardTitle>
                    <CardDescription className="mt-1">
                      Set each dimension&apos;s maximum contribution and the strength assigned when an answer contains a keyword.
                    </CardDescription>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={restoreQuestionnaireDefaults}
                    disabled={updateConfig.isPending}
                    className="h-8 text-xs font-bold bg-white border-stone-200"
                  >
                    <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Restore defaults
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-5">
                  {(formData.questionnaireDimensions || []).map((dimension: any, dimensionIndex: number) => (
                    <div key={dimension.key} className="rounded-lg border border-stone-100 bg-stone-50 p-5">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                        <div className="flex-1">
                          <Label className="font-bold text-stone-900 text-sm">{dimension.label}</Label>
                          <p className="mt-0.5 text-xs font-medium text-stone-500">Rules are checked from top to bottom; answers without a match use the built-in semantic fallback.</p>
                        </div>
                        <div className="w-full sm:w-32">
                          <Label className="text-[10px] uppercase font-bold tracking-widest text-stone-500">Max points</Label>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            value={dimension.maxPoints}
                            onChange={(event) => {
                              const questionnaireDimensions = [...formData.questionnaireDimensions];
                              questionnaireDimensions[dimensionIndex] = { ...dimension, maxPoints: Number(event.target.value) };
                              setFormData({ ...formData, questionnaireDimensions });
                            }}
                            className="mt-1.5 bg-white font-mono h-9 text-sm"
                          />
                        </div>
                      </div>
                      <div className="mt-5 space-y-2">
                        {dimension.rules.map((rule: any, ruleIndex: number) => (
                          <div key={rule.id} className="grid gap-3 rounded-md border border-stone-200 bg-white p-3 md:grid-cols-[minmax(140px,0.8fr)_minmax(220px,2fr)_100px] items-start">
                            <div>
                              <Label className="text-[9px] uppercase font-bold tracking-widest text-stone-400">Rule name</Label>
                              <Input
                                value={rule.label}
                                onChange={(event) => {
                                  const questionnaireDimensions = [...formData.questionnaireDimensions];
                                  const rules = [...dimension.rules];
                                  rules[ruleIndex] = { ...rule, label: event.target.value };
                                  questionnaireDimensions[dimensionIndex] = { ...dimension, rules };
                                  setFormData({ ...formData, questionnaireDimensions });
                                }}
                                className="mt-1 h-8 text-xs font-semibold"
                              />
                            </div>
                            <div>
                              <Label className="text-[9px] uppercase font-bold tracking-widest text-stone-400">Answer contains (comma separated)</Label>
                              <Input
                                value={rule.keywords.join(", ")}
                                placeholder="approved, funded, ready"
                                onChange={(event) => {
                                  const questionnaireDimensions = [...formData.questionnaireDimensions];
                                  const rules = [...dimension.rules];
                                  rules[ruleIndex] = {
                                    ...rule,
                                    keywords: event.target.value.split(",").map((keyword: string) => keyword.trim()).filter(Boolean),
                                  };
                                  questionnaireDimensions[dimensionIndex] = { ...dimension, rules };
                                  setFormData({ ...formData, questionnaireDimensions });
                                }}
                                className="mt-1 h-8 text-xs font-medium"
                              />
                            </div>
                            <div>
                              <Label className="text-[9px] uppercase font-bold tracking-widest text-stone-400">Strength %</Label>
                              <Input
                                type="number"
                                min={0}
                                max={100}
                                value={rule.strength}
                                onChange={(event) => {
                                  const questionnaireDimensions = [...formData.questionnaireDimensions];
                                  const rules = [...dimension.rules];
                                  rules[ruleIndex] = { ...rule, strength: Number(event.target.value) };
                                  questionnaireDimensions[dimensionIndex] = { ...dimension, rules };
                                  setFormData({ ...formData, questionnaireDimensions });
                                }}
                                className="mt-1 bg-white font-mono h-8 text-xs"
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <div className="flex justify-end gap-3 pt-2">
              <Button variant="outline" onClick={() => setFormData(JSON.parse(JSON.stringify(config)))} disabled={updateConfig.isPending} className="h-9 font-bold text-xs">
                Discard changes
              </Button>
              <Button onClick={handleSave} disabled={updateConfig.isPending} className="bg-emerald-700 hover:bg-emerald-800 text-white h-9 font-bold text-xs">
                {updateConfig.isPending && <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />}
                Save Configuration
              </Button>
            </div>
          </div>
        </div>

        {/* Inbound Warm-Lead Routing (Admin Only) */}
        {user?.role === 'admin' && (
          <div className="pt-8 border-t border-stone-200 mt-8">
            <IntentInboundRouting />
          </div>
        )}

      </div>
    </div>
  );
}
