import {describe,it,expect} from "vitest";
import * as XLSX from "xlsx";
import {readFileSync} from "node:fs";
import {parseFeedbackWorkbook,feedbackDate} from "./salesFeedbackParser";
const workbook=(sheets:Record<string,unknown[][]>)=>{
  const book=XLSX.utils.book_new();
  for(const [name,rows] of Object.entries(sheets))XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),name);
  return XLSX.write(book,{type:"buffer",bookType:"xlsx"}) as Buffer;
};
describe("sales feedback workbook contract",()=>{
  it("recognizes the supplied blank tracker without importing prepared rows",()=>{
    const result=parseFeedbackWorkbook(readFileSync("../../attached_assets/0_Telecaller_Sales_Feedback_Tracker_1793620886292.xlsx"),"telesales");
    expect(result.sheets.map(s=>s.name)).toEqual(["Lead Tracker","Call History"]);
    expect(result.records).toHaveLength(0);
  });
  it("emits separate attributed notes and resolves call identity within a workbook",()=>{
    const result=parseFeedbackWorkbook(workbook({
      "Lead Tracker":[["Title"],[],[],[],[],[],["Opportunity ID","Company / account","Contact name","Email","Telecaller","Sales rep / owner","Last contact date","Telecaller feedback","Sales rep feedback","Product / service interested in","Lead temperature"],
        ["OP-1","Company A","Alice","alice@example.invalid","Caller","Seller","2026-10-28","Asked for quote","Budget needs review","Managed Devices","Warm"]],
      "Call History":[["Title"],[],[],[],["Interaction ID","Opportunity ID","Company / account","Contact name","Date & time","Team member","Role","Discussion / feedback"],
        ["CALL-1","OP-1","Company A","Alice","2026-10-29","Seller","Sales rep","Demo scheduled"]],
      Guide:[["Company","Feedback"],["Not real","Ignore this guide"]],
    }),"telesales");
    expect(result.records).toHaveLength(3);
    expect(result.records.map(r=>r.type)).toEqual(["telesales","sales_rep","sales_rep"]);
    expect(result.records[0]).toMatchObject({rowNumber:8,repName:"Caller",proposedTemperature:"Warm"});
    expect(result.records[2]).toMatchObject({email:"alice@example.invalid",product:"Managed Devices",recordId:"CALL-1",rowNumber:6});
  });
  it("supports mapped headers and rejects unrecognized sheets",()=>{
    const result=parseFeedbackWorkbook(workbook({Responses:[["Organisation","Customer","Comments"],["Account","Alice","Needs discussion"]],Misc:[["x"],["y"]]}),"sales_rep",
      {Organisation:"companyName",Customer:"contactName",Comments:"feedback"});
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({companyName:"Account",contactName:"Alice",feedback:"Needs discussion"});
  });
  it("never borrows identity from an ambiguous opportunity ID",()=>{
    const result=parseFeedbackWorkbook(workbook({
      "Lead Tracker":[["Opportunity ID","Company","Email","Telecaller feedback"],["DUP","A","a@example.invalid",""],["DUP","B","b@example.invalid",""]],
      "Call History":[["Interaction ID","Opportunity ID","Company","Discussion / feedback"],["CALL","DUP","","Buyer called"]],
    }),"telesales");
    expect(result.records[0]).toMatchObject({companyName:"",email:"",feedback:"Buyer called"});
  });
  it("does not treat formula-only or empty template rows as feedback",()=>{
    const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([["Company","Feedback"],["", {t:"s",f:'IF(1=1,"Hot","")',v:"Hot"}],["",""]]);
    XLSX.utils.book_append_sheet(book,sheet,"Data");
    expect(parseFeedbackWorkbook(XLSX.write(book,{type:"buffer",bookType:"xlsx"}),"telesales").records).toHaveLength(0);
  });
  it("bounds both byte size and styled sheet dimensions",()=>{
    expect(()=>parseFeedbackWorkbook(Buffer.alloc(10*1024*1024+1),"telesales")).toThrow(/10 MB/);
    const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([["Company","Feedback"],["A","Test"]]);
    sheet["!ref"]="A1:B9000";XLSX.utils.book_append_sheet(book,sheet,"Data");
    expect(()=>parseFeedbackWorkbook(XLSX.write(book,{type:"buffer",bookType:"xlsx"}),"telesales")).toThrow(/5,000/);
  });
  it("never guesses ambiguous US dates or normalizes impossible calendar dates",()=>{
    expect(feedbackDate("2026-02-30")).toBeNull();
    expect(feedbackDate("29/10/2026")).toBe("2026-10-29T06:30:00.000Z");
    expect(feedbackDate("10/29/2026")).toBeNull();
    expect(feedbackDate("unknown")).toBeNull();
  });
});
