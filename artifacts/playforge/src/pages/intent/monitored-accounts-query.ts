/** Readiness gates the curated list, never the evidence on a specific account. */
export function monitoredAccountsQuery(page:number,search:string,accountId?:number){
  const scope=accountId?"account-research":"complete-research";
  const params=new URLSearchParams({page:String(page),pageSize:"5",completeResearch:String(!accountId)});
  if(accountId)params.set("accountId",String(accountId));
  if(search)params.set("search",search);
  return {params,queryKey:["intent","opportunities","monitored-accounts",scope,page,search,accountId]};
}
