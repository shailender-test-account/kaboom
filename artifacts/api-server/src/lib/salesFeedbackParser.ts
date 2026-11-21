import * as XLSX from "xlsx";
import {createHash} from "node:crypto";
import AdmZip from "adm-zip";

export const feedbackTargets = ["companyName","contactName","email","phone","occurredAt","repName","feedback","product","timingMonths","proposedTemperature","nextAction","recordId"] as const;
export type FeedbackType = "telesales" | "sales_rep";
export const clean = (value: unknown) => String(value ?? "").trim();
const key = (v: unknown) => clean(v).toLowerCase().replace(/[^a-z0-9]/g,"");
export const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const aliases: Record<string,string[]> = {
  companyName:["Company / account","Company name","Account","Company"],
  contactName:["Contact name","Name","Full name"], email:["Email","Email address","Business email"],phone:["Phone","Mobile","Contact number"],
  occurredAt:["Date & time","Last contact date","Feedback date","Interaction date","Date"],
  repName:["Team member","Sales rep / owner","Telecaller","Rep name","Agent"],
  feedback:["Discussion / feedback","Feedback","Notes","Comments"],
  product:["Product / service interested in","Product","Product interest","Solution"],
  timingMonths:["Purchase timeframe months","Timing months"], proposedTemperature:["Lead temperature","Temperature","Qualification"],
  nextAction:["Next action"], recordId:["Interaction ID","Opportunity ID","Record ID"],
};
export function feedbackDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (!clean(value)) return null;
  if (typeof value === "number") {
    const parts=XLSX.SSF.parse_date_code(value);
    if (!parts) return null;
    return feedbackDate(`${parts.y}-${String(parts.m).padStart(2,"0")}-${String(parts.d).padStart(2,"0")}`);
  }
  const text=clean(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const d=new Date(`${text}T12:00:00+05:30`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===text ? d.toISOString() : null;
  }
  // Explicit day/month order, never guess US month/day.
  const local=text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if(local)return feedbackDate(`${local[3]}-${local[2].padStart(2,"0")}-${local[1].padStart(2,"0")}`);
  if (!/^\d{4}-\d{2}-\d{2}T|^\d{1,2}-[A-Za-z]{3}-\d{4}/.test(text)) return null;
  const date=new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export type ParsedFeedback = {
  type:FeedbackType;companyName:string;contactName:string;email:string;phone:string;occurredAt:string|null;
  repName:string;feedback:string;product:string|null;timingMonths:number|null;proposedTemperature:string|null;nextAction:string|null;
  recordId:string;sheetName:string;rowNumber:number;rawFields:Record<string,unknown>;
};
export function parseFeedbackWorkbook(buffer:Buffer,defaultType:FeedbackType,mappings:Record<string,string>={}) {
  if(buffer.length>10*1024*1024)throw new Error("Feedback files must be 10 MB or smaller.");
  if(buffer[0]===0x50&&buffer[1]===0x4b) {
    const entries=new AdmZip(buffer).getEntries();
    if(entries.length>2000 || entries.reduce((sum,entry)=>sum+entry.header.size,0)>100*1024*1024)
      throw new Error("Expanded workbook is too large. Split this feedback file.");
  }
  const workbook=XLSX.read(buffer,{type:"buffer",cellDates:true,sheetRows:5025,cellStyles:false});
  const sheets:Array<{name:string;headers:string[];rowCount:number}>=[];
  const rawSheets:Array<{name:string;rows:Record<string,unknown>[];headerRow:number}>=[];
  for(const name of workbook.SheetNames) {
    if (/^(guide|instructions|readme)$/i.test(name.trim())) continue;
    const sheet=workbook.Sheets[name];
    if(!sheet["!ref"])continue;
    const range=XLSX.utils.decode_range(sheet["!ref"]);
    if(range.e.r>5023 || (sheet["!fullref"] && XLSX.utils.decode_range(sheet["!fullref"]).e.r>5023))
      throw new Error(`${name}: split sheets into at most 5,000 data rows.`);
    range.e.c=Math.min(range.e.c,63);
    // Formula cells are derived totals/status, not customer testimony.
    for(const address of Object.keys(sheet))if(!address.startsWith("!")&&sheet[address]?.f)delete sheet[address];
    const values=XLSX.utils.sheet_to_json<unknown[]>(sheet,{header:1,defval:"",range,blankrows:true});
    const at=values.slice(0,20).findIndex(row=>{
      const headings=row.map(key);
      return headings.some(h=>["companyaccount","companyname","company","account",...Object.keys(mappings).filter(k=>mappings[k]==="companyName").map(key)].includes(h))
        && headings.some(h=>/feedback|discussion|contactname|email/.test(h)||Object.keys(mappings).some(k=>key(k)===h));
    });
    if(at<0)continue;
    const headers=values[at].map(clean);
    const rows=values.slice(at+1).map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]??""]).filter(([h])=>h)));
    sheets.push({name,headers,rowCount:rows.filter(row=>Object.values(row).some(v=>clean(v))).length});
    rawSheets.push({name,rows,headerRow:range.s.r+at+1});
  }
  const get=(row:Record<string,unknown>,target:string) => {
    const mapped=Object.keys(mappings).find(h=>mappings[h]===target);
    if(mapped)return Object.entries(row).find(([h])=>key(h)===key(mapped))?.[1]??"";
    return Object.entries(row).find(([h])=>aliases[target]?.some(alias=>key(alias)===key(h)))?.[1]??"";
  };
  const opportunityIdentity=new Map<string,Record<string,unknown>>();
  const ambiguousIds=new Set<string>();
  for(const sheet of rawSheets)for(const row of sheet.rows) {
    const id=clean(row["Opportunity ID"]);
    if(id && clean(get(row,"email")) && !ambiguousIds.has(id)) {
      const previous=opportunityIdentity.get(id);
      if(previous && (clean(get(previous,"email")).toLowerCase()!==clean(get(row,"email")).toLowerCase()
        || key(get(previous,"companyName"))!==key(get(row,"companyName")))) {
        opportunityIdentity.delete(id);ambiguousIds.add(id);
      } else opportunityIdentity.set(id,row);
    }
  }
  const records:ParsedFeedback[]=[];
  for(const sheet of rawSheets)sheet.rows.forEach((original,index)=>{
    const parent=opportunityIdentity.get(clean(original["Opportunity ID"]));
    const row={...parent,...Object.fromEntries(Object.entries(original).filter(([,v])=>clean(v)))};
    const notes:Array<{type:FeedbackType;value:unknown}>=[];
    if(clean(original["Telecaller feedback"]))notes.push({type:"telesales",value:original["Telecaller feedback"]});
    if(clean(original["Sales rep feedback"]))notes.push({type:"sales_rep",value:original["Sales rep feedback"]});
    if(!notes.length && clean(get(original,"feedback")))notes.push({
      type:/sales rep|sales representative|salesperson/i.test(clean(original.Role))?"sales_rep":/telecall|telesales/i.test(clean(original.Role))?"telesales":defaultType,
      value:get(original,"feedback"),
    });
    for(const note of notes) {
      const months=clean(get(row,"timingMonths"));
      const temperature=clean(get(row,"proposedTemperature"));
      records.push({type:note.type,companyName:clean(get(row,"companyName")),contactName:clean(get(row,"contactName")),
        email:clean(get(row,"email")).toLowerCase(),phone:clean(get(row,"phone")),
        occurredAt:feedbackDate(get(original,"occurredAt")),repName:clean(note.type==="telesales"?original.Telecaller:original["Sales rep / owner"])||clean(get(original,"repName")),
        feedback:clean(note.value).slice(0,10000),product:clean(get(row,"product"))||null,
        timingMonths:/^\d+$/.test(months)&&Number(months)<=120?Number(months):null,proposedTemperature:/^(hot|warm|cold)$/i.test(temperature)?temperature[0].toUpperCase()+temperature.slice(1).toLowerCase():null,
        nextAction:clean(get(original,"nextAction"))||null,recordId:clean(get(original,"recordId")),
        sheetName:sheet.name,rowNumber:sheet.headerRow+index+1,rawFields:original});
    }
  });
  return {sheets,records};
}
