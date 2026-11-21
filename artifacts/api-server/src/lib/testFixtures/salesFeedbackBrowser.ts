/**
 * Isolated browser verification server. Never imported by the application.
 * Synthetic tenant only; Drive responses are local workbook fixtures.
 */
import express from "express";
import {randomUUID} from "node:crypto";
import {writeFile,unlink} from "node:fs/promises";
import * as XLSX from "xlsx";
import {ReplitConnectors} from "@replit/connectors-sdk";
import {pool} from "@workspace/db";
import salesFeedbackRouter from "../../routes/salesFeedback";

if(process.env.NODE_ENV==="production")throw new Error("Browser fixtures cannot run in production.");
const tenantId=Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Sales Feedback Browser Fixture',$1) RETURNING id",[`sales-feedback-browser-${randomUUID()}`])).rows[0].id);
const clientId=Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id",[tenantId])).rows[0].id);
const accountId=Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Feedback Browser Account') RETURNING id",[tenantId,clientId])).rows[0].id);
const contactId=Number((await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,last_name,email)
  VALUES($1,$2,$3,'Alice','Fixture','sales-feedback-browser@example.invalid') RETURNING id`,[tenantId,clientId,accountId])).rows[0].id);
const categoryId=Number((await pool.query("INSERT INTO intent_product_categories(tenant_id,name) VALUES($1,'Business Services') RETURNING id",[tenantId])).rows[0].id);
const product="Fixture Device Service";
await pool.query("INSERT INTO intent_products(tenant_id,category_id,name) VALUES($1,$2,$3)",[tenantId,categoryId,product]);
const token=randomUUID();
const book=XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([
  ["Opportunity ID","Company / account","Contact name","Email","Last contact date","Telecaller","Telecaller feedback","Sales rep feedback","Product / service interested in"],
  ["BROWSER-OP-1","Feedback Browser Account","Alice Fixture","sales-feedback-browser@example.invalid","2026-11-01","Fixture Caller","Asked for a proposal","Needs a demo",product],
]),"Lead Tracker");
const bytes=XLSX.write(book,{type:"buffer",bookType:"xlsx"});
// This isolated process must not read any real connected folder.
(ReplitConnectors.prototype as any).proxy=async(_name:string,path:string)=>{
  if(path.includes("about?"))return new Response(JSON.stringify({user:{displayName:"Fixture Drive"}}),{status:200});
  if(path.includes("alt=media"))return new Response(bytes,{status:200});
  if(path.includes("/drive/v3/files?"))return new Response(JSON.stringify({files:[{id:"fixture-file",name:"fixture-feedback.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",modifiedTime:"2026-11-01T12:00:00Z"}]}),{status:200});
  return new Response("Fixture request not supported",{status:400});
};
const user={id:null,tenantId,tenantName:"Sales Feedback Browser Fixture",email:"browser@example.invalid",firstName:"Browser",lastName:"Fixture",role:"admin",avatarUrl:null};
const app=express();
app.use(express.json());
app.use((req:any,res,next)=>{
  if(req.headers["x-fixture-token"]!==token){res.sendStatus(401);return;}
  req.isAuthenticated=()=>true;req.user=user;next();
});
app.get("/api/auth/me",(_req,res)=>res.json(user));
app.get("/api/clients",(_req,res)=>res.json([{id:clientId,name:"HP"}]));
app.get("/api/notifications",(_req,res)=>res.json({notifications:[],unreadCount:0}));
app.use("/api",salesFeedbackRouter);
app.use((_req,res)=>res.status(501).json({error:"Outside isolated sales feedback fixture"}));
app.use((error:any,_req:any,res:any,_next:any)=>res.status(500).json({error:error.message}));
const server=app.listen(17329,"127.0.0.1",async()=>{
  await writeFile("/tmp/sales-feedback-browser-fixture.json",JSON.stringify({url:"http://127.0.0.1:17329",token,tenantId,clientId,accountId,contactId,product}));
  console.log("Sales feedback isolated browser fixture ready");
});
let closing=false;
async function cleanup(){
  if(closing)return;closing=true;
  server.close();
  for(const table of ["sales_feedback","sales_feedback_sources","contacts","companies","intent_products","intent_product_categories","clients"])
    await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenantId]);
  await pool.query("DELETE FROM tenants WHERE id=$1",[tenantId]);
  await unlink("/tmp/sales-feedback-browser-fixture.json").catch(()=>{});
  await pool.end();process.exit(0);
}
process.on("SIGTERM",()=>void cleanup());
process.on("SIGINT",()=>void cleanup());
