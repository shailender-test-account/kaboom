// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import IntentMonitoringPage from "./monitoring";

const state = vi.hoisted(()=>({schedules:[] as any[],scope:vi.fn(),save:vi.fn(),roster:vi.fn(),invalidate:vi.fn(),batch:vi.fn()}));
vi.mock("@tanstack/react-query",()=>({useQueryClient:()=>({invalidateQueries:state.invalidate})}));
vi.mock("@/components/intent/ui",()=>({IntentPageHeader:()=>null}));
vi.mock("@/components/intent/MonitoringHistory",()=>({default:()=>null}));
vi.mock("@/components/intent/MonitoringRetryControls",()=>({default:()=>null}));
vi.mock("@/hooks/use-toast",()=>({useToast:()=>({toast:vi.fn()})}));
vi.mock("@/components/intent/MonitoringAccountPicker",()=>({default:({onChange,onSelectAudience}:any)=><>
  <button onClick={()=>onChange([11,12])}>Choose two GCC accounts</button>
  <button onClick={()=>onSelectAudience(8)}>Monitor entire GCC list</button>
</>}));
vi.mock("@workspace/api-client-react",()=>({
  useSelectMonitoringRosterAudience:()=>({mutate:state.roster,isPending:false}),
  useGetMonitoringAccountOptions:()=>({data:{items:[{id:11,name:"GCC One"},{id:12,name:"GCC Two"}]}}),
  useGetMonitoringBatchAccounts:(params:any)=>{
    state.batch(params);
    return {data:{totalAccounts:21,items:[{accountId:11,accountName:"GCC One",available:true,status:params.status==="remaining"?"queued":"completed",provider:"tavily",completedAt:null,error:null}]},
      isLoading:false,isError:false,isFetching:false,refetch:vi.fn()};
  },
}));
it("opens pinned batch accounts from status and lane counts, with paging and account links",()=>{
  state.schedules=[{id:3,name:"HP roster monitoring",enabled:false,clientId:9,dailyLimit:200,
    audienceIds:[8],segmentIds:[],accountIds:[],categoryIds:[1],lastScheduledAt:null,
    latestRun:{status:"partial",accountsTotal:21,accountsCompleted:19,accountsFailed:1,accountsRemaining:1,
      providers:[{runId:77,provider:"tavily",status:"partial",accountsFailed:1}],
      laneCounts:{warm:{eligible:2,scheduled:2,completed:1,deferred:0,failed:1},
        prospect:{eligible:19,scheduled:19,completed:18,deferred:0,failed:0}}}}];
  render(<IntentMonitoringPage/>);
  fireEvent.click(screen.getByLabelText("View completed batch accounts"));
  expect(state.batch).toHaveBeenLastCalledWith({configId:3,runId:77,status:"completed",lane:undefined,page:1,pageSize:20});
  expect(screen.getByRole("link",{name:/GCC One.*View details/}).getAttribute("href")).toBe("/intent/accounts/11");
  fireEvent.click(screen.getByRole("button",{name:"Next"}));
  expect(state.batch.mock.lastCall?.[0].page).toBe(2);
  fireEvent.click(screen.getByRole("button",{name:"Close"}));
  fireEvent.click(screen.getByLabelText("View remaining batch accounts"));
  expect(state.batch.mock.lastCall?.[0]).toMatchObject({status:"remaining",page:1});
  fireEvent.click(screen.getByRole("button",{name:"Close"}));
  fireEvent.click(screen.getByLabelText("View warm failed accounts"));
  expect(state.batch.mock.lastCall?.[0]).toMatchObject({status:"failed",lane:"warm",runId:77,page:1});
});
vi.mock("@/hooks/use-intent",()=>({
  useIntentMonitoringSchedules:()=>({data:{schedules:state.schedules},refetch:vi.fn()}),
  useIntentScopeOptions:(...args:any[])=>{state.scope(...args);return {data:{clients:[{id:9,name:"HP"}],
    rosters:[{clientId:9,name:"HP — Full account roster",memberCount:9919}],
    audiences:[{id:8,name:"GCC list"}],segments:[],accounts:[],categories:[{id:7,name:"Security"}]},refetch:vi.fn()};},
  useSaveIntentMonitoringSchedule:()=>({mutate:state.save,isPending:false}),
  useSetIntentMonitoringScheduleStatus:()=>({mutate:vi.fn(),isPending:false}),
}));
afterEach(()=>{cleanup();state.schedules=[];state.save.mockClear();state.scope.mockClear();state.roster.mockReset();state.invalidate.mockClear();});
it("resumes directly from the card without opening an edit form",()=>{
  state.schedules=[{id:3,name:"HP roster monitoring",enabled:false,clientId:null,dailyLimit:200,
    audienceIds:[8],segmentIds:[],accountIds:[],categoryIds:[7],latestRun:null,lastLaneCounts:null}];
  render(<IntentMonitoringPage/>);
  fireEvent.click(screen.getByRole("button",{name:"Resume"}));
  expect(state.save.mock.calls[0][0]).toEqual({id:3,data:{
    name:"HP roster monitoring",enabled:true,clientId:null,dailyLimit:200,
    audienceIds:[8],segmentIds:[],accountIds:[],categoryIds:[7],
  }});
  expect(screen.queryByRole("button",{name:/Save schedule/})).toBeNull();
});
it("shows the full HP roster count and selects its source only on explicit selection",()=>{
  state.roster.mockImplementation((input,callbacks)=>callbacks.onSuccess({id:19,name:"HP — Full account roster",memberCount:9919}));
  render(<IntentMonitoringPage/>);
  fireEvent.click(screen.getByRole("button",{name:"Add schedule"}));
  expect(screen.getByText(/9,919 accounts/)).toBeTruthy();
  expect(state.roster).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox",{name:/HP — Full account roster/}));
  expect(state.roster.mock.calls[0][0]).toEqual({data:{clientId:9}});
  expect(state.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox",{name:/Security/}));
  fireEvent.click(screen.getByRole("button",{name:/Save schedule/}));
  expect(state.save.mock.calls[0][0]).toMatchObject({data:{audienceIds:[19],accountIds:[],dailyLimit:100}});
});
it("loads lightweight metadata and saves exactly the chosen accounts, not the whole database",()=>{
  render(<IntentMonitoringPage/>);
  expect(state.scope).toHaveBeenCalledWith(undefined,true,false);
  fireEvent.click(screen.getByRole("button",{name:"Add schedule"}));
  expect((screen.getByRole("button",{name:/Save schedule/}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Choose two GCC accounts"}));
  fireEvent.click(screen.getByRole("checkbox",{name:/Security/}));
  fireEvent.click(screen.getByRole("button",{name:/Save schedule/}));
  expect(state.save.mock.calls[0][0]).toMatchObject({data:{accountIds:[11,12],audienceIds:[],segmentIds:[],categoryIds:[7],dailyLimit:100,enabled:true}});
});
it("provides named Intent Engine analysis links retaining client and category scope",()=>{
  state.schedules=[{id:1,name:"GCC pilot",enabled:true,clientId:9,dailyLimit:100,
    audienceIds:[],segmentIds:[],accountIds:[11,12],categoryIds:[7],latestRun:null,lastLaneCounts:null}];
  render(<IntentMonitoringPage/>);
  expect(screen.getByRole("link",{name:/GCC One/}).getAttribute("href")).toBe("/intent/accounts/11?client=9&categories=7");
  expect(screen.getByRole("link",{name:/GCC Two/}).getAttribute("href")).toContain("/intent/accounts/12");
});
it("saves the whole GCC audience when editing an active five-account pilot, and retains it on reopening",()=>{
  const schedule={id:1,name:"GCC pilot",enabled:true,clientId:9,dailyLimit:100,
    audienceIds:[],segmentIds:[],accountIds:[11,12,13,14,15],categoryIds:[7],latestRun:null,lastLaneCounts:null};
  state.schedules=[schedule];
  const view=render(<IntentMonitoringPage/>);
  fireEvent.click(screen.getByRole("button",{name:"Edit"}));
  expect(screen.getByRole("dialog",{name:"Edit schedule"})).toBeTruthy();
  expect((screen.getByLabelText("Schedule name") as HTMLInputElement).value).toBe("GCC pilot");
  fireEvent.click(screen.getByRole("button",{name:"Monitor entire GCC list"}));
  fireEvent.click(screen.getByRole("button",{name:/Save schedule/}));
  expect(state.save.mock.calls[0][0]).toMatchObject({id:1,data:{
    audienceIds:[8],accountIds:[11,12,13,14,15],clientId:9,categoryIds:[7],enabled:true,
  }});
  view.unmount();
  state.schedules=[{...schedule,...state.save.mock.calls[0][0].data}];
  render(<IntentMonitoringPage/>);
  fireEvent.click(screen.getByRole("button",{name:"Edit"}));
  expect((screen.getByRole("checkbox",{name:/GCC list/}) as HTMLInputElement).checked).toBe(true);
});
it("closes the visible schedule editor without saving and restores saved values when reopened",()=>{
  state.schedules=[{id:4,name:"Saved schedule",enabled:false,clientId:9,dailyLimit:200,
    audienceIds:[8],segmentIds:[],accountIds:[],categoryIds:[7],latestRun:null,lastLaneCounts:null}];
  render(<IntentMonitoringPage/>);
  fireEvent.click(screen.getByRole("button",{name:"Edit"}));
  expect(screen.getByRole("dialog",{name:"Edit schedule"})).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Schedule name"),{target:{value:"Unsaved change"}});
  fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(state.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Edit"}));
  expect((screen.getByLabelText("Schedule name") as HTMLInputElement).value).toBe("Saved schedule");
  fireEvent.click(screen.getByRole("button",{name:"Close"}));
  expect(screen.queryByRole("dialog")).toBeNull();
});
