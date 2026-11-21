/** Loopback-only verification proxy for browser runners without request interception. */
import http from "node:http";
import {readFile} from "node:fs/promises";
if(process.env.NODE_ENV==="production")throw new Error("Test proxy cannot run in production.");
const fixture=JSON.parse(await readFile("/tmp/sales-feedback-browser-fixture.json","utf8"));
const frontendPort=Number(process.argv[2]??25885);
const server=http.createServer((req,res)=>{
  const api=req.url?.startsWith("/api/");
  const port=api?17329:frontendPort;
  const upstream=http.request({hostname:"127.0.0.1",port,path:req.url,method:req.method,
    headers:{...req.headers,host:`127.0.0.1:${port}`,...(api?{"x-fixture-token":fixture.token}:{})}},
    response=>{res.writeHead(response.statusCode??502,response.headers);response.pipe(res);});
  upstream.on("error",()=>{res.writeHead(502);res.end("Isolated fixture upstream unavailable");});
  req.pipe(upstream);
});
server.listen(17330,"127.0.0.1",()=>console.log("Sales feedback isolated UI proxy ready on loopback port 17330"));
process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
