import {beforeEach,describe,expect,it,vi} from "vitest";

const mocks=vi.hoisted(()=>({connect:vi.fn(),query:vi.fn(),release:vi.fn()}));
vi.mock("@workspace/db",()=>({pool:{connect:mocks.connect}}));
import {withLiveEnrollment} from "../services/liveEnrollmentGuard";

describe("send guard during contact deletion",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({query:mocks.query,release:mocks.release});
    mocks.query.mockResolvedValue({rows:[{id:21}],rowCount:1});
  });

  it("holds the contact lock until the provider action finishes",async()=>{
    const action=vi.fn(async()=>"accepted");
    expect(await withLiveEnrollment(9,21,35,"recipient@example.test",action))
      .toEqual({allowed:true,value:"accepted"});
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("FOR SHARE OF c"),
      [9,21,35,"recipient@example.test"]);
    expect(mocks.query.mock.calls.map(([sql])=>sql)).toEqual([
      "BEGIN",expect.stringContaining("FOR SHARE OF c"),"COMMIT",
    ]);
    expect(action).toHaveBeenCalledOnce();
  });

  it("does not send when the contact or active enrollment no longer exists",async()=>{
    mocks.query.mockImplementation(async(sql:string)=>({
      rows:[],rowCount:sql.includes("FOR SHARE OF c")?0:1,
    }));
    const action=vi.fn();
    expect(await withLiveEnrollment(9,21,35,"recipient@example.test",action))
      .toEqual({allowed:false});
    expect(action).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("fails closed on a database error",async()=>{
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("FOR SHARE OF c"))throw new Error("DB unavailable");
      return {rows:[],rowCount:0};
    });
    const action=vi.fn();
    await expect(withLiveEnrollment(9,21,35,"recipient@example.test",action)).rejects.toThrow("DB unavailable");
    expect(action).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
  });
});