import { pool } from "@workspace/db";
import { runResearchReassessment } from "../src/lib/researchReassessmentCommand";
try {
  const report = await runResearchReassessment(process.argv.slice(2).filter(arg=>arg!=="--"));
  console.log(`Preview written for ${report.findings.length} findings. Nothing was applied.`);
} finally {
  await pool.end();
}
