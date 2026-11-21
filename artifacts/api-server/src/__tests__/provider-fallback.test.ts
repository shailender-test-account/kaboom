import {describe,expect,it,vi} from "vitest";
import {IntentProviderError,type ProviderEvent,type ProviderStats} from "../lib/intentProviders";
import {fetchTavilyWithPerplexityFallback} from "../lib/providerFallback";

const stats=(overrides:Partial<ProviderStats>={}):ProviderStats=>({
  requests:1,pages:0,retries:0,rateLimited:0,recordsFetched:0,recordsNormalized:0,failures:[],...overrides,
});
const row=(provider:"tavily"|"perplexity",sourceUrl:string):ProviderEvent=>({
  eventType:"hiring",occurredAt:new Date().toISOString(),sourceUrl,excerpt:"India hiring signal",confidence:70,
  context:{searchProvider:provider,sourceIdentity:sourceUrl},
});

describe("Tavily to Perplexity research fallback",()=>{
  it("does not call Perplexity when Tavily succeeds, including a valid zero-result search",async()=>{
    const tavily=vi.fn().mockResolvedValue({rows:[],stats:stats()});
    const perplexity=vi.fn();
    await expect(fetchTavilyWithPerplexityFallback(7,{accountIds:[1]},{fetchTavilyEvents:tavily,fetchPerplexityEvents:perplexity})).resolves.toMatchObject({rows:[]});
    expect(perplexity).not.toHaveBeenCalled();
  });

  it("uses Perplexity when Tavily fails and preserves provider provenance",async()=>{
    const tavily=vi.fn().mockRejectedValue(new IntentProviderError("Tavily returned HTTP 432",stats({failures:["limit"]}),432));
    const perplexity=vi.fn().mockResolvedValue({rows:[row("perplexity","https://news.example/fallback")],stats:stats({pages:1,recordsFetched:1,recordsNormalized:1})});
    const result=await fetchTavilyWithPerplexityFallback(7,{accountIds:[1],country:"India"},{fetchTavilyEvents:tavily,fetchPerplexityEvents:perplexity});
    expect(perplexity).toHaveBeenCalledWith(7,expect.objectContaining({accountIds:[1],country:"India"}));
    expect(result.rows[0].context.searchProvider).toBe("perplexity");
    expect(result.stats).toMatchObject({fallbackProvider:"perplexity",primaryProviderFailed:true,requests:2});
  });

  it("falls back after a partial Tavily failure and retains both providers' citable rows",async()=>{
    const tavily=vi.fn().mockResolvedValue({rows:[row("tavily","https://news.example/primary")],stats:stats({failures:["one search plan failed"]})});
    const perplexity=vi.fn().mockResolvedValue({rows:[row("perplexity","https://news.example/fallback")],stats:stats()});
    const result=await fetchTavilyWithPerplexityFallback(7,{accountIds:[1]},{fetchTavilyEvents:tavily,fetchPerplexityEvents:perplexity});
    expect(result.rows.map(item=>item.context.searchProvider)).toEqual(["tavily","perplexity"]);
  });
});