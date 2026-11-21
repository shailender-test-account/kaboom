import { expect, it } from "vitest";
import { bindHypothesesToCatalog, bindStorySourceIds, completeStoryAssessments, contiguousSourceAnchor, containsSavedSourceQuote, hasSavedNewsCoverage, mergeStoryDirections, savedNewsFingerprint } from "./savedNewsCoverage";

it("tracks each story rather than skipping an entire partly interpreted account", () => {
  const a = {source_url:"https://example.com/a",excerpt:"Bentley India is building an AI team.",context:{} as any};
  a.context.savedNewsInterpretation = {version:2,status:"completed",fingerprint:savedNewsFingerprint(a)};
  expect(hasSavedNewsCoverage(a)).toBe(true);
  expect(hasSavedNewsCoverage({...a,source_url:"https://example.com/b"})).toBe(false);
  expect(hasSavedNewsCoverage({...a,excerpt:"Bentley India has changed its AI team plans."})).toBe(false);
  expect(hasSavedNewsCoverage({...a,context:{savedNewsInterpretation:{version:1,status:"completed"}}})).toBe(false);
});

it("accepts original-source anchors outside the shortened display passage, not invented quotes", () => {
  const finding={sourcePassage:"Bentley India presented AI tools.",excerpt:"Displayed summary",
    raw_evidence:{excerpt:"Bentley India presented AI tools. The Pune team will develop engineering automation."}};
  expect(containsSavedSourceQuote(finding,"The Pune team will develop engineering automation.")).toBe(true);
  expect(containsSavedSourceQuote(finding,"Bentley ordered 500 HP workstations.")).toBe(false);
});

it("never uses concatenated non-adjacent display passages as a supposedly verbatim citation",()=>{
  const fact="Bentley Systems is building an AI Acceleration team in Pune for engineering automation and product design.";
  const original=`Bentley Systems India\nNavigation and other intervening text.\n${fact}\nMore navigation.`;
  const anchor=contiguousSourceAnchor(original,`Bentley Systems India ${fact}`);
  expect(anchor).toBe(fact);
  expect(original.includes(anchor)).toBe(true);
});
it("does not drop secondary story coverage when deduplicating a shared source anchor",()=>{
  const first={theme:"Engineering workflows",sourceQuote:"A verified sentence from the primary source.",sourceUrls:["https://example.com/a","https://example.com/b"]};
  const duplicate={...first,sourceUrls:["https://example.com/a"]};
  expect(mergeStoryDirections([first,duplicate])[0].sourceUrls).toEqual(first.sourceUrls);
  expect(mergeStoryDirections([duplicate,first])[0].sourceUrls).toEqual(first.sourceUrls);
  expect(mergeStoryDirections([first,{...duplicate,theme:"A distinct business direction"}])).toHaveLength(2);
});
it("repairs only an omitted source, retaining already assessed and explicit no-fit stories",async()=>{
  const documents=["a","b","c"].map(url=>({url}));
  const initial={sourceAssessments:[{sourceUrl:"a",note:"Relevant direction"},{sourceUrl:"c",note:"No defensible product fit"}]};
  const calls:string[]=[];
  const results=await completeStoryAssessments(documents,initial,async document=>{
    calls.push(document.url);
    return {sourceAssessments:[{sourceUrl:document.url,note:"Targeted assessment"}]};
  });
  expect(calls).toEqual(["b"]);
  expect(results[0]).toBe(initial);
  expect(results.flatMap(r=>r.sourceAssessments).map(r=>r.sourceUrl).sort()).toEqual(["a","b","c"]);
});
it("leaves a story pending if its single-story repair also omits the assessment",async()=>{
  await expect(completeStoryAssessments([{url:"unassessed"}],{sourceAssessments:[]},
    async()=>({sourceAssessments:[]}))).rejects.toThrow("coverage not marked");
});
it("binds short source identities instead of trusting reconstructed URL slugs",()=>{
  const documents=[{sourceId:"A1",url:"https://example.com/fieldops"},{sourceId:"A2",url:"https://example.com/plant"}];
  const raw={businessDirections:[{sourceIds:["A1","A2"],sourceUrls:["https://example.com/fieldops-stock"]}],
    strategicHypotheses:[{sourceId:"A1",sourceUrl:"https://example.com/fieldops-stock"}],
    sourceAssessments:[{sourceId:"A1",analysisNote:"Conditional product direction."}]};
  const bound=bindStorySourceIds(raw,documents);
  expect(bound.businessDirections[0].sourceUrls).toEqual(documents.map(document=>document.url));
  expect(bound.strategicHypotheses[0].sourceUrl).toBe(documents[0].url);
  expect(bound.sourceAssessments[0].sourceUrl).toBe(documents[0].url);
  expect(bound.sourceAssessments[0]).not.toHaveProperty("sourceId");
  expect(raw.strategicHypotheses[0].sourceUrl).toContain("-stock");
});
it("rejects unknown source identities and does not silently repair guessed URLs",()=>{
  expect(()=>bindStorySourceIds({sourceAssessments:[{sourceId:"A2"}]},[{sourceId:"A1",url:"https://example.com/a"}]))
    .toThrow("Unknown supplied");
  const raw={sourceAssessments:[{sourceUrl:"https://example.com/a-stock"}]};
  expect(bindStorySourceIds(raw,[{sourceId:"A1",url:"https://example.com/a"}])).toEqual(raw);
});
it("uses a known product's category for noncanonical model labels without changing input",()=>{
  const raw={strategicHypotheses:[{productId:"7",category:"Engineering workstations"}]};
  const bound=bindHypothesesToCatalog(raw,[{id:7,discoveryCategory:"IT Hardware"}]);
  expect(bound.strategicHypotheses[0]).toEqual({productId:7,category:"IT Hardware"});
  expect(raw.strategicHypotheses[0].category).toBe("Engineering workstations");
  expect(()=>bindHypothesesToCatalog({strategicHypotheses:[{productId:7,category:"Security"}]},
    [{id:7,discoveryCategory:"IT Hardware"}])).toThrow("Conflicting catalog");
  expect(()=>bindHypothesesToCatalog(raw,[])).toThrow("Unknown catalog");
});
it("explains excluded off-scope products without inventing a supported category",()=>{
  const raw={strategicHypotheses:[{productId:8,category:"Other",sourceUrl:"https://example.com/news"}],
    sourceAssessments:[{sourceUrl:"https://example.com/news",analysisNote:"Business direction observed."}]};
  const bound=bindHypothesesToCatalog(raw,[{id:8,discoveryCategory:null}]);
  expect(bound.strategicHypotheses).toEqual([]);
  expect(bound.sourceAssessments[0].analysisNote).toContain("outside the four supported");
});
