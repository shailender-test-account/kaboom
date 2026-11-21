import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const pack = JSON.parse(await fs.readFile(path.join(root, "artifacts/api-server/content/hp-warm-routing-review.json"), "utf8"));
assert.equal(pack.tracks.length, 4);
assert.deepEqual(pack.cadenceDays, [0, 5, 12]);
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const list = values => `<ul>${values.map(value => `<li>${escape(value)}</li>`).join("")}</ul>`;
const sections = pack.tracks.map(track => {
  assert.equal(track.pages.length, 3);
  assert.equal(track.emails.length, 3);
  assert.ok(track.pages.every(page => page.title && page.intro && page.bullets.length >= 3));
  assert.ok(track.emails.every(email => email.subject && email.paragraphs.length >= 3));
  const target = `${pack.productionOrigin}/hp/play/${track.slug}`;
  return `<section id="${escape(track.key)}">
    <h2>${escape(pack.reviewLabel)} — ${escape(track.name)}</h2>
    <p><strong>Category:</strong> ${escape(track.category)}${track.product ? ` · <strong>Product:</strong> ${escape(track.product)}` : " · Broad, requirements-led fallback"}</p>
    <aside><strong>Proposed mapping:</strong> ${escape(track.mapping)}</aside>
    <h3>Journey pages</h3>
    ${track.pages.map((page, index) => `<article><p class="label">Page ${index + 1} · ${escape(page.stage)}</p><h4>${escape(page.title)}</h4><p>${escape(page.intro)}</p>${list(page.bullets)}</article>`).join("")}
    <h3>Matching sequence</h3>
    <p>Proposed cadence: day 0 → wait 5 days → day 5 → wait 7 days → day 12. All sequences remain drafts.</p>
    ${track.emails.map((email, index) => `<article><p class="label">Email ${index + 1} · Day ${pack.cadenceDays[index]}</p><h4>${escape(email.subject)}</h4>${email.paragraphs.map(p => `<p>${escape(p)}</p>`).join("")}<p>Regards,<br>HP solutions team</p><p class="muted">Briefing CTA: ${escape(target)}<br>Unsubscribe variable: {{unsubscribeUrl}}</p></article>`).join("")}
    <aside>The briefing URL is a planned production destination, not a verified live link. Confirm or replace it after the approved journey is promoted and published. Confirm an approved sender and reply handling before activation.</aside>
  </section>`;
}).join("");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HP Warm Routing — Draft Content Review</title><style>
  body{font:16px/1.65 system-ui,sans-serif;color:#17313e;background:#f1f5f7;margin:0}
  main{max-width:940px;margin:auto;padding:32px 24px 64px}h1,h2,h3,h4{line-height:1.3}h1{font-size:30px}
  h2{font-size:24px;margin-top:0}h3{margin-top:32px}h4{font-size:18px;margin:6px 0 16px}
  section,header{background:white;padding:28px;margin-bottom:24px;border:1px solid #d6e1e6;border-radius:10px}
  article{padding:18px 0;border-bottom:1px solid #e3e9ed}aside{background:#fff7df;border-left:4px solid #c28b10;padding:14px 18px;font-size:14px}
  li{margin-bottom:9px}.label{color:#236478;text-transform:uppercase;font-size:12px;font-weight:750;letter-spacing:.06em}
  .muted{color:#526675;font-size:13px;overflow-wrap:anywhere}nav a{display:inline-block;margin:6px 18px 6px 0;color:#07687c}
  @media print{body{background:white}main{max-width:none;padding:0}section,header{border:0;padding:0;border-radius:0}section{break-before:page}article{break-inside:avoid}nav{display:none}}
  </style></head><body><main><header><p class="label">Drafts for review · No outreach activated</p><h1>HP Warm Routing — Content Review</h1>
  <p>${escape(pack.safety)}</p><p>Four separate Preview journeys, twelve draft pages, four draft sequences and twelve email templates. Existing live content and rules are unchanged. No recipients were added.</p>
  <nav>${pack.tracks.map(track => `<a href="#${escape(track.key)}">${escape(track.name)}</a>`).join("")}</nav></header>
  <section><h2>Required before activation</h2>${list(pack.approvalChecklist)}<p><strong>Important:</strong> draft content is not permission to send. Current qualification and all routing safeguards must still pass at admission and delivery.</p></section>${sections}</main></body></html>`;
const outDir = path.join(root, "generated-artifacts/hp-routing-review");
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, "hp-warm-routing-review.html"), html);
console.log("Validated 4 tracks, 12 pages and 12 emails. Review saved to generated-artifacts/hp-routing-review/hp-warm-routing-review.html");
