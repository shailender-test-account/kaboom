import { ReplitConnectors } from "@replit/connectors-sdk";

const connectors = new ReplitConnectors();
const spreadsheetIdPattern = /^[a-zA-Z0-9-_]{20,}$/;

export function googleSpreadsheetId(value:string){
  const trimmed=value.trim();
  if(spreadsheetIdPattern.test(trimmed))return trimmed;
  const match=trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if(match?.[1]&&spreadsheetIdPattern.test(match[1]))return match[1];
  throw new Error("Enter a valid Google Sheets URL or spreadsheet ID");
}

async function googleSheetsJson(path:string){
  const response=await connectors.proxy("google-sheet",path,{method:"GET"});
  if(!response.ok){
    const detail=(await response.text()).slice(0,240);
    throw new Error(`Google Sheets returned HTTP ${response.status}${detail?`: ${detail}`:""}`);
  }
  return response.json() as Promise<any>;
}

function uniqueHeaders(values:unknown[]){
  const seen=new Map<string,number>();
  return values.map((value,index)=>{
    const base=String(value??"").trim()||`Column ${index+1}`;
    const count=(seen.get(base)??0)+1;
    seen.set(base,count);
    return count===1?base:`${base} (${count})`;
  });
}

export async function readIntentGoogleSheet(source:string,requestedRange?:string){
  const spreadsheetId=googleSpreadsheetId(source);
  const metadata=await googleSheetsJson(`/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,spreadsheetUrl,sheets.properties`);
  const firstSheet=metadata?.sheets?.[0]?.properties?.title;
  if(!firstSheet)throw new Error("The spreadsheet has no readable sheets");
  const range=requestedRange?.trim()||`'${String(firstSheet).replace(/'/g,"''")}'!A1:ZZ5002`;
  const values=await googleSheetsJson(`/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
  const matrix=Array.isArray(values?.values)?values.values:[];
  if(matrix.length<2)throw new Error("The selected range must contain a header row and at least one response");
  if(matrix.length>5001)throw new Error("The selected range contains more than 5000 response rows");
  const headers=uniqueHeaders(matrix[0]);
  const rows=matrix.slice(1)
    .filter((row:unknown[])=>Array.isArray(row)&&row.some(value=>String(value??"").trim()))
    .map((row:unknown[])=>Object.fromEntries(headers.map((header,index)=>[header,row[index]??""])));
  if(!rows.length)throw new Error("No response rows were found in the selected range");
  return {
    spreadsheetId,
    title:String(metadata?.properties?.title??"Google Sheet"),
    spreadsheetUrl:String(metadata?.spreadsheetUrl??source),
    range:String(values?.range??range),
    headers,
    rows,
  };
}