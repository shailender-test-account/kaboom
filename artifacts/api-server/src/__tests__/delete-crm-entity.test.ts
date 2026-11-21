import {beforeEach,describe,expect,it,vi} from "vitest";

const mocks=vi.hoisted(()=>({connect:vi.fn(),query:vi.fn(),release:vi.fn()}));
vi.mock("@workspace/db",()=>({pool:{connect:mocks.connect,query:vi.fn()},db:{}}));
vi.mock("@replit/connectors-sdk",()=>({ReplitConnectors:class{}}));
vi.mock("../services/queue",()=>({enqueueStep:vi.fn(),isTenantQueueAvailable:vi.fn(async()=>false)}));
import {deleteOneInboundResponse,deleteContactAndHistory,deleteCompanyAndHistory} from "../lib/deleteCrmEntity";

const response={id:7,source_id:3,drive_file_id:"drive-1",row_key:"row-7",
  raw_fields:{"Email ID":"person@example.com","Date":"2026-09-27"},field_mappings:{}};

describe("permanent CRM deletion",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({query:mocks.query,release:mocks.release});
    mocks.query.mockImplementation(async(statement:string)=>{
      if(statement.includes("SELECT id FROM intent_inbound_submissions"))return {rows:[{id:7}],rowCount:1};
      if(statement.includes("SELECT id FROM contacts"))return {rows:[{id:21}],rowCount:1};
      if(statement.includes("SELECT id FROM companies"))return {rows:[{id:42}],rowCount:1};
      if(statement.includes("SELECT s.id,s.source_id"))return {rows:[response],rowCount:1};
      return {rows:[],rowCount:0};
    });
  });

  it("deletes only the selected response and records its Drive source key",async()=>{
    expect(await deleteOneInboundResponse(9,7)).toBe(true);
    const statements=mocks.query.mock.calls.map(([sql])=>sql as string);
    expect(statements).toContain("COMMIT");
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO intent_inbound_deleted_rows"),
      [9,3,"drive-1","row-7",expect.anything()]);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM intent_inbound_submissions WHERE tenant_id=$1 AND id=ANY($2::int[])"),[9,[7]]);
    expect(statements.some(sql=>sql.includes("DELETE FROM contacts"))).toBe(false);
    expect(statements.some(sql=>sql.includes("DELETE FROM companies"))).toBe(false);
  });

  it("does not delete another tenant's contact",async()=>{
    mocks.query.mockImplementation(async(statement:string)=>statement.includes("SELECT id FROM contacts")
      ?{rows:[],rowCount:0}:{rows:[],rowCount:0});
    expect(await deleteContactAndHistory(9,21)).toBe(false);
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.query.mock.calls.some(([sql])=>(sql as string).includes("DELETE FROM contacts"))).toBe(false);
  });

  it("removes an account's contacts and history before deleting the account",async()=>{
    expect(await deleteCompanyAndHistory(9,42)).toBe(true);
    const statements=mocks.query.mock.calls.map(([sql])=>sql as string);
    expect(statements.indexOf("DELETE FROM contacts WHERE tenant_id=$1 AND id=$2"))
      .toBeLessThan(statements.indexOf("DELETE FROM companies WHERE tenant_id=$1 AND id=$2"));
    expect(statements.indexOf("DELETE FROM intent_inbound_submissions WHERE tenant_id=$1 AND id=ANY($2::int[])"))
      .toBeLessThan(statements.indexOf("DELETE FROM companies WHERE tenant_id=$1 AND id=$2"));
  });

  it("unlinks a moved contact from responses on other accounts before deleting the current account",async()=>{
    expect(await deleteCompanyAndHistory(9,42)).toBe(true);
    const updated=mocks.query.mock.calls.find(([sql])=>(sql as string).includes("SET contact_id=NULL,routing_status='error'"));
    expect(updated?.[1]).toEqual([9,21,42]);
    const statements=mocks.query.mock.calls.map(([sql])=>sql as string);
    expect(statements.indexOf(updated![0])).toBeLessThan(statements.indexOf("DELETE FROM contacts WHERE tenant_id=$1 AND id=$2"));
  });

  it("rolls back the entire deletion when a linked-record delete fails",async()=>{
    mocks.query.mockImplementation(async(statement:string)=>{
      if(statement.includes("SELECT id FROM contacts"))return {rows:[{id:21}],rowCount:1};
      if(statement.includes("DELETE FROM intent_evidence"))throw new Error("linked history failure");
      return {rows:[],rowCount:0};
    });
    await expect(deleteContactAndHistory(9,21)).rejects.toThrow("linked history failure");
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.query).not.toHaveBeenCalledWith("COMMIT");
  });
});