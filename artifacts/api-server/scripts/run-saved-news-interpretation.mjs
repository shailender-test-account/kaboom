import {build} from "esbuild";
import {mkdir} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const production=process.argv.includes("--production");
if(production && !process.env.KABOOM_REMIX_PRODUCTION_DATABASE_URL) throw new Error("Approved production connection unavailable");
const out=fileURLToPath(new URL("../../../generated-artifacts/saved-news-interpretation.mjs",import.meta.url));
await mkdir(fileURLToPath(new URL("../../../generated-artifacts/",import.meta.url)),{recursive:true});
await build({entryPoints:[fileURLToPath(new URL("./interpret-saved-news.ts",import.meta.url))],bundle:true,platform:"node",format:"esm",
  outfile:out,external:["pg-native"],banner:{js:'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);'}});
const result=spawnSync(process.execPath,[out,...process.argv.slice(2)],{stdio:"inherit",
  env:{...process.env,...production?{DATABASE_URL:process.env.KABOOM_REMIX_PRODUCTION_DATABASE_URL}:{},NODE_ENV:"development"}});
process.exit(result.status??1);
