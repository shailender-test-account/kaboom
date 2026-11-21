// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import PlanDetail from "./PlanDetail";
const mocks=vi.hoisted(()=>({source:vi.fn(),approve:vi.fn(),copy:vi.fn(),draft:false,missingDomains:false,missingCountry:false}));
vi.mock("@/hooks/use-toast",()=>({useToast:()=>({toast:vi.fn()})}));
vi.mock("./CommitteeContacts",()=>({default:()=>null}));
vi.mock("./PlanDomains",()=>({default:({onDirtyChange}:{onDirtyChange:(dirty:boolean)=>void})=><button onClick={()=>onDirtyChange(true)}>Change domain inline</button>}));
vi.mock("./api",()=>({
  useBuyingPlan:()=>({data:{plan:{id:1,name:"Committee plan",status:mocks.draft?"draft":"approved",revision:1,config:{clientId:9,country:mocks.missingCountry?undefined:"India",accountIds:[1,2],categories:["Security"],designations:["CISO"],limitPerAccount:3}},
    targets:[1,2].map(id=>({id,company_id:id,name:`Account ${id}`,domain:mocks.missingDomains?"":`company${id}.com`,status:"pending",requests:0,responses:0,found:0,error:null}))}}),
  useApproveBuyingPlan:()=>({mutate:mocks.approve}),
  useSourceBuyingAccount:()=>({mutateAsync:mocks.source}),
  useCopyBuyingPlan:()=>({mutate:mocks.copy,isPending:false}),
}));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.clearAllMocks();mocks.draft=false;mocks.missingDomains=false;mocks.missingCountry=false;});
it("does not source on mount and stops before the next account if the page is left",async()=>{
  vi.spyOn(window,"confirm").mockReturnValue(true);
  let finish!:()=>void;
  mocks.source.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const {unmount}=render(<PlanDetail id={1} canManage configured maxRequests={20} onEdit={vi.fn()}/>);
  expect(mocks.source).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Source selected accounts (2 pending)"));
  expect(mocks.source).toHaveBeenCalledTimes(1);
  unmount();
  await act(async()=>{finish();});
  expect(mocks.source).toHaveBeenCalledTimes(1);
});
it("keeps sourcing and approval actions out of view-only roles",()=>{
  render(<PlanDetail id={1} canManage={false} configured maxRequests={20} onEdit={vi.fn()}/>);
  expect(screen.queryByText("Source selected accounts (2 pending)")).toBeNull();
  expect(mocks.source).not.toHaveBeenCalled();
});
it("allows explicit internal-first sourcing without an external provider and explains zero-match fallback",async()=>{
  const confirm=vi.spyOn(window,"confirm").mockReturnValue(true);
  mocks.source.mockResolvedValue(undefined);
  render(<PlanDetail id={1} canManage configured={false} maxRequests={20} onEdit={vi.fn()}/>);
  const button=screen.getByRole("button",{name:"Source selected accounts (2 pending)"}) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(screen.getByRole("alert").textContent).toContain("Internal matching is available");
  expect(mocks.source).not.toHaveBeenCalled();
  await act(async()=>{fireEvent.click(button);});
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("zero internal matches"));
  expect(mocks.source).toHaveBeenCalledTimes(2);
});
it("approves an internal-first plan without a provider but still requires manual sourcing",()=>{
  mocks.draft=true;
  vi.spyOn(window,"confirm").mockReturnValue(true);
  render(<PlanDetail id={1} canManage configured={false} maxRequests={20} onEdit={vi.fn()}/>);
  const button=screen.getByRole("button",{name:"Approve plan"}) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  expect(mocks.approve).toHaveBeenCalledOnce();
  expect(mocks.source).not.toHaveBeenCalled();
});
it("keeps an incomplete saved draft editable but blocks approval and sourcing",()=>{
  mocks.draft=true;mocks.missingDomains=true;
  const onEdit=vi.fn();
  render(<PlanDetail id={1} canManage configured maxRequests={20} onEdit={onEdit}/>);
  expect(screen.getByRole("status").textContent).toContain("2 selected accounts need a confirmed company domain");
  expect((screen.getByRole("button",{name:"Approve plan"}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Approve plan"}));
  fireEvent.click(screen.getByRole("button",{name:"Edit draft"}));
  expect(onEdit).toHaveBeenCalledOnce();
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(mocks.source).not.toHaveBeenCalled();
});
it("allows approval after the saved draft has domains, but never starts sourcing automatically",()=>{
  mocks.draft=true;
  vi.spyOn(window,"confirm").mockReturnValue(true);
  render(<PlanDetail id={1} canManage configured maxRequests={20} onEdit={vi.fn()}/>);
  const approve=screen.getByRole("button",{name:"Approve plan"}) as HTMLButtonElement;
  expect(approve.disabled).toBe(false);
  fireEvent.click(approve);
  expect(mocks.approve).toHaveBeenCalledWith({id:1,revision:1},expect.any(Object));
  expect(mocks.source).not.toHaveBeenCalled();
});
it("blocks approval while inline domain changes have not been saved",()=>{
  mocks.draft=true;
  render(<PlanDetail id={1} canManage configured maxRequests={20} onEdit={vi.fn()}/>);
  fireEvent.click(screen.getByRole("button",{name:"Change domain inline"}));
  expect((screen.getByRole("button",{name:"Approve plan"}) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.approve).not.toHaveBeenCalled();
});
it("does not silently run an older approved plan without a contact country",()=>{
  mocks.missingCountry=true;
  render(<PlanDetail id={1} canManage configured maxRequests={20} onEdit={vi.fn()}/>);
  expect(screen.getByRole("alert").textContent).toContain("no country filter");
  expect((screen.getByRole("button",{name:"Source selected accounts (2 pending)"}) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.source).not.toHaveBeenCalled();
});
it("lets admins explicitly copy frozen targeting without approval or spending, including legacy plans",()=>{
  mocks.missingCountry=true;
  const onCopy=vi.fn();
  mocks.copy.mockImplementationOnce((_id,options)=>options.onSuccess({config:{country:undefined},accounts:[]}));
  render(<PlanDetail id={1} canManage configured={false} maxRequests={20} onEdit={vi.fn()} onCopy={onCopy}/>);
  expect(mocks.copy).not.toHaveBeenCalled();
  expect(screen.queryByRole("button",{name:"Edit draft"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Copy to new draft"}));
  expect(mocks.copy).toHaveBeenCalledWith(1,expect.any(Object));
  expect(onCopy).toHaveBeenCalledOnce();
  expect(mocks.source).not.toHaveBeenCalled();
  expect(mocks.approve).not.toHaveBeenCalled();
});
it("does not expose copying to viewers or for an existing draft",()=>{
  const props={id:1,configured:true,maxRequests:20,onEdit:vi.fn(),onCopy:vi.fn()};
  const {unmount}=render(<PlanDetail {...props} canManage={false}/>);
  expect(screen.queryByRole("button",{name:"Copy to new draft"})).toBeNull();
  unmount();mocks.draft=true;
  render(<PlanDetail {...props} canManage/>);
  expect(screen.queryByRole("button",{name:"Copy to new draft"})).toBeNull();
});
