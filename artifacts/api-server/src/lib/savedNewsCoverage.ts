import { createHash } from "node:crypto";
import { researchSourceText } from "./researchSourceFacts";

/** Content identity, not check time or the presence of another story's brief. */
export function savedNewsFingerprint(row: {
  source_url?: string | null; excerpt: string; raw_evidence?: any; context?: any;
}) {
  return createHash("sha256").update(JSON.stringify([
    row.source_url, researchSourceText(row.raw_evidence?.excerpt ?? row.excerpt, row.context),
    row.context?.scope?.country ?? row.raw_evidence?.context?.scope?.country ?? "India",
  ])).digest("hex");
}

export function hasSavedNewsCoverage(row: Parameters<typeof savedNewsFingerprint>[0]) {
  const marker = row.context?.savedNewsInterpretation;
  return marker?.version === 2 && marker.status === "completed"
    && marker.fingerprint === savedNewsFingerprint(row);
}

export function contiguousSourceAnchor(original: string, displayPassage: string) {
  const normalize=(text:string)=>text.toLowerCase().replace(/\s+/g," ").trim();
  const display=normalize(displayPassage);
  // Display passages can concatenate non-adjacent sentences. A citation must
  // instead be one actual, continuous substring of the original source.
  const passage=original.split(/\n+|(?<=[.!?])\s+/).map(text=>text.trim())
    .find(text=>text.length>=80 && display.includes(normalize(text)));
  return (passage??original).slice(0,700);
}

export function mergeStoryDirections<T extends {theme:string;sourceQuote:string;sourceUrls:string[]}>(directions:T[]):T[] {
  const points=new Map<string,T>();
  for(const point of directions) {
    const key=JSON.stringify([point.theme,point.sourceUrls[0],point.sourceQuote.toLowerCase().replace(/\s+/g," ").trim()]);
    const previous=points.get(key);
    points.set(key,previous?{...previous,sourceUrls:[...new Set([...previous.sourceUrls,...point.sourceUrls])]}:point);
  }
  return [...points.values()];
}

/** Retry omitted stories only; never infer completion from another story's result. */
export async function completeStoryAssessments<D extends {url:string},R extends {
  sourceAssessments:Array<{sourceUrl:string}>;
}>(documents:D[],initial:R,repair:(document:D)=>Promise<R>):Promise<R[]> {
  const results=[initial];
  for(const document of documents) {
    if(results.some(result=>result.sourceAssessments.some(item=>item.sourceUrl===document.url)))continue;
    const result=await repair(document);
    if(!result.sourceAssessments.some(item=>item.sourceUrl===document.url))
      throw new Error(`Incomplete analysis after targeted retry: ${document.url}; coverage not marked`);
    results.push(result);
  }
  return results;
}

/** Bind short model-facing identifiers to supplied URLs; never fuzzy-match a URL. */
export function bindStorySourceIds(output:any,documents:Array<{sourceId:string;url:string}>) {
  const result=structuredClone(output);
  const sources=new Map(documents.map(document=>[document.sourceId,document.url]));
  const resolve=(id:unknown)=>{
    if(typeof id!=="string"||!sources.has(id))throw new Error("Unknown supplied news source identifier");
    return sources.get(id)!;
  };
  for(const point of Array.isArray(result.businessDirections)?result.businessDirections:[]) {
    if(point.sourceIds!==undefined) {
      if(!Array.isArray(point.sourceIds)||!point.sourceIds.length)throw new Error("Missing supplied news source identifier");
      point.sourceUrls=point.sourceIds.map(resolve);
      delete point.sourceIds;
    }
  }
  for(const point of [
    ...(Array.isArray(result.strategicHypotheses)?result.strategicHypotheses:[]),
    ...(Array.isArray(result.sourceAssessments)?result.sourceAssessments:[]),
  ]) {
    if(point.sourceId!==undefined) {
      point.sourceUrl=resolve(point.sourceId);
      delete point.sourceId;
    }
  }
  return result;
}

/** The configured product owns its category; a model label cannot expand scope. */
export function bindHypothesesToCatalog(output:any,catalog:Array<{id:number;discoveryCategory:string|null}>) {
  const result=structuredClone(output);
  if(!Array.isArray(result.strategicHypotheses))return result;
  const allowed=new Set(["IT Hardware","Business Collaboration","Security","Business Services"]);
  result.strategicHypotheses=result.strategicHypotheses.filter((point:any)=>{
    const id=typeof point.productId==="string"&&/^[1-9]\d*$/.test(point.productId)?Number(point.productId):point.productId;
    const product=catalog.find(row=>row.id===id);
    if(!product)throw new Error("Unknown catalog product in saved-news interpretation");
    if(!product.discoveryCategory||!allowed.has(product.discoveryCategory)) {
      for(const assessment of result.sourceAssessments??[])if(assessment.sourceUrl===point.sourceUrl)
        assessment.analysisNote=`A product suggestion outside the four supported HP categories was excluded. ${assessment.analysisNote??""}`;
      return false;
    }
    if(allowed.has(point.category)&&point.category!==product.discoveryCategory)
      throw new Error("Conflicting catalog product/category in saved-news interpretation");
    point.productId=product.id;
    point.category=product.discoveryCategory;
    return true;
  });
  return result;
}

/** A short displayed passage must not invalidate a quote verified in the saved source. */
export function containsSavedSourceQuote(finding: {
  sourcePassage: string; excerpt: string; raw_evidence?: any; context?: any;
}, quote: string) {
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
  if (!quote.trim()) return false;
  return [finding.sourcePassage, finding.raw_evidence?.excerpt, finding.context?.originalExcerpt, finding.excerpt]
    .some(text => typeof text === "string" && normalize(text).includes(normalize(quote)));
}
