// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import CommitteeContacts from "./CommitteeContacts";
const query = vi.hoisted(()=>vi.fn());
vi.mock("./api",()=>({useCommitteeContacts:query,useBuyingOptions:()=>({data:{countries:["India","United States"]}}),
  useSaveCommitteeContact:()=>({isPending:false}),committeeExportUrl:()=>"/api/intent/buying-committee/contacts/export"}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const person=(id:string,engaged:boolean)=>({id,companyId:1,companyName:"Account A",name:id,title:null,email:null,phone:null,linkedin:null,location:null,categories:[],source:"Apollo",engaged,engagementSources:engaged?["Lead form"]:[],sourcedAt:null});
it("highlights only verified engagement in bold green, with accessible evidence labels",()=>{
  query.mockReturnValue({data:{items:[person("Verified person",true),person("Unengaged prospect",false)],total:2}});
  render(<CommitteeContacts clientId={9} accountIds={[1]}/>);
  expect(screen.getByText("Verified person").className).toContain("font-bold text-green-700");
  expect(screen.getByText("Unengaged prospect").className).not.toContain("text-green");
  expect(screen.getByText("Engaged: Lead form")).toBeTruthy();
  expect(screen.getAllByText("Email not available")).toHaveLength(2);
});
it("pages people and resets pagination when the account scope changes",()=>{
  query.mockImplementation((filters:any)=>({data:{items:[person(`Person page ${filters.page}`,false)],total:26}}));
  const {rerender}=render(<CommitteeContacts clientId={9} accountIds={[1]}/>);
  fireEvent.click(screen.getByText("Next"));
  expect(query.mock.calls.at(-1)?.[0]).toMatchObject({page:2,pageSize:25});
  rerender(<CommitteeContacts clientId={9} accountIds={[2]}/>);
  expect(query.mock.calls.at(-1)?.[0]).toMatchObject({accountIds:[2],page:1});
});
it("filters contact country and resets to the first page without starting sourcing",()=>{
  query.mockImplementation((filters:any)=>({data:{items:[person(`Person page ${filters.page}`,false)],total:26}}));
  render(<CommitteeContacts clientId={9} accountIds={[1]}/>);
  fireEvent.click(screen.getByText("Next"));
  fireEvent.change(screen.getByRole("combobox",{name:"Filter sourced contact country"}),{target:{value:"India"}});
  expect(query.mock.calls.at(-1)?.[0]).toMatchObject({country:"India",page:1,pageSize:25});
  expect(screen.getByText(/Sourced contact country: India/)).toBeTruthy();
});
it("shows a completed zero-result sourcing run instead of implying data disappeared",()=>{
  query.mockReturnValue({data:{items:[],total:0,sourcing:{accounts:1,completedAccounts:1,pendingAccounts:0,processingAccounts:0,failedAccounts:0,returnedContacts:0,lastCompletedAt:"2026-10-26T09:00:00Z"}}});
  render(<CommitteeContacts clientId={9} accountIds={[1]} pageSize={5}/>);
  expect(query.mock.calls.at(-1)?.[0]).toMatchObject({page:1,pageSize:5});
  expect(screen.getByRole("status").textContent).toContain("1/1 member accounts");
  expect(screen.getByRole("status").textContent).toContain("Sourcing returned 0 matching people");
  expect(screen.queryByRole("link",{name:"Review Buying Committee plans"})).toBeNull();
});
it("links each legal-account plan and country separately and bounds the preview with independent paging",()=>{
  query.mockImplementation((filters:any)=>({data:{items:[],total:0,sourcing:{accounts:2,completedAccounts:1,pendingAccounts:1,processingAccounts:0,failedAccounts:0,returnedContacts:0,lastCompletedAt:null},
    savedPlans:{items:[
      {planId:301,companyId:1,companyName:"Legal A",planName:"India plan",country:"India",planStatus:"approved",status:"completed"},
      {planId:302,companyId:2,companyName:"Legal B",planName:"UK plan",country:"United Kingdom",planStatus:"draft",status:"pending"},
    ],page:filters.planPage,hasMore:true}}}));
  render(<CommitteeContacts clientId={9} accountIds={[1,2]}/>);
  expect(screen.getByRole("link",{name:"Legal A — India plan — India"}).getAttribute("href")).toBe("/intent/buying-committee?planId=301");
  expect(screen.getByRole("link",{name:"Legal B — UK plan — United Kingdom"}).getAttribute("href")).toBe("/intent/buying-committee?planId=302");
  fireEvent.click(screen.getByText("Next plans"));
  expect(query.mock.calls.at(-1)?.[0]).toMatchObject({planPage:2,page:1});
  fireEvent.change(screen.getByRole("combobox"),{target:{value:"India"}});
  expect(query.mock.calls.at(-1)?.[0]).toMatchObject({planPage:1,country:"India"});
});
it("keeps the account-card contact preview bounded to five people per page",()=>{
  query.mockImplementation((filters:any)=>({data:{items:[person(`Person page ${filters.page}`,false)],total:6}}));
  render(<CommitteeContacts clientId={9} accountIds={[1]} pageSize={5}/>);
  fireEvent.click(screen.getByText("Next"));
  expect(query.mock.calls.at(-1)?.[0]).toMatchObject({page:2,pageSize:5});
  expect(screen.getByText("Page 2 of 2 / 6 people")).toBeTruthy();
});

it("uses provider-neutral card labels without changing provenance or engagement",()=>{
  const prospect=person("Sourced person",false);
  query.mockReturnValue({data:{items:[prospect,person("Engaged person",true)],total:2,canExport:true,
    sourcing:{accounts:1,completedAccounts:1,pendingAccounts:0,processingAccounts:0,failedAccounts:0,returnedContacts:2,lastCompletedAt:null}}});
  const {container}=render(<CommitteeContacts clientId={9} accountIds={[1]}/>);
  expect(container.textContent).not.toMatch(/apollo/i);
  expect(screen.getAllByText("Sourced prospect")).toHaveLength(2);
  expect(screen.getByRole("combobox",{name:"Filter sourced contact country"})).toBeTruthy();
  expect(screen.getByText("Engaged: Lead form")).toBeTruthy();
  expect(prospect.source).toBe("Apollo");
});

it("labels internal committee members honestly and bolds only verified engaged names",()=>{
  const internal={...person("Internal person",false),source:"Internal database",crmContactId:1};
  const engaged={...person("Internal engaged person",true),source:"Internal database",crmContactId:2};
  query.mockReturnValue({data:{items:[internal,engaged],total:2,canExport:true}});
  render(<CommitteeContacts clientId={9} accountIds={[1]}/>);
  expect(screen.getAllByText("Internal database")).toHaveLength(2);
  expect(screen.getByText("Internal person").className).not.toContain("font-bold");
  expect(screen.getByText("Internal engaged person").className).toContain("font-bold");
  expect(screen.getByText("Internal engaged person").className).toContain("text-green");
});

it("keeps defaults concise and discloses explanations through accessible help buttons",()=>{
  query.mockReturnValue({data:{items:[person("Someone",false)],total:1,canExport:false,
    sourcing:{accounts:2,completedAccounts:1,pendingAccounts:0,processingAccounts:0,failedAccounts:1,returnedContacts:1,lastCompletedAt:null},
    savedPlans:{items:[{planId:7,companyId:1,companyName:"Legal A",planName:"P",country:"India",planStatus:"approved",status:"failed"}],page:1,hasMore:false}}});
  const {container}=render(<CommitteeContacts clientId={9} accountIds={[1,2]}/>);
  expect(container.textContent).not.toContain("Matching internal contacts are used first");
  expect(container.textContent).not.toContain("CSV includes all matching people");
  expect(screen.getByTestId("text-sourcing-attention").textContent).toContain("1 need attention");
  expect(screen.getByText("Export restricted to admins")).toBeTruthy();
  expect(screen.getByTestId("details-saved-plans").hasAttribute("open")).toBe(false);
  expect(screen.getByText("Saved plans (1)")).toBeTruthy();
  const help=screen.getByRole("button",{name:"About committee contacts"});
  expect(help.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(help);
  expect(help.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("note").textContent).toContain("Matching internal contacts are used first");
  fireEvent.keyDown(help,{key:"Escape"});
  expect(screen.queryByRole("note")).toBeNull();
});
