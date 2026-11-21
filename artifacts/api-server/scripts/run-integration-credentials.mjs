import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const outDir = fileURLToPath(new URL("../../../generated-artifacts/", import.meta.url));
await mkdir(outDir, { recursive: true });
const outfile = `${outDir}/integration-credentials.mjs`;
await build({
  entryPoints: [fileURLToPath(new URL("./manage-integration-credentials.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", outfile, external: ["pg-native"],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
