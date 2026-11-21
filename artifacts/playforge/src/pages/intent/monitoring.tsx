import { useMemo,useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useSelectMonitoringRosterAudience } from "@workspace/api-client-react";
import { Activity,AlertCircle,CheckCircle2,Loader2,Pause,Play,Plus,Save,Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  type IntentMonitoringSchedule,
  useIntentMonitoringSchedules,
  useIntentScopeOptions,
  useSaveIntentMonitoringSchedule,
  useSetIntentMonitoringScheduleStatus,
} from "@/hooks/use-intent";
import { useToast } from "@/hooks/use-toast";
import { formatReportDateTime } from "@/lib/reportTime";
import MonitoringAccountPicker from "@/components/intent/MonitoringAccountPicker";
import MonitoringBatchAccounts, {type MonitoringBatchSelection} from "@/components/intent/MonitoringBatchAccounts";
import MonitoringAnalysisLinks from "@/components/intent/MonitoringAnalysisLinks";
import MonitoringRetryControls from "@/components/intent/MonitoringRetryControls";
import MonitoringHistory from "@/components/intent/MonitoringHistory";

type FormState={
  id?:number;name:string;enabled:boolean;clientId:number|null;dailyLimit:100|200|400|500|1000;
  audienceIds:number[];segmentIds:number[];accountIds:number[];categoryIds:number[];
};

const emptyForm=(number=1):FormState=>({
  name:`Monitoring schedule ${number}`,enabled:true,clientId:null,dailyLimit:100,
  audienceIds:[],segmentIds:[],accountIds:[],categoryIds:[],
});

function toForm(schedule:IntentMonitoringSchedule):FormState{
  return {id:schedule.id,name:schedule.name,enabled:schedule.enabled,clientId:schedule.clientId??null,
     dailyLimit:schedule.dailyLimit as 100|200|400|500|1000,audienceIds:schedule.audienceIds||[],
    segmentIds:schedule.segmentIds||[],accountIds:schedule.accountIds||[],categoryIds:schedule.categoryIds||[]};
}

function toggle(values:number[],id:number){return values.includes(id)?values.filter(value=>value!==id):[...values,id];}

export default function IntentMonitoringPage(){
  const {data,isLoading,isError: schedulesError,refetch: reloadSchedules}=useIntentMonitoringSchedules();
  const schedules=data?.schedules||[];
  const [form,setForm]=useState<FormState|null>(null);
  const [batchSelection,setBatchSelection]=useState<MonitoringBatchSelection|null>(null);
  const {data:scopeOptions,isLoading:scopeLoading,isError:scopeError,refetch:reloadScope}=useIntentScopeOptions(form?.clientId||undefined,true,false);
  const saveSchedule=useSaveIntentMonitoringSchedule();
  const queryClient=useQueryClient();
  const selectRoster=useSelectMonitoringRosterAudience();
  const setStatus=useSetIntentMonitoringScheduleStatus();
  const {toast}=useToast();
  const clients=scopeOptions?.clients||[];
  const categories=scopeOptions?.categories||[];
  const selectedCount=(form?.audienceIds.length||0)+(form?.segmentIds.length||0)+(form?.accountIds.length||0);
  const canSave=!scopeLoading&&!scopeError&&!selectRoster.isPending&&!!form?.name.trim()&&(!form.enabled||(selectedCount>0&&form.categoryIds.length>0));

  const chooseRoster=(clientId:number)=>{
    if(!form)return;
    const selectedForm=form;
    const existing=scopeOptions?.audiences.find(a=>a.clientId===clientId&&a.description===`System HP roster source; client=${clientId}`);
    if(existing&&form.audienceIds.includes(existing.id)){
      setForm({...form,audienceIds:form.audienceIds.filter(id=>id!==existing.id)});return;
    }
    selectRoster.mutate({data:{clientId}},{
      onSuccess:audience=>{
        queryClient.invalidateQueries({queryKey:["intent","scope-options"]});
        setForm(current=>current&&current.id===selectedForm.id&&current.clientId===selectedForm.clientId
          ? {...current,audienceIds:[...new Set([...current.audienceIds,audience.id])]}:current);
        toast({title:"Full roster selected",description:`${audience.memberCount.toLocaleString()} accounts. Monitoring starts only after saving an active schedule.`});
      },
      onError:error=>toast({variant:"destructive",title:"Could not select roster",description:error.message}),
    });
  };

  const labels=useMemo(()=>{
    const map=new Map<string,string>();
    for(const item of scopeOptions?.audiences||[])map.set(`a:${item.id}`,item.name);
    for(const item of scopeOptions?.segments||[])map.set(`s:${item.id}`,item.name);
    for(const item of scopeOptions?.accounts||[])map.set(`c:${item.id}`,item.name);
    return map;
  },[scopeOptions]);

  const save=()=>{
    if(!form)return;
    const {id,...payload}=form;
    saveSchedule.mutate({id,data:payload},{
      onSuccess:saved=>{
        toast({title:id?"Schedule updated":"Schedule created",description:saved.startedImmediately?"Schedule saved. An eligible batch has been requested for the updated scope. Daily and provider limits apply.":"The schedule details have been saved."});
        setForm(null);
      },
      onError:error=>toast({variant:"destructive",title:"Could not save schedule",description:error.message}),
    });
  };

  const pauseOrResume=(schedule:IntentMonitoringSchedule)=>{
    if(!schedule.enabled){
      const {id,...data}=toForm(schedule);
      saveSchedule.mutate({id,data:{...data,enabled:true}},{
        onSuccess:()=>toast({title:"Schedule resumed",description:"An eligible monitoring batch has been requested. Daily and provider limits apply."}),
        onError:error=>toast({variant:"destructive",title:"Could not resume schedule",description:error.message}),
      });
      return;
    }
    setStatus.mutate({id:schedule.id,enabled:false},{
      onSuccess:()=>toast({title:"Schedule paused",description:`${schedule.name} will not start another daily batch.`}),
      onError:error=>toast({variant:"destructive",title:"Could not pause schedule",description:error.message}),
    });
  };

  return <div className="flex min-h-full min-w-0 flex-col bg-background text-foreground">
    {batchSelection&&<MonitoringBatchAccounts key={`${batchSelection.configId}-${batchSelection.runId}-${batchSelection.status}-${batchSelection.lane}`}
      selection={batchSelection} onClose={()=>setBatchSelection(null)}/>}
    <header className="border-b bg-card px-6 py-5">
      <h1 className="text-2xl font-semibold tracking-tight">Continuous Monitoring</h1>
      <p className="mt-1 text-sm text-muted-foreground">Manage scheduled account research and review monitoring results.</p>
    </header>
    <div className="mx-auto w-full min-w-0 max-w-[1100px] space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-stone-900">Monitoring schedules</h2>
          <p className="mt-1 text-sm font-medium text-stone-500">Review, edit, pause, or add schedules for any client, database, segment, or account.</p>
        </div>
        <Button onClick={()=>setForm(emptyForm(schedules.length+1))}>
          <Plus className="mr-2 h-4 w-4"/>Add schedule
        </Button>
      </div>

      {schedulesError?<p role="alert" className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">Could not load monitoring schedules. <button className="underline" onClick={()=>reloadSchedules()}>Retry</button></p>:
      isLoading?<div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-stone-300"/></div>:
      schedules.length===0?<div className="rounded-xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <AlertCircle className="mx-auto mb-3 h-6 w-6 text-stone-400"/><p className="font-bold text-stone-800">No schedules yet</p>
        <p className="mt-1 text-sm text-stone-500">Create a schedule to begin continuous account research.</p>
      </div>:
      <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 [&>div]:min-w-0 [&>div]:break-words">
        {schedules.map(schedule=>{
          const scopeNames=[
            ...schedule.audienceIds.map(id=>labels.get(`a:${id}`)),
            ...schedule.segmentIds.map(id=>labels.get(`s:${id}`)),
            ...schedule.accountIds.map(id=>labels.get(`c:${id}`)),
          ].filter(Boolean);
          const scopeCount=schedule.audienceIds.length+schedule.segmentIds.length+schedule.accountIds.length;
          const clientName=clients.find(client=>client.id===schedule.clientId)?.name;
          const runId=schedule.latestRun?.providers.find(run=>run.runId)?.runId;
          const openBatch:OpenBatch=(status,lane)=>{
            if(runId)setBatchSelection({configId:schedule.id,runId,scheduleName:schedule.name,status,lane});
          };
          return <div key={schedule.id} className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${schedule.enabled?"bg-emerald-500":"bg-stone-300"}`}/>
                  <h3 className="truncate font-bold text-stone-900">{schedule.name}</h3>
                </div>
                <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-stone-400">{clientName||"All clients"} · {schedule.dailyLimit.toLocaleString()} accounts/day</p>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${schedule.enabled?"bg-emerald-50 text-emerald-700":"bg-stone-100 text-stone-500"}`}>{schedule.enabled?"Active":"Paused"}</span>
            </div>
            <div className="mt-4 rounded-lg bg-stone-50 p-3 text-xs text-stone-600">
              <div className="font-bold text-stone-700">{scopeCount} selected source{scopeCount===1?"":"s"}</div>
              <div className="mt-1 line-clamp-2">{scopeNames.length?scopeNames.slice(0,5).join(", "):scopeCount?"Open Edit to view selected sources":"No scope selected"}{scopeNames.length>5?` +${scopeNames.length-5} more`:""}</div>
            </div>
            {schedule.latestRun&&<MonitoringProgress run={schedule.latestRun} onOpen={openBatch}/>}
            {schedule.latestRun?.providers.some(run=>run.status==="failed"||run.status==="partial"||run.accountsFailed>0)&&<MonitoringRetryControls schedule={schedule}/>}
            {schedule.latestRun&&<p className="mt-2 text-[11px] text-stone-500">Latest run is one batch, not the total saved scope. Updated selections apply to eligible batches; recently checked or already queued accounts are skipped.</p>}
            <LaneProgress counts={schedule.latestRun?.laneCounts??schedule.lastLaneCounts} onOpen={runId?openBatch:undefined}/>
            <MonitoringAnalysisLinks accountIds={schedule.accountIds} clientId={schedule.clientId??null} categoryIds={schedule.categoryIds}/>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-stone-500">
              <span className="flex items-center gap-1.5"><Activity className="h-3.5 w-3.5"/>{schedule.lastScheduledAt?`${formatReportDateTime(schedule.lastScheduledAt)} · ${schedule.lastScheduledCount||0} accounts`:"Not run yet"}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={()=>setForm(toForm(schedule))}><Settings2 className="mr-1.5 h-3.5 w-3.5"/>Edit</Button>
                <Button variant="outline" size="sm" onClick={()=>pauseOrResume(schedule)} disabled={setStatus.isPending||saveSchedule.isPending}>{schedule.enabled?<><Pause className="mr-1.5 h-3.5 w-3.5"/>Pause</>:<><Play className="mr-1.5 h-3.5 w-3.5"/>Resume</>}</Button>
              </div>
            </div>
          </div>;
        })}
      </div>}

      <MonitoringHistory schedules={schedules}/>
      <p className="text-xs text-stone-500">
        Completed checks include successful searches with no results; they do not measure usable business news.
        {" "}<Link href="/intent/inbound-accounts#monitored-accounts" className="font-semibold text-blue-700 underline">Review stored findings and research quality by account →</Link>
      </p>

      {form&&<Dialog open onOpenChange={open=>{if(!open&&!saveSchedule.isPending)setForm(null);}}>
        <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-4xl overflow-y-auto bg-white p-6">
        <DialogHeader className="mb-4 pr-6">
          <DialogTitle>{form.id?"Edit schedule":"Add monitoring schedule"}</DialogTitle>
          <DialogDescription>A schedule can reuse the same client or database as another schedule.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 sm:grid-cols-3">
          <label className="space-y-2 sm:col-span-2"><span className="text-xs font-bold uppercase tracking-widest text-stone-500">Schedule name</span>
            <input value={form.name} onChange={event=>setForm({...form,name:event.target.value})} className="h-10 w-full rounded-md border border-stone-200 px-3 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
          </label>
          <label className="space-y-2"><span className="text-xs font-bold uppercase tracking-widest text-stone-500">Status</span>
            <select value={form.enabled?"active":"paused"} onChange={event=>setForm({...form,enabled:event.target.value==="active"})} className="h-10 w-full rounded-md border border-stone-200 bg-white px-3 text-sm font-semibold"><option value="active">Active</option><option value="paused">Paused</option></select>
          </label>
          <label className="space-y-2"><span className="text-xs font-bold uppercase tracking-widest text-stone-500">Client</span>
            <select value={form.clientId||""} onChange={event=>setForm({...form,clientId:event.target.value?Number(event.target.value):null,audienceIds:[],segmentIds:[],accountIds:[]})} className="h-10 w-full rounded-md border border-stone-200 bg-white px-3 text-sm font-semibold"><option value="">All clients</option>{clients.map(client=><option key={client.id} value={client.id}>{client.name}</option>)}</select>
          </label>
          <label className="space-y-2"><span className="text-xs font-bold uppercase tracking-widest text-stone-500">Daily limit</span>
            <select value={form.dailyLimit} onChange={event=>setForm({...form,dailyLimit:Number(event.target.value) as FormState["dailyLimit"]})} className="h-10 w-full rounded-md border border-stone-200 bg-white px-3 text-sm font-semibold">{[100,200,400,500,1000].map(value=><option key={value} value={value}>{value.toLocaleString()} accounts/day</option>)}</select>
          </label>
        </div>

        <div className="mt-7 grid gap-6 lg:grid-cols-2">
          <section><div className="mb-2 flex items-center justify-between"><h4 className="text-xs font-bold uppercase tracking-widest text-stone-500">Databases, segments, and accounts</h4><span className="text-[10px] font-bold uppercase text-stone-400">{selectedCount} selected</span></div>
            <div className="max-h-80 overflow-y-auto rounded-lg border border-stone-200 bg-stone-50 p-2">
              {scopeLoading?<Loader2 className="mx-auto my-8 h-5 w-5 animate-spin text-stone-300"/>:<>
                {(scopeOptions?.rosters||[]).map(roster=>{
                  const audience=scopeOptions?.audiences.find(a=>a.clientId===roster.clientId&&a.description===`System HP roster source; client=${roster.clientId}`);
                  return <fieldset key={`roster-${roster.clientId}`} disabled={selectRoster.isPending} className="rounded border border-sky-200 bg-sky-50 disabled:opacity-60">
                    <ScopeCheck checked={!!audience&&form.audienceIds.includes(audience.id)} onChange={()=>chooseRoster(roster.clientId)}
                      name={roster.name} detail={`HP account register · ${roster.memberCount.toLocaleString()} accounts · includes GCC and other segments`}/>
                  </fieldset>;
                })}
                {selectRoster.isPending&&<p role="status" className="px-2 py-1 text-xs text-stone-600">Preparing full roster selection…</p>}
                {(scopeOptions?.audiences||[]).filter(item=>!(scopeOptions?.rosters||[]).some(r=>item.clientId===r.clientId&&item.description===`System HP roster source; client=${r.clientId}`)).map(item=><ScopeCheck key={`a-${item.id}`} checked={form.audienceIds.includes(item.id)} onChange={()=>setForm({...form,audienceIds:toggle(form.audienceIds,item.id)})} name={item.name} detail="Database / audience"/> )}
                {(scopeOptions?.segments||[]).map(item=><ScopeCheck key={`s-${item.id}`} checked={form.segmentIds.includes(item.id)} onChange={()=>setForm({...form,segmentIds:toggle(form.segmentIds,item.id)})} name={item.name} detail={`CRM segment · ${(item.memberCount||0).toLocaleString()} contacts`}/>)}
              </>}
            </div>
          </section>
          <section><div className="mb-2 flex items-center justify-between"><h4 className="text-xs font-bold uppercase tracking-widest text-stone-500">Product categories</h4><span className="text-[10px] font-bold uppercase text-stone-400">{form.categoryIds.length} selected</span></div>
            <div className="max-h-80 overflow-y-auto rounded-lg border border-stone-200 bg-stone-50 p-2">
              {categories.map(item=><ScopeCheck key={item.id} checked={form.categoryIds.includes(item.id)} onChange={()=>setForm({...form,categoryIds:toggle(form.categoryIds,item.id)})} name={item.name} detail="Product category"/>)}
            </div>
          </section>
        </div>
        {scopeError&&<p role="alert" className="mt-4 text-xs text-red-700">Could not load lists or categories. <button className="underline" onClick={()=>reloadScope()}>Retry</button></p>}
        <div className="mt-6 rounded-lg border p-4">
          <MonitoringAccountPicker key={form.clientId??"all"} clientId={form.clientId} audiences={scopeOptions?.audiences??[]}
            selectedAudienceIds={form.audienceIds}
            onSelectAudience={id=>setForm(current=>current?{...current,audienceIds:[...new Set([...current.audienceIds,id])]}:null)}
            selected={form.accountIds} onChange={ids=>setForm(current=>current?{...current,accountIds:ids}:null)}/>
        </div>
        {form.accountIds.length>0&&<p className="mt-3 text-xs text-stone-600">Monitoring will include these {form.accountIds.length} individual accounts{form.audienceIds.length||form.segmentIds.length?" plus all eligible accounts from the databases/segments selected above (duplicates count once)":", not all accounts in the database"}. The daily limit is a ceiling, not additional accounts.</p>}
        <p className="mt-3 text-xs text-stone-600">Saving a new, resumed, or changed active scope requests an eligible batch. Accounts checked within the last seven days and accounts already queued are not repeated. Latest run shows a historical batch, not the full saved scope.</p>
        {form.enabled&&!canSave&&<p className="mt-4 text-xs font-semibold text-amber-700">Active schedules need at least one database, segment, or account and one product category.</p>}
        <div className="mt-6 flex justify-end gap-3 border-t border-stone-100 pt-5"><Button variant="outline" onClick={()=>setForm(null)}>Cancel</Button><Button onClick={save} disabled={!canSave||saveSchedule.isPending} className="bg-stone-900 font-bold text-white hover:bg-stone-800">{saveSchedule.isPending?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<Save className="mr-2 h-4 w-4"/>}Save schedule</Button></div>
        </DialogContent>
      </Dialog>}
    </div>
  </div>;
}

function MonitoringProgress({run,onOpen}:{run:NonNullable<IntentMonitoringSchedule["latestRun"]>;onOpen: OpenBatch}){
  const done=run.accountsCompleted+run.accountsFailed;
  const progress=run.accountsTotal?Math.min(100,Math.round(done/run.accountsTotal*100)):0;
  const failedProviders=run.providers.filter(provider=>provider.status==="failed"||provider.status==="partial"||provider.accountsFailed>0);
  return <div className="mt-4 space-y-2 rounded-lg border border-stone-200 bg-white p-3">
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="flex items-center gap-1.5 font-bold capitalize text-stone-800">
        {run.status==="queued"||run.status==="running"?<Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-600"/>:run.status==="completed"?<CheckCircle2 className="h-3.5 w-3.5 text-emerald-600"/>:<AlertCircle className="h-3.5 w-3.5 text-amber-600"/>}
        Latest run: {run.status}
      </span>
      <span className="font-bold text-stone-600"><CountLink value={done} label="View processed batch accounts" onClick={()=>onOpen("processed")}/> / <CountLink value={run.accountsTotal} label="View all batch accounts" onClick={()=>onOpen("all")}/></span>
    </div>
    <div className="h-1.5 overflow-hidden rounded-full bg-stone-100" aria-label={`${progress}% complete`}><div className="h-full rounded-full bg-emerald-500 transition-all duration-500" style={{width:`${progress}%`}}/></div>
    <div className="flex flex-wrap gap-x-3 text-[10px] font-semibold text-stone-500">
      <CountLink value={run.accountsCompleted} label="View completed batch accounts" suffix="complete" onClick={()=>onOpen("completed")}/>
      <CountLink value={run.accountsRemaining} label="View remaining batch accounts" suffix="remaining" onClick={()=>onOpen("remaining")}/>
      {run.accountsFailed>0&&<CountLink value={run.accountsFailed} label="View failed batch accounts" suffix="failed" onClick={()=>onOpen("failed")}/>}
    </div>
    {failedProviders.length>0&&<p className="rounded bg-amber-50 px-2 py-1.5 text-[10px] font-semibold text-amber-800">Provider issues: {failedProviders.map(provider=>`${provider.provider} (${provider.accountsFailed||"run"} failed)`).join(", ")}.</p>}
    {run.capacityWarning&&<p className="rounded bg-amber-50 px-2 py-1.5 text-[10px] font-semibold text-amber-800">Provider capacity covered only part of this batch. Remaining accounts will be considered later.</p>}
  </div>;
}

type OpenBatch = (status: MonitoringBatchSelection["status"], lane?: "warm" | "prospect") => void;
function CountLink({value,label,suffix,onClick}:{value:number;label:string;suffix?:string;onClick?:()=>void}) {
  return <button type="button" aria-label={label} disabled={!value || !onClick} onClick={onClick}
    className="font-semibold underline decoration-dotted underline-offset-2 hover:text-emerald-800 disabled:no-underline disabled:opacity-60">
    {value.toLocaleString()}{suffix ? ` ${suffix}` : ""}
  </button>;
}
function LaneProgress({counts,onOpen}:{counts:IntentMonitoringSchedule["lastLaneCounts"];onOpen?:OpenBatch}){
  if(!counts)return null;
  return <div className="mt-3 grid grid-cols-2 gap-2">
    {(["warm","prospect"] as const).map(lane=>{
      const item=counts[lane];
      return <div key={lane} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
        <div className="text-[10px] font-bold uppercase tracking-wider text-stone-700">{lane==="warm"?"Warm rechecks":"Prospect discovery"}</div>
        <div className="mt-1 text-xs text-stone-600">{item.eligible.toLocaleString()} eligible · <CountLink value={item.scheduled} label={`View ${lane} scheduled accounts`} suffix="scheduled" onClick={onOpen?()=>onOpen("all",lane):undefined}/></div>
        <div className="mt-1 text-[10px] font-semibold text-stone-500">
          <CountLink value={item.completed} label={`View ${lane} completed accounts`} suffix="completed" onClick={onOpen?()=>onOpen("completed",lane):undefined}/> · {item.deferred} deferred · <CountLink value={item.failed} label={`View ${lane} failed accounts`} suffix="failed" onClick={onOpen?()=>onOpen("failed",lane):undefined}/>
        </div>
      </div>;
    })}
  </div>;
}

function ScopeCheck({checked,onChange,name,detail}:{checked:boolean;onChange:()=>void;name:string;detail:string}){
  return <label className="flex cursor-pointer items-center gap-3 rounded-md p-2 hover:bg-white"><input type="checkbox" checked={checked} onChange={onChange} className="h-4 w-4 rounded border-stone-300 text-emerald-600 focus:ring-emerald-600"/><span className="min-w-0"><span className="block truncate text-sm font-semibold text-stone-800">{name}</span><span className="block truncate text-[10px] font-medium text-stone-500">{detail}</span></span></label>;
}
