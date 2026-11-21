import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const mocks=vi.hoisted(()=>({lookup:vi.fn(),request:vi.fn()}));
vi.mock("node:dns/promises",()=>({lookup:mocks.lookup}));
vi.mock("node:https",()=>({default:{request:mocks.request}}));
vi.mock("node:http",()=>({default:{request:mocks.request}}));
import { readSourcePage } from "../lib/researchOpportunityInterpreter";

let responses: Array<{status?:number;html?:string;location?:string}>;
beforeEach(()=>{
  vi.clearAllMocks();
  responses=[];
  mocks.lookup.mockResolvedValue([{address:"93.184.216.34",family:4}]);
  mocks.request.mockImplementation((_url,options,callback)=>{
    expect(options.family).toBe(4);
    const next=responses.shift()!;
    return {setTimeout:vi.fn(),on:vi.fn(),end:()=>queueMicrotask(()=>{
      const response=new EventEmitter() as any;
      response.statusCode=next.status??200;
      response.headers={"content-type":"text/html",location:next.location};
      response.destroy=vi.fn();
      callback(response);
      response.emit("data",Buffer.from(next.html??""));
      response.emit("end");
    })};
  });
});
describe("public news reader",()=>{
  it("reads article text beyond the former 8,000-character cutoff with pinned DNS",async()=>{
    responses.push({html:`<nav>Unrelated news</nav><article>${"A".repeat(9000)} Important conservation approval change.</article>`});
    const result=await readSourcePage("https://news.example/story");
    expect(result?.text).toContain("Important conservation approval change.");
    expect(result?.text).not.toContain("Unrelated news");
    expect(result?.limited).toBe(false);
  });
  it("revalidates redirects and never fetches private targets",async()=>{
    responses.push({status:302,location:"http://internal.example/secret"});
    mocks.lookup.mockResolvedValueOnce([{address:"93.184.216.34",family:4}])
      .mockResolvedValueOnce([{address:"127.0.0.1",family:4}]);
    expect(await readSourcePage("https://news.example/story")).toBeNull();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("follows bounded public redirects and reports content safety limits honestly",async()=>{
    responses.push({status:301,location:"/article"},{html:`<article>${"B".repeat(101000)}</article>`});
    const result=await readSourcePage("https://news.example/old");
    expect(result?.limited).toBe(true);
    expect(result?.text).toHaveLength(100000);
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
});
