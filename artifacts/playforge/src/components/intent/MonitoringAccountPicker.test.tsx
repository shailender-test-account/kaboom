// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import MonitoringAccountPicker from "./MonitoringAccountPicker";

const state = vi.hoisted(() => ({ failed: false, calls: [] as any[] }));
vi.mock("@workspace/api-client-react", () => ({
  useGetMonitoringAccountOptions: (params: any, options: any) => {
    state.calls.push(params);
    if (options?.query?.enabled === false) return {};
    const ids = params.ids ? params.ids.split(",").map(Number)
      : params.audienceId ? [101,102] : Array.from({length:25},(_,i)=>(params.page-1)*25+i+1);
    return { data: { items: ids.map((id:number)=>({id,name:`Company ${id}`,domain:`c${id}.test`})),
      hasMore: !params.audienceId && params.page===1 }, isError: state.failed, isFetching: false,
      isLoading: false, refetch: vi.fn() };
  },
}));
function Harness() {
  const [selected,setSelected] = useState<number[]>([]);
  return <MonitoringAccountPicker clientId={9} audiences={[{id:7,name:"GCC list"}]} selected={selected} onChange={setSelected}/>;
}
afterEach(()=>{cleanup();state.failed=false;state.calls.length=0;});
it("renders only one small page and retains individual picks across pages",()=>{
  render(<Harness/>);
  expect(screen.getAllByRole("checkbox")).toHaveLength(25);
  fireEvent.click(screen.getByRole("checkbox",{name:"Monitor Company 1"}));
  fireEvent.click(screen.getByRole("button",{name:"Next"}));
  fireEvent.click(screen.getByRole("checkbox",{name:"Monitor Company 26"}));
  expect(screen.getByText("2 individual accounts selected")).toBeTruthy();
  expect(screen.getByRole("button",{name:"Remove Company 1"})).toBeTruthy();
  expect(screen.getByRole("button",{name:"Remove Company 26"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Previous"}));
  expect((screen.getByRole("checkbox",{name:"Monitor Company 1"}) as HTMLInputElement).checked).toBe(true);
});
it("browsing GCC does not enroll/select the entire uploaded list",()=>{
  render(<Harness/>);
  fireEvent.change(screen.getByLabelText("Browse uploaded list"),{target:{value:"7"}});
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  expect(screen.getByText("0 individual accounts selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox",{name:"Monitor Company 101"}));
  expect(screen.getByText("1 individual accounts selected")).toBeTruthy();
  expect((screen.getByRole("checkbox",{name:"Monitor Company 102"}) as HTMLInputElement).checked).toBe(false);
  expect(state.calls.some(p=>p.audienceId===7 && p.clientId===9 && p.pageSize===25)).toBe(true);
});
it("shows a recoverable account-search failure instead of hanging",()=>{
  state.failed=true;
  render(<Harness/>);
  expect(screen.getByRole("alert").textContent).toContain("Could not load accounts");
  expect(screen.getByRole("button",{name:"Retry"})).toBeTruthy();
});
it("explains how to import a missing GCC list",()=>{
  render(<MonitoringAccountPicker clientId={9} audiences={[]} selected={[]} onChange={vi.fn()}/>);
  expect(screen.getByRole("link",{name:"Import your GCC account list"}).getAttribute("href")).toBe("/intent/ingest");
});
it("selects an entire GCC audience only through the explicit action, without replacing individual picks",()=>{
  const onSelectAudience=vi.fn(),onChange=vi.fn();
  const props={clientId:9,audiences:[{id:7,name:"GCC list"}],selected:[1,2,3,4,5],onChange,onSelectAudience};
  const view=render(<MonitoringAccountPicker {...props} selectedAudienceIds={[]}/>);
  fireEvent.change(screen.getByLabelText("Browse uploaded list"),{target:{value:"7"}});
  expect(onSelectAudience).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Monitor entire list"}));
  expect(onSelectAudience).toHaveBeenCalledExactlyOnceWith(7);
  expect(onChange).not.toHaveBeenCalled();
  view.rerender(<MonitoringAccountPicker {...props} selectedAudienceIds={[7]}/>);
  expect((screen.getByRole("button",{name:"Entire list selected"}) as HTMLButtonElement).disabled).toBe(true);
});
