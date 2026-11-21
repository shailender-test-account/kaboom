import { describe,it,expect,vi } from "vitest";
import { routeHpContacts } from "./bulk-routing";
const person = {id:1,accountId:2,name:"Test Contact",products:["HP Device as a Service"],eligible:true,reason:""};
describe("HP manual bulk routing",() => {
  it("adds journey first, then enrolls; deduplicates contacts and preserves historical enrollments",async () => {
    const send=vi.fn().mockResolvedValueOnce({added:0}).mockResolvedValueOnce({enrolled:0,existingStatus:"completed"});
    const result=await routeHpContacts(9,[person,person],4,5,person.products[0],send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toMatchObject({action:"add-journey",contactId:1,journeyId:4,product:person.products[0]});
    expect(send.mock.calls[1][0]).toMatchObject({action:"enroll-sequence",sequenceId:5});
    expect(result[0]).toMatchObject({journey:"Already assigned",sequence:"Existing: completed (not restarted)"});
  });
  it("does not enroll after failed journey assignment and reports partial success per contact",async () => {
    const send=vi.fn().mockRejectedValueOnce(new Error("DNC")).mockResolvedValueOnce({added:1})
      .mockRejectedValueOnce(new Error("Sequence unavailable"));
    const result=await routeHpContacts(9,[person,{...person,id:3}],4,5,undefined,send);
    expect(send).toHaveBeenCalledTimes(3);
    expect(result[0].journey).toBe("Failed: DNC");expect(result[0].sequence).toBe("Not attempted");
    expect(result[1]).toMatchObject({journey:"Added",sequence:"Failed: Sequence unavailable"});
  });
  it("does not send blocked contacts or enroll in a sequence when journey-only was selected",async () => {
    const send=vi.fn().mockResolvedValue({added:1});
    const result=await routeHpContacts(9,[{...person,eligible:false,reason:"Identity review"},{...person,id:2}],4,undefined,undefined,send);
    expect(send).toHaveBeenCalledTimes(1);expect(result[0].journey).toBe("Failed: Identity review");
    expect(result[1].sequence).toBe("Not selected");
  });
});
