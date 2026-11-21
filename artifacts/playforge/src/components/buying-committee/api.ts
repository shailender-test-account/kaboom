import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { saveBuyingCommitteeContact, type CommitteeContactSaveInput } from "@workspace/api-client-react";

export const committeeCategories = ["Security", "Collaboration", "IT Hardware", "Business Services"] as const;
export type CommitteeCategory = typeof committeeCategories[number];
export interface CommitteeAccount { id: number; name: string; domain: string | null; segment?: string }
export interface CommitteeAccount { id: number; name: string; domain: string | null; segment?: string }
export interface CommitteeAccount { id: number; name: string; domain: string | null; segment?: string }
export interface CommitteeAccount { id: number; name: string; domain: string | null; segment?: string }
export interface CommitteeAccount { id: number; name: string; domain: string | null; segment?: string }
export interface CommitteeConfig {
  country?: string;
  clientId: number; name: string; includeRoster: boolean; audienceIds: number[]; accountIds: number[];
  categories: CommitteeCategory[]; designations: string[]; limitPerAccount: number; domains: Record<string,string>;
  requestBudget?: number;
}
export interface CommitteeTarget {
  id: number; company_id: number; name: string; domain: string; status: string;
  requests: number; responses: number; found: number; error: string | null;
}
export interface CommitteePlan {
  id: number; client_id: number; name: string; config: CommitteeConfig; status: "draft"|"approved";
  revision: number; approved_at: string|null; created_at: string;
}
export interface CommitteePerson {
  id: string; companyId: number; companyName: string; name: string; title: string|null;
  email: string|null; phone: string|null; linkedin: string|null; location: string|null;
  categories: CommitteeCategory[]; source: string; engagementSources: string[]; engaged: boolean; sourcedAt: string|null;
  crmContactId?: number|null;
}
function query(params: Record<string,unknown>) {
  const q=new URLSearchParams();
  Object.entries(params).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=="")q.set(k,Array.isArray(v)?v.join(","):String(v));});
  return q.toString();
}
export async function committeeRequest<T>(path:string,body?:unknown,method=body===undefined?"GET":"POST",signal?:AbortSignal):Promise<T> {
  const r=await fetch(`/api/buying-committee${path}`,{method,credentials:"include",signal,
    ...(body===undefined?{}:{headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});
  const data=await r.json();
  if(!r.ok)throw new Error(data.error||`Buying committee request failed (${r.status})`);
  return data as T;
}
export function useBuyingOptions() {
  return useQuery({queryKey:["buying-committee","options"],queryFn:()=>committeeRequest<{
    clients:{id:number;name:string}[];databases:{id:number;name:string;clientId:number|null}[];
    configured:boolean;maxRequests:number;canManage:boolean;countries:string[];
  }>("/options")});
}
export function useBuyingAccounts(filters:{clientId?:number;includeRoster:boolean;audienceIds:number[];search:string;page:number;segment?:string}) {
  return useQuery({queryKey:["buying-committee","accounts",filters],enabled:!!filters.clientId,
    queryFn:({signal})=>committeeRequest<{items:CommitteeAccount[];total:number;page:number;pageSize:number;segments:string[]}>(`/accounts?${query(filters)}`,undefined,"GET",signal)});
}
export function useBuyingSuggestions(categories:CommitteeCategory[]) {
  return useQuery({queryKey:["buying-committee","suggestions",categories],enabled:categories.length>0,
    queryFn:()=>committeeRequest<{designations:string[]}>(`/suggestions?${query({categories})}`)});
}
export function useBuyingPlans(clientId?:number,page=1) {
  return useQuery({queryKey:["buying-committee","plans",clientId,page],enabled:!!clientId,
    queryFn:()=>committeeRequest<{items:CommitteePlan[];total:number}>(`/plans?${query({clientId,page})}`)});
}
export function useBuyingPlan(id?:number) {
  return useQuery({queryKey:["buying-committee","plan",id],enabled:!!id,
    refetchInterval:query=>query.state.data?.targets.some(target=>target.status==="processing")?10_000:false,
    queryFn:()=>committeeRequest<{plan:CommitteePlan;targets:CommitteeTarget[]}>(`/plans/${id}`)});
}
export function useCommitteeContacts(filters:{clientId:number;accountIds:number[];page?:number;pageSize?:number;country?:string;planPage?:number},enabled=true) {
  return useQuery({queryKey:["buying-committee","contacts",filters],enabled:enabled&&filters.accountIds.length>0,
    queryFn:({signal})=>committeeRequest<{items:CommitteePerson[];total:number;page:number;pageSize:number;canExport:boolean;canSave?:boolean;
      sourcing?:{accounts:number;completedAccounts:number;pendingAccounts:number;processingAccounts:number;failedAccounts:number;returnedContacts:number;lastCompletedAt:string|null};
      savedPlans?:{items:{planId:number;clientId:number;planName:string;planStatus:string;country:string|null;companyId:number;companyName:string;status:string}[];page:number;hasMore:boolean}
    }>(`/contacts?${query(filters)}`,undefined,"GET",signal)});
}
export function useSaveCommitteeContact() {
  const qc=useQueryClient();
  return useMutation({mutationFn:(input:CommitteeContactSaveInput)=>saveBuyingCommitteeContact(input),retry:false,
    onSuccess:()=>qc.invalidateQueries({predicate:q=>["buying-committee","contacts","contact","hp-bi","hp-bi-detail","hp-parent-pivot"].includes(String(q.queryKey[0])) || /^\/api\/(contacts|analytics\/hp-bi)(\/|$)/.test(String(q.queryKey[0]))})});
}
export function committeeExportUrl(clientId: number, accountIds: number[], country?: string) {
  return `/api/buying-committee/contacts/export?${query({ clientId, accountIds, country })}`;
}
export function useSaveBuyingPlan(id?:number) {
  const qc=useQueryClient();
  return useMutation({mutationFn:(config:CommitteeConfig)=>committeeRequest<{plan:CommitteePlan;targets:CommitteeTarget[]}>(id?`/plans/${id}`:"/plans",config,id?"PUT":"POST"),
    onSuccess:()=>qc.invalidateQueries({queryKey:["buying-committee"]})});
}
export function useApproveBuyingPlan() {
  const qc=useQueryClient();
  return useMutation({mutationFn:({id,revision}:{id:number;revision:number})=>committeeRequest<{plan:CommitteePlan;targets:CommitteeTarget[]}>(`/plans/${id}/approve`,{revision,confirm:true}),
    onSuccess:()=>qc.invalidateQueries({queryKey:["buying-committee"]})});
}
export interface CommitteeCopy {
  config: CommitteeConfig;
  accounts: { id: number; name: string }[];
}
export function useCopyBuyingPlan() {
  return useMutation({mutationFn:(id:number)=>committeeRequest<CommitteeCopy>(`/plans/${id}/copy`,{}),retry:false});
}
/** One account per bounded request. Navigation never automatically retries paid work. */
export function useSourceBuyingAccount() {
  const qc=useQueryClient();
  return useMutation({mutationFn:({id,accountId,retry=false}:{id:number;accountId:number;retry?:boolean})=>committeeRequest<{status:string}>(`/plans/${id}/source`,{accountId,confirm:true,retry}),
    onSettled:()=>{qc.invalidateQueries({queryKey:["buying-committee"]});}});
}
