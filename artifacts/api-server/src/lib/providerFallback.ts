import { IntentProviderError, type ProviderEvent, type ProviderResult, type ProviderStats } from "./intentProviders";

export type ProviderScope = {
  clientId?: number;
  audienceId?: number;
  accountIds?: number[];
  eventTypes?: string[];
  country?: string;
  beforeRequest?: () => Promise<void>;
  afterRequest?: () => Promise<void>;
};

type ProviderFetcher=(tenantId:number,scope:ProviderScope)=>Promise<ProviderResult<ProviderEvent>>;

function mergeProviderStats(primary:ProviderStats,fallback:ProviderStats):ProviderStats{
  return {
    requests:primary.requests+fallback.requests,
    pages:primary.pages+fallback.pages,
    retries:primary.retries+fallback.retries,
    rateLimited:primary.rateLimited+fallback.rateLimited,
    recordsFetched:primary.recordsFetched+fallback.recordsFetched,
    recordsNormalized:primary.recordsNormalized+fallback.recordsNormalized,
    failures:fallback.failures,
    usageLimit:(primary.usageLimit??0)+(fallback.usageLimit??0),
    fallbackProvider:"perplexity",
    primaryProviderFailed:true,
    primaryFailures:primary.failures,
  };
}

export async function fetchTavilyWithPerplexityFallback(
  tenantId:number,
  scope:ProviderScope,
  dependencies:{fetchTavilyEvents:ProviderFetcher;fetchPerplexityEvents:ProviderFetcher},
):Promise<ProviderResult<ProviderEvent>>{
  let primaryRows:ProviderEvent[]=[];
  let primaryStats:ProviderStats;
  try{
    const primary=await dependencies.fetchTavilyEvents(tenantId,scope);
    if(!primary.stats.failures.length)return primary;
    primaryRows=primary.rows;
    primaryStats=primary.stats;
  }catch(error){
    if(!(error instanceof IntentProviderError))throw error;
    primaryRows=error.partialRows;
    primaryStats=error.stats;
  }
  try{
    const fallback=await dependencies.fetchPerplexityEvents(tenantId,scope);
    return {rows:[...primaryRows,...fallback.rows],stats:mergeProviderStats(primaryStats,fallback.stats)};
  }catch(error){
    if(!(error instanceof IntentProviderError))throw error;
    throw new IntentProviderError(
      `Tavily failed and Perplexity fallback also failed: ${error.message}`,
      mergeProviderStats(primaryStats,error.stats),
      error.status,
      [...primaryRows,...error.partialRows],
    );
  }
}