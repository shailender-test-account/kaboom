import pg from "pg";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { deflateSync } from "zlib";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __seedDir = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__seedDir, "../../artifacts/api-server/src/lib/email/templates");

const { Pool } = pg;

// ── Object Storage helpers ────────────────────────────────────────────────────

const SIDECAR = "http://127.0.0.1:1106";

async function getSignedUrlFromSidecar(
  bucketName: string,
  objectName: string,
  method: "GET" | "PUT",
  ttlSec: number,
): Promise<string> {
  const res = await fetch(`${SIDECAR}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method,
      expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Sidecar ${res.status}: ${await res.text()}`);
  const { signed_url } = (await res.json()) as { signed_url: string };
  return signed_url;
}

async function uploadBuffer(buffer: Buffer, mimeType: string): Promise<string> {
  const privateDir = process.env.PRIVATE_OBJECT_DIR ?? "";
  if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR not set");
  const bucketName = privateDir.replace(/^\//, "").split("/")[0];
  const uuid = randomUUID();
  const objectName = `.private/uploads/${uuid}`;
  const objectPath = `/objects/uploads/${uuid}`;
  const signedUrl = await getSignedUrlFromSidecar(bucketName, objectName, "PUT", 900);
  const up = await fetch(signedUrl, {
    method: "PUT",
    body: buffer,
    headers: { "Content-Type": mimeType },
    signal: AbortSignal.timeout(30_000),
  });
  if (!up.ok) throw new Error(`Upload failed: ${up.status}`);
  return objectPath;
}

// ── Minimal valid PDF generator ───────────────────────────────────────────────

function buildMinimalPdf(title: string): Buffer {
  let body = "";
  const off: Record<number, number> = {};
  const w = (s: string) => { body += s + "\n"; };

  w("%PDF-1.4");

  off[1] = body.length;
  w("1 0 obj<</Type/Catalog/Pages 2 0 R>>");
  w("endobj");

  off[2] = body.length;
  w("2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>");
  w("endobj");

  const content = `BT /F1 14 Tf 72 720 Td (${title}) Tj 0 -24 Td (PlayForge Demo Asset) Tj ET`;

  off[4] = body.length;
  w(`4 0 obj<</Length ${content.length + 1}>>`);
  w("stream");
  w(content);
  w("endstream");
  w("endobj");

  off[3] = body.length;
  w("3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>/Parent 2 0 R>>");
  w("endobj");

  const xrefStart = body.length;
  w("xref");
  w("0 5");
  w("0000000000 65535 f ");
  for (let i = 1; i <= 4; i++) w(String(off[i]).padStart(10, "0") + " 00000 n ");
  w("trailer<</Size 5/Root 1 0 R>>");
  w("startxref");
  w(String(xrefStart));
  w("%%EOF");

  return Buffer.from(body, "latin1");
}

// ── Solid-colour PNG generator (arbitrary dimensions) ─────────────────────────

function buildSolidPng(r: number, g: number, b: number, width: number, height: number): Buffer {
  function crc32(data: Buffer): number {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
      table[i] = c;
    }
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crcBuf]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // colour type: RGB

  // Each row: filter byte (0 = None) + width × 3 bytes RGB
  const rowBuf = Buffer.alloc(1 + width * 3);
  rowBuf[0] = 0;
  for (let x = 0; x < width; x++) {
    rowBuf[1 + x * 3]     = r;
    rowBuf[2 + x * 3] = g;
    rowBuf[3 + x * 3] = b;
  }
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) rows.push(rowBuf);
  const compressed = deflateSync(Buffer.concat(rows));

  return Buffer.concat([
    sig,
    makeChunk("IHDR", ihdrData),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log("Seeding database...");

  // ── Tenant ───────────────────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO tenants (id, name, slug, plan)
    VALUES (1, 'Acme Agency', 'acme-agency', 'pro')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
  `);
  await pool.query(`SELECT setval('tenants_id_seq', (SELECT MAX(id) FROM tenants))`);
  console.log("✓ Tenant: Acme Agency (id=1)");

  // ── Users ────────────────────────────────────────────────────────────────────
  const adminHash  = await bcrypt.hash("Admin1234!", 12);
  const editorHash = await bcrypt.hash("Editor1234!", 12);
  await pool.query(`
    INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role)
    VALUES
      (1, 'admin@acme.com',  $1, 'Alex',  'Admin',  'admin'),
      (1, 'editor@acme.com', $2, 'Eddie', 'Editor', 'editor')
    ON CONFLICT (email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          first_name    = EXCLUDED.first_name,
          last_name     = EXCLUDED.last_name,
          role          = EXCLUDED.role
  `, [adminHash, editorHash]);
  console.log("✓ Users: admin@acme.com / Admin1234! | editor@acme.com / Editor1234!");

  // ── Scoring rules ─────────────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO scoring_rules (event_type, points, description, is_active)
    VALUES
      ('email_open',          2,   'Contact opened an email',             'true'),
      ('email_click',         5,   'Contact clicked a link in email',     'true'),
      ('page_view',           3,   'Contact viewed a journey page',       'true'),
      ('video_half_watched',  5,   'Contact watched half of a video',     'true'),
      ('video_completed',     10,  'Contact completed a video',           'true'),
      ('asset_download',      10,  'Contact downloaded an asset',         'true'),
      ('form_submit',         20,  'Contact submitted a form',            'true'),
      ('email_bounced',       -5,  'Email to contact bounced',            'true'),
      ('inactivity_30d',      -10, 'Contact inactive for 30+ days',       'true')
    ON CONFLICT DO NOTHING
  `);
  console.log("✓ Scoring rules seeded");

  // ── Score thresholds ──────────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO score_thresholds (tenant_id, label, min_score, color)
    VALUES
      (1, 'Cold',     0,  'slate'),
      (1, 'Warm',     25, 'blue'),
      (1, 'Hot',      50, 'orange'),
      (1, 'Very Hot', 75, 'red')
    ON CONFLICT DO NOTHING
  `);
  await pool.query(`SELECT setval('score_thresholds_id_seq', (SELECT MAX(id) FROM score_thresholds))`);
  console.log("✓ Score thresholds: Cold (0) / Warm (25) / Hot (50) / Very Hot (75)");

  // ── Clients ───────────────────────────────────────────────────────────────────
  const c1 = await pool.query(`
    INSERT INTO clients (tenant_id, name, domain, industry, company_size, website, description, icp_notes)
    VALUES (1, 'TechNova Solutions', 'technova.io', 'Technology', '201-500',
            'https://technova.io',
            'Enterprise SaaS company focused on AI-powered analytics.',
            'Decision maker: VP of Marketing. Pain points: lead attribution, pipeline visibility.')
    ON CONFLICT DO NOTHING RETURNING id
  `);
  const c2 = await pool.query(`
    INSERT INTO clients (tenant_id, name, domain, industry, company_size, website, description, icp_notes)
    VALUES (1, 'Greenfield Capital', 'greenfieldcap.com', 'Finance', '51-200',
            'https://greenfieldcap.com',
            'Private equity firm specializing in growth-stage B2B companies.',
            'Decision maker: CMO. Focused on brand authority and LP outreach.')
    ON CONFLICT DO NOTHING RETURNING id
  `);

  if (c1.rows[0]?.id && c2.rows[0]?.id) {
    await pool.query(`SELECT setval('clients_id_seq', (SELECT MAX(id) FROM clients))`);
    console.log(`✓ Clients: TechNova Solutions (id=${c1.rows[0].id}), Greenfield Capital (id=${c2.rows[0].id})`);
  } else {
    console.log("⚠ Clients already existed");
  }

  const cId1 = (await pool.query(`SELECT id FROM clients WHERE tenant_id=1 AND name='TechNova Solutions' LIMIT 1`)).rows[0]?.id as number;
  const cId2 = (await pool.query(`SELECT id FROM clients WHERE tenant_id=1 AND name='Greenfield Capital' LIMIT 1`)).rows[0]?.id as number;

  // ── Plays ────────────────────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO abm_plays (tenant_id, client_id, name, status, description, target_audience, start_date, end_date, page_views, contacts_enrolled)
    VALUES
      ($1, $2, 'Q3 AI Analytics Launch', 'active',
       'Multi-touch ABM campaign targeting enterprise analytics buyers.',
       'VP of Data, Head of Analytics at companies 200-1000 employees',
       NOW() - INTERVAL '30 days', NOW() + INTERVAL '60 days', 342, 28),
      ($1, $2, 'Enterprise Upsell Play', 'paused',
       'Upsell sequence targeting existing customers on starter plans.',
       'Existing customers with >50 users on starter tier',
       NOW() - INTERVAL '60 days', NOW() + INTERVAL '30 days', 87, 12),
      ($1, $3, 'LP Brand Awareness', 'draft',
       'Content-led campaign to position Greenfield as thought leaders.',
       'PE-backed founders and CFOs in Series B-D stage companies',
       NOW() + INTERVAL '14 days', NOW() + INTERVAL '90 days', 0, 0)
    ON CONFLICT DO NOTHING
  `, [1, cId1, cId2]);
  await pool.query(`SELECT setval('plays_id_seq', (SELECT MAX(id) FROM abm_plays))`);
  console.log("✓ Plays: 3 sample plays seeded");

  // ── Link play 1 (Q3 AI Analytics Launch) to journey 1 via journey_plays ──────
  const play1Id = (await pool.query(`SELECT id FROM abm_plays WHERE tenant_id=1 AND name='Q3 AI Analytics Launch' LIMIT 1`)).rows[0]?.id as number | null ?? null;

  // ── Companies ─────────────────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO companies (tenant_id, client_id, name, domain, industry, size, website)
    VALUES ($1, $2, 'TechNova Solutions', 'technova.io', 'Technology', '201-500', 'https://technova.io')
    ON CONFLICT DO NOTHING
  `, [1, cId1]);
  await pool.query(`
    INSERT INTO companies (tenant_id, client_id, name, domain, industry, size, website)
    VALUES ($1, $2, 'Greenfield Capital', 'greenfieldcap.com', 'Finance', '51-200', 'https://greenfieldcap.com')
    ON CONFLICT DO NOTHING
  `, [1, cId2]);
  await pool.query(`SELECT setval('companies_id_seq', (SELECT MAX(id) FROM companies))`);
  const compId1 = (await pool.query(`SELECT id FROM companies WHERE tenant_id=1 AND name='TechNova Solutions' LIMIT 1`)).rows[0]?.id as number;
  const compId2 = (await pool.query(`SELECT id FROM companies WHERE tenant_id=1 AND name='Greenfield Capital' LIMIT 1`)).rows[0]?.id as number;
  console.log(`✓ Companies: TechNova (id=${compId1}), Greenfield (id=${compId2})`);

  // ── 20 Contacts ───────────────────────────────────────────────────────────────
  const technovaContacts = [
    { first: "Sarah",    last: "Chen",      title: "VP of Marketing",     email: "s.chen@technova.io",       score: 87, tags: ["champion","decision-maker"],   status: "active" },
    { first: "Marcus",   last: "Williams",  title: "Head of Analytics",   email: "m.williams@technova.io",   score: 62, tags: ["power-user","champion"],       status: "active" },
    { first: "Priya",    last: "Sharma",    title: "Data Science Lead",   email: "p.sharma@technova.io",     score: 45, tags: ["influencer"],                  status: "active" },
    { first: "James",    last: "O'Brien",   title: "CTO",                 email: "j.obrien@technova.io",     score: 78, tags: ["executive","decision-maker"],  status: "active" },
    { first: "Aisha",    last: "Johnson",   title: "Senior Data Analyst", email: "a.johnson@technova.io",    score: 30, tags: ["end-user"],                    status: "active" },
    { first: "Carlos",   last: "Rodriguez", title: "Product Manager",     email: "c.rodriguez@technova.io",  score: 55, tags: ["influencer","power-user"],     status: "active" },
    { first: "Emma",     last: "Thompson",  title: "Marketing Director",  email: "e.thompson@technova.io",   score: 70, tags: ["champion"],                    status: "active" },
    { first: "Daniel",   last: "Kim",       title: "Engineering Manager", email: "d.kim@technova.io",        score: 22, tags: ["end-user"],                    status: "active" },
    { first: "Sophie",   last: "Martinez",  title: "Analytics Manager",   email: "s.martinez@technova.io",   score: 38, tags: ["power-user"],                  status: "active" },
    { first: "Raj",      last: "Patel",     title: "VP of Engineering",   email: "r.patel@technova.io",      score: 15, tags: ["executive"],                   status: "inactive" },
  ];
  const greenfieldContacts = [
    { first: "Victoria", last: "Hartmann",  title: "CMO",                 email: "v.hartmann@greenfieldcap.com",  score: 91, tags: ["decision-maker","champion"],  status: "active" },
    { first: "Thomas",   last: "Nakamura",  title: "Head of Brand",       email: "t.nakamura@greenfieldcap.com",  score: 65, tags: ["champion"],                   status: "active" },
    { first: "Isabelle", last: "Dubois",    title: "Content Director",    email: "i.dubois@greenfieldcap.com",    score: 48, tags: ["influencer"],                 status: "active" },
    { first: "Nathan",   last: "Osei",      title: "Head of Digital",     email: "n.osei@greenfieldcap.com",      score: 72, tags: ["champion","power-user"],      status: "active" },
    { first: "Clara",    last: "Fischer",   title: "PR Manager",          email: "c.fischer@greenfieldcap.com",   score: 33, tags: ["end-user"],                   status: "active" },
    { first: "Michael",  last: "Adeyemi",   title: "Partner",             email: "m.adeyemi@greenfieldcap.com",   score: 58, tags: ["executive","decision-maker"], status: "active" },
    { first: "Yuki",     last: "Tanaka",    title: "Investor Relations",  email: "y.tanaka@greenfieldcap.com",    score: 41, tags: ["influencer"],                 status: "active" },
    { first: "Amara",    last: "Nwosu",     title: "Marketing Manager",   email: "a.nwosu@greenfieldcap.com",     score: 19, tags: ["end-user"],                   status: "active" },
    { first: "Lucas",    last: "Bergstrom", title: "Managing Director",   email: "l.bergstrom@greenfieldcap.com", score: 83, tags: ["executive","decision-maker"], status: "active" },
    { first: "Fatima",   last: "Al-Rashid", title: "Brand Strategist",    email: "f.alrashid@greenfieldcap.com",  score: 27, tags: ["influencer"],                 status: "inactive" },
  ];

  for (const c of technovaContacts) {
    await pool.query(`
      INSERT INTO contacts (tenant_id, client_id, company_id, first_name, last_name, email, title, tags, lead_score, status, last_activity)
      VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() - (random()*30 || ' days')::interval)
      ON CONFLICT DO NOTHING
    `, [cId1, compId1, c.first, c.last, c.email, c.title, c.tags, c.score, c.status]);
  }
  for (const c of greenfieldContacts) {
    await pool.query(`
      INSERT INTO contacts (tenant_id, client_id, company_id, first_name, last_name, email, title, tags, lead_score, status, last_activity)
      VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() - (random()*30 || ' days')::interval)
      ON CONFLICT DO NOTHING
    `, [cId2, compId2, c.first, c.last, c.email, c.title, c.tags, c.score, c.status]);
  }
  await pool.query(`SELECT setval('contacts_id_seq', (SELECT MAX(id) FROM contacts))`);
  console.log("✓ Contacts: 20 contacts seeded (10 per company, varied scores)");

  // ── Activity Events ───────────────────────────────────────────────────────────
  const allContacts = await pool.query(`SELECT id, first_name, last_name FROM contacts WHERE tenant_id=1`);
  const eventTypes = [
    { type: "email_open",     desc: "opened email campaign",      pts: 2  },
    { type: "page_view",      desc: "viewed journey page",        pts: 3  },
    { type: "email_click",    desc: "clicked email CTA",          pts: 5  },
    { type: "asset_download", desc: "downloaded case study PDF",  pts: 10 },
    { type: "form_submit",    desc: "submitted contact form",     pts: 20 },
  ];
  for (const contact of allContacts.rows) {
    const numEvents = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < numEvents; i++) {
      const evt = eventTypes[Math.floor(Math.random() * eventTypes.length)];
      await pool.query(`
        INSERT INTO activity_events (contact_id, contact_name, event_type, description, points_earned, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW() - (random()*14 || ' days')::interval)
      `, [contact.id, `${contact.first_name} ${contact.last_name}`, evt.type, `${contact.first_name} ${evt.desc}`, evt.pts]);
    }
  }
  console.log("✓ Activity events: seeded for all 20 contacts");

  // ── 5 Deals ───────────────────────────────────────────────────────────────────
  const deals = [
    { title: "TechNova — Analytics Pro Upgrade",     value: 48000,  stage: "qualified",   priority: "high",   clientId: cId1, companyId: compId1 },
    { title: "TechNova — Enterprise License",        value: 120000, stage: "proposal",    priority: "high",   clientId: cId1, companyId: compId1 },
    { title: "TechNova — Consulting Engagement",     value: 25000,  stage: "negotiation", priority: "medium", clientId: cId1, companyId: compId1 },
    { title: "Greenfield — ABM Platform License",    value: 36000,  stage: "prospect",    priority: "medium", clientId: cId2, companyId: compId2 },
    { title: "Greenfield — Brand Campaign Retainer", value: 18000,  stage: "closed_won",  priority: "low",    clientId: cId2, companyId: compId2 },
  ];
  for (const d of deals) {
    await pool.query(`
      INSERT INTO deals (tenant_id, client_id, company_id, title, value, stage, priority, expected_close_date)
      VALUES (1, $1, $2, $3, $4, $5, $6, NOW() + (random()*90 + 15 || ' days')::interval)
      ON CONFLICT DO NOTHING
    `, [d.clientId, d.companyId, d.title, d.value, d.stage, d.priority]);
  }
  await pool.query(`SELECT setval('deals_id_seq', (SELECT MAX(id) FROM deals))`);
  console.log("✓ Deals: 5 deals seeded across TechNova and Greenfield");

  // ── Email Templates ───────────────────────────────────────────────────────────
  const html1 = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;"><h2 style="font-size:20px;color:#111827;margin-bottom:4px;">Hi {{firstName}},</h2><p style="color:#374151;line-height:1.7;margin-top:8px;">I've been following {{companyName}}'s growth and noticed you're expanding your analytics capabilities. We've helped similar companies unlock 3x pipeline visibility.</p><div style="margin:28px 0;"><a href="{{journeyUrl}}" style="background:#4f46e5;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">View Your Custom Journey &rarr;</a></div><p style="color:#6b7280;font-size:14px;">Best,<br/>Alex Admin<br/>Acme Agency</p></div>`;
  const html2 = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;"><p style="color:#374151;line-height:1.7;">Hi {{firstName}},</p><p style="color:#374151;line-height:1.7;">Following up on the content I shared about {{playName}}. Companies in your space typically see results within 30 days.</p><div style="margin:28px 0;"><a href="{{journeyUrl}}" style="background:#4f46e5;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">View Content &rarr;</a></div><p style="color:#6b7280;font-size:14px;">Best,<br/>Alex Admin</p></div>`;
  const html3 = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;"><p style="color:#374151;line-height:1.7;">Hi {{firstName}},</p><p style="color:#374151;line-height:1.7;">We helped a company like {{companyName}} generate 3x more qualified pipeline in 90 days using targeted ABM.</p><div style="margin:28px 0;"><a href="{{journeyUrl}}" style="background:#059669;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Read the Case Study &rarr;</a></div><p style="color:#6b7280;font-size:14px;">Best,<br/>Alex Admin<br/>Acme Agency</p></div>`;

  await pool.query(
    `INSERT INTO email_templates (tenant_id, name, category, subject, body_html, body_text, variables)
     VALUES
       (1, $1, 'Outreach',  $2, $3, $4, '["firstName","lastName","companyName","journeyUrl"]'),
       (1, $5, 'Follow-up', $6, $7, $8, '["firstName","companyName","playName","journeyUrl"]'),
       (1, $9, 'Nurture',   $10, $11, $12, '["firstName","companyName","journeyUrl"]')
     ON CONFLICT DO NOTHING`,
    [
      "Q3 AI Outreach", "Quick question about {{companyName}}'s analytics roadmap", html1, "Hi {{firstName}}, view your custom journey: {{journeyUrl}}",
      "Follow-up #1 — Value Prop", "Did you get a chance to review this, {{firstName}}?", html2, "Hi {{firstName}}, following up on {{playName}}.",
      "Nurture — Case Study", "{{firstName}}, how [Company X] achieved 3x pipeline with ABM", html3, "Hi {{firstName}}, see how we helped similar companies.",
    ],
  );
  await pool.query(`SELECT setval('email_templates_id_seq', (SELECT MAX(id) FROM email_templates))`);
  console.log("✓ Email templates: 3 legacy templates seeded");

  // ── 5 Built-in production HTML templates ──────────────────────────────────────
  function readTpl(slug: string): string {
    return readFileSync(join(TEMPLATES_DIR, `${slug}.html`), "utf-8");
  }
  function tplText(html: string): string {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m: string, _url: string, txt: string) => txt.replace(/<[^>]+>/g, "").trim())
      .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&rarr;/gi, "→")
      .replace(/\s{2,}/g, " ").trim();
  }

  const builtInTemplates = [
    {
      slug: "clean-outreach",
      name: "Clean Outreach",
      category: "Outreach",
      subject: "Quick question about {{companyName}}'s go-to-market",
      variables: ["firstName","companyName","journeyUrl","senderName","senderTitle","senderEmail","unsubscribeUrl"],
    },
    {
      slug: "content-spotlight",
      name: "Content Spotlight",
      category: "Nurture",
      subject: "{{firstName}}, this was built for you",
      variables: ["firstName","companyName","contentTitle","contentTeaser","journeyUrl","senderName","senderTitle","unsubscribeUrl"],
    },
    {
      slug: "personal-followup",
      name: "Personal Follow-up",
      category: "Follow-up",
      subject: "Did you get a chance to review this, {{firstName}}?",
      variables: ["firstName","companyName","playName","quoteText","journeyUrl","senderName","senderTitle","senderEmail","unsubscribeUrl"],
    },
    {
      slug: "event-webinar-invite",
      name: "Event / Webinar Invite",
      category: "Event",
      subject: "You're invited: {{eventTitle}}",
      variables: ["firstName","companyName","eventTitle","eventDescription","eventDate","eventTime","eventDuration","agendaItems","journeyUrl","senderName","senderTitle","unsubscribeUrl"],
    },
    {
      slug: "reengagement-winback",
      name: "Re-engagement / Win-back",
      category: "Re-engagement",
      subject: "{{firstName}}, we haven't heard from you in a while",
      variables: ["firstName","companyName","playName","updateItem","journeyUrl","senderName","senderTitle","unsubscribeUrl"],
    },
  ];

  for (const t of builtInTemplates) {
    const html = readTpl(t.slug);
    const text = tplText(html);
    const existing = await pool.query(
      `SELECT id FROM email_templates WHERE tenant_id=1 AND name=$1 LIMIT 1`,
      [t.name]
    );
    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO email_templates (tenant_id, name, category, subject, body_html, body_text, variables)
         VALUES (1, $1, $2, $3, $4, $5, $6)`,
        [t.name, t.category, t.subject, html, text, JSON.stringify(t.variables)]
      );
      console.log(`  ✓ Built-in template: ${t.name}`);
    } else {
      await pool.query(
        `UPDATE email_templates SET category=$2, subject=$3, body_html=$4, body_text=$5, variables=$6 WHERE id=$1`,
        [existing.rows[0].id, t.category, t.subject, html, text, JSON.stringify(t.variables)]
      );
      console.log(`  ↺ Updated built-in template: ${t.name}`);
    }
  }
  await pool.query(`SELECT setval('email_templates_id_seq', (SELECT MAX(id) FROM email_templates))`);
  console.log("✓ 5 built-in production templates seeded/updated");

  // ── Demo Email Sequence ───────────────────────────────────────────────────────
  const playRow = await pool.query(`SELECT id FROM abm_plays WHERE tenant_id=1 AND name='Q3 AI Analytics Launch' LIMIT 1`);
  const playId  = playRow.rows[0]?.id as number | null ?? null;
  const tplId1  = (await pool.query(`SELECT id FROM email_templates WHERE tenant_id=1 AND name='Q3 AI Outreach' LIMIT 1`)).rows[0]?.id as number;
  const tplId2  = (await pool.query(`SELECT id FROM email_templates WHERE tenant_id=1 AND name='Follow-up #1 — Value Prop' LIMIT 1`)).rows[0]?.id as number;
  const tplId3  = (await pool.query(`SELECT id FROM email_templates WHERE tenant_id=1 AND name='Nurture — Case Study' LIMIT 1`)).rows[0]?.id as number;

  if (tplId1 && tplId2 && tplId3) {
    const nodes = [
      { id: "trigger-1", type: "trigger",   position: { x: 250, y: 50  }, data: { triggerType: "MANUAL" } },
      { id: "email-1",   type: "email",     position: { x: 250, y: 180 }, data: { templateId: tplId1, templateName: "Q3 AI Outreach" } },
      { id: "wait-1",    type: "wait",      position: { x: 250, y: 310 }, data: { duration: 3, unit: "days" } },
      { id: "cond-1",    type: "condition", position: { x: 250, y: 440 }, data: { conditionType: "EMAIL_OPENED" } },
      { id: "email-2",   type: "email",     position: { x: 80,  y: 580 }, data: { templateId: tplId3, templateName: "Nurture — Case Study" } },
      { id: "email-3",   type: "email",     position: { x: 420, y: 580 }, data: { templateId: tplId2, templateName: "Follow-up #1 — Value Prop" } },
      { id: "goal-1",    type: "goal",      position: { x: 250, y: 720 }, data: { goalName: "Meeting Booked" } },
    ];
    const edges = [
      { id: "e1", source: "trigger-1", target: "email-1", animated: true, style: { stroke: "#6366f1", strokeWidth: 2 } },
      { id: "e2", source: "email-1",   target: "wait-1",  animated: true, style: { stroke: "#6366f1", strokeWidth: 2 } },
      { id: "e3", source: "wait-1",    target: "cond-1",  animated: true, style: { stroke: "#6366f1", strokeWidth: 2 } },
      { id: "e4", source: "cond-1", target: "email-2", sourceHandle: "true",  label: "Yes", animated: true, style: { stroke: "#22c55e", strokeWidth: 2 } },
      { id: "e5", source: "cond-1", target: "email-3", sourceHandle: "false", label: "No",  animated: true, style: { stroke: "#ef4444", strokeWidth: 2 } },
      { id: "e6", source: "email-2", target: "goal-1", animated: true, style: { stroke: "#6366f1", strokeWidth: 2 } },
      { id: "e7", source: "email-3", target: "goal-1", animated: true, style: { stroke: "#6366f1", strokeWidth: 2 } },
    ];
    await pool.query(
      `INSERT INTO email_sequences (tenant_id, play_id, name, status, trigger_type, trigger_config, nodes_json)
       VALUES (1, $1, $2, 'draft', 'MANUAL', '{}', $3) ON CONFLICT DO NOTHING`,
      [playId, "Q3 AI Analytics — Full Nurture", JSON.stringify({ nodes, edges })],
    );
    await pool.query(`SELECT setval('email_sequences_id_seq', (SELECT MAX(id) FROM email_sequences))`);
    console.log("✓ Email sequence: 'Q3 AI Analytics — Full Nurture' seeded with 7-node demo graph");
  }

  // ── Notifications ─────────────────────────────────────────────────────────────
  const notifCountRow = (await pool.query(`SELECT COUNT(*) AS cnt FROM notifications WHERE tenant_id=1`)).rows[0];
  const notifCount = parseInt(notifCountRow.cnt as string, 10);
  if (notifCount < 8) {
    const firstContactId = (await pool.query(`SELECT id FROM contacts WHERE tenant_id=1 ORDER BY lead_score DESC LIMIT 1`)).rows[0]?.id as number | null ?? null;
    await pool.query(`
      INSERT INTO notifications (tenant_id, type, title, body, contact_id, read, created_at)
      VALUES
        (1, 'score_threshold_crossed', 'Hot lead detected',      'Sarah Chen crossed the Hot threshold (score: 87)',              $1, false, NOW() - INTERVAL '2 hours'),
        (1, 'form_submitted',          'New form submission',    'Sarah Chen submitted "Demo Request" on TechNova AI Intro',       $1, false, NOW() - INTERVAL '3 hours'),
        (1, 'new_contact',             'New contact added',      'Marcus Williams was added to TechNova Solutions',               NULL, false, NOW() - INTERVAL '5 hours'),
        (1, 'sequence_completed',      'Sequence completed',     'Q3 AI Analytics — Full Nurture completed for 3 contacts',       NULL, true,  NOW() - INTERVAL '1 day'),
        (1, 'score_threshold_crossed', 'Very Hot lead',          'Victoria Hartmann reached Very Hot status (score: 91)',         NULL, true,  NOW() - INTERVAL '1 day'),
        (1, 'form_submitted',          'Content gate unlocked',  'Lucas Bergstrom downloaded the ROI Calculator',                 NULL, true,  NOW() - INTERVAL '2 days'),
        (1, 'new_contact',             'New contact from form',  'Amara Nwosu submitted the Demo Request form',                   NULL, true,  NOW() - INTERVAL '2 days'),
        (1, 'score_threshold_crossed', 'Warm lead in pipeline',  'Nathan Osei crossed the Warm threshold (score: 72)',            NULL, true,  NOW() - INTERVAL '3 days')
      ON CONFLICT DO NOTHING
    `, [firstContactId]);
    await pool.query(`SELECT setval('notifications_id_seq', (SELECT MAX(id) FROM notifications))`);
    console.log("✓ Notifications: 8 demo notifications seeded");
  } else {
    console.log(`✓ Notifications: ${notifCount} already present — skipped`);
  }

  // ── Media: ROI PDF + VIP Banner image ─────────────────────────────────────────
  // Both uploads are mandatory — if Object Storage is unavailable the seed will fail.

  let roiPdfId: number;
  const existingPdf = (await pool.query(
    `SELECT id FROM media_assets WHERE tenant_id=1 AND name='ROI_Calculator_Sample.pdf' LIMIT 1`,
  )).rows[0] as { id: number } | undefined;

  if (existingPdf) {
    roiPdfId = existingPdf.id;
    console.log(`✓ Media: ROI PDF already exists (id=${roiPdfId})`);
  } else {
    const pdfBuf = buildMinimalPdf("ROI Calculator Sample");
    const pdfPath = await uploadBuffer(pdfBuf, "application/pdf");
    const pdfRow = (await pool.query(
      `INSERT INTO media_assets (tenant_id, name, object_path, mime_type, file_size)
       VALUES (1, 'ROI_Calculator_Sample.pdf', $1, 'application/pdf', $2) RETURNING id`,
      [pdfPath, pdfBuf.length],
    )).rows[0] as { id: number };
    roiPdfId = pdfRow.id;
    console.log(`✓ Media: ROI PDF uploaded (id=${roiPdfId}, path=${pdfPath})`);
  }

  let vipBannerImgPath: string;
  const existingImg = (await pool.query(
    `SELECT id, object_path FROM media_assets WHERE tenant_id=1 AND name='vip-banner-placeholder.png' LIMIT 1`,
  )).rows[0] as { id: number; object_path: string } | undefined;

  if (existingImg) {
    vipBannerImgPath = `/api/storage${existingImg.object_path}`;
    console.log(`✓ Media: VIP banner image already exists`);
  } else {
    // 1200×120 solid indigo (#6366f1) PNG
    const pngBuf = buildSolidPng(99, 102, 241, 1200, 120);
    const pngPath = await uploadBuffer(pngBuf, "image/png");
    await pool.query(
      `INSERT INTO media_assets (tenant_id, name, object_path, mime_type, file_size)
       VALUES (1, 'vip-banner-placeholder.png', $1, 'image/png', $2)`,
      [pngPath, pngBuf.length],
    );
    vipBannerImgPath = `/api/storage${pngPath}`;
    console.log(`✓ Media: VIP banner image uploaded (1200×120 indigo PNG, path=${pngPath})`);
  }

  // ── CTA Buttons ───────────────────────────────────────────────────────────────
  await pool.query(`
    DELETE FROM cta_buttons
    WHERE tenant_id=1 AND name IN (
      'Book Demo — Blue Pill', 'Download ROI Calculator',
      'Get the Case Study',    'Book a demo too →'
    )
  `);

  // Primary "Book a Demo" CTA — indigo pill with arrow icon
  const ctaBookDemoRow = await pool.query(`
    INSERT INTO cta_buttons (tenant_id, name, label, action_type, action_config, style_config)
    VALUES (1, 'Book Demo — Blue Pill', 'Book a Demo', 'url', $1::jsonb, $2::jsonb)
    RETURNING id
  `, [
    JSON.stringify({ url: "https://calendly.com/acme-agency" }),
    JSON.stringify({ bgColor: "#4f46e5", textColor: "#ffffff", borderRadius: "pill", icon: "arrow", iconPosition: "right" }),
  ]);
  const ctaBookDemoId = ctaBookDemoRow.rows[0].id as number;

  // Download CTA — green slightly_rounded with download icon
  const ctaDownloadRoiRow = await pool.query(`
    INSERT INTO cta_buttons (tenant_id, name, label, action_type, action_config, style_config)
    VALUES (1, 'Download ROI Calculator', 'Download ROI Calculator', 'download', $1::jsonb, $2::jsonb)
    RETURNING id
  `, [
    JSON.stringify({ assetId: roiPdfId, assetFilename: "ROI_Calculator_Sample.pdf" }),
    JSON.stringify({ bgColor: "#059669", textColor: "#ffffff", borderRadius: "slightly_rounded", icon: "download", iconPosition: "right" }),
  ]);
  const ctaDownloadRoiId = ctaDownloadRoiRow.rows[0].id as number;

  // Secondary "Book a demo too →" CTA for Content Gate form — small, transparent bg, indigo border/text
  const ctaBookDemoInlineRow = await pool.query(`
    INSERT INTO cta_buttons (tenant_id, name, label, action_type, action_config, style_config)
    VALUES (1, 'Book a demo too →', 'Book a demo too →', 'url', $1::jsonb, $2::jsonb)
    RETURNING id
  `, [
    JSON.stringify({ url: "https://calendly.com/acme-agency" }),
    JSON.stringify({ bgColor: "transparent", textColor: "#4f46e5", borderColor: "#4f46e5", borderRadius: "pill", sizePreset: "small", icon: "none" }),
  ]);
  const ctaBookDemoInlineId = ctaBookDemoInlineRow.rows[0].id as number;

  // ── Journey Forms ─────────────────────────────────────────────────────────────
  await pool.query(`
    DELETE FROM journey_forms WHERE tenant_id=1 AND name IN ('Demo Request', 'Content Gate — ROI Report')
  `);

  const demoRequestFormRow = await pool.query(`
    INSERT INTO journey_forms (tenant_id, name, config)
    VALUES (1, 'Demo Request', $1::jsonb)
    RETURNING id
  `, [JSON.stringify({
    layout: "centered_card",
    heading: "Request a Demo",
    body: "Tell us a bit about yourself and we'll be in touch.",
    fields: [
      { id: "f1", type: "short_text", label: "First name",  required: true,  mapToContactField: "firstName" },
      { id: "f2", type: "short_text", label: "Last name",   required: true,  mapToContactField: "lastName" },
      { id: "f3", type: "email",      label: "Work email",  required: true,  mapToContactField: "email" },
      { id: "f4", type: "short_text", label: "Company",     required: true,  mapToContactField: "companyName" },
      { id: "f5", type: "short_text", label: "Job title",   required: false, mapToContactField: "jobTitle" },
      { id: "f6", type: "long_text",  label: "Anything specific you'd like to cover?", required: false, rows: 3 },
      { id: "f7", type: "consent",    label: "I agree to be contacted by Acme Agency", required: true, storeAsTag: true },
    ],
    submitButton: { label: "Request Demo", bgColor: "#4f46e5", textColor: "#ffffff", borderRadius: "pill", sizePreset: "full" },
    onSubmit: {
      thankYouTitle: "You're booked in!",
      thankYouBody: "We'll be in touch within 24 hours to schedule your personalized demo.",
    },
  })]);
  const demoRequestFormId = demoRequestFormRow.rows[0].id as number;

  const contentGateFormRow = await pool.query(`
    INSERT INTO journey_forms (tenant_id, name, config)
    VALUES (1, 'Content Gate — ROI Report', $1::jsonb)
    RETURNING id
  `, [JSON.stringify({
    layout: "two_column",
    heading: "Get Your Free ROI Report",
    body: "See how companies like yours achieve 3× pipeline in 90 days.",
    tagTargeting: { mode: "without_tag", tag: "content-unlocked" },
    fields: [
      { id: "f1", type: "short_text", label: "First name",  required: true,  mapToContactField: "firstName" },
      { id: "f2", type: "email",      label: "Work email",  required: true,  mapToContactField: "email" },
      { id: "f3", type: "short_text", label: "Company",     required: true,  mapToContactField: "companyName" },
      { id: "f4", type: "short_text", label: "Role",        required: false, mapToContactField: "jobTitle" },
      { id: "f5", type: "short_text", label: "Team size",   required: false },
      { id: "f6", type: "tnc",        label: "I agree to the Terms & Conditions", required: true, tncUrl: "https://acme.agency/terms" },
      { id: "f7", type: "consent",    label: "I consent to receive marketing communications", required: false, storeAsTag: true },
    ],
    submitButton: { label: "Get the Report", bgColor: "#7c3aed", textColor: "#ffffff", borderRadius: "pill", sizePreset: "full" },
    onSubmit: {
      thankYouTitle: "Your report is on its way!",
      thankYouBody: "Check your inbox — your ROI Calculator PDF will arrive shortly.",
      deliveryAssetId: roiPdfId,
    },
    // Secondary inline CTA below the submit button ("Book a demo too →" — small outlined URL CTA)
    ctaButtonId: ctaBookDemoInlineId,
    ctaPosition: "below_submit",
  })]);
  const contentGateFormId = contentGateFormRow.rows[0].id as number;

  console.log(`✓ Forms: Demo Request (id=${demoRequestFormId}), Content Gate (id=${contentGateFormId})`);

  // Gated CTA — needs demoRequestFormId resolved first
  const ctaGetCaseStudyRow = await pool.query(`
    INSERT INTO cta_buttons (tenant_id, name, label, action_type, action_config, style_config)
    VALUES (1, 'Get the Case Study', 'Get the Case Study', 'gated_form', $1::jsonb, $2::jsonb)
    RETURNING id
  `, [
    JSON.stringify({ formId: demoRequestFormId, deliveryAssetId: roiPdfId, deliveryAssetFilename: "ROI_Calculator_Sample.pdf" }),
    JSON.stringify({ bgColor: "#7c3aed", textColor: "#ffffff", borderRadius: "pill" }),
  ]);
  const ctaGetCaseStudyId = ctaGetCaseStudyRow.rows[0].id as number;

  await pool.query(`SELECT setval('cta_buttons_id_seq', (SELECT MAX(id) FROM cta_buttons))`);
  console.log(`✓ CTA Buttons: Book Demo (id=${ctaBookDemoId}), Download ROI (id=${ctaDownloadRoiId}), Book a demo too (id=${ctaBookDemoInlineId}), Get Case Study (id=${ctaGetCaseStudyId})`);

  // ── Banners ───────────────────────────────────────────────────────────────────
  await pool.query(`
    DELETE FROM banners
    WHERE tenant_id=1 AND name IN ('Welcome banner — personalized', 'Exclusive offer — VIP tag')
  `);

  const welcomeBannerRow = await pool.query(`
    INSERT INTO banners (tenant_id, name, position, zone, status, original_width, original_height, config)
    VALUES (1, 'Welcome banner — personalized', 'top_bar', NULL, 'active', NULL, NULL, $1::jsonb)
    RETURNING id
  `, [JSON.stringify({
    type: "text",
    bgColor: "#4f46e5",
    textColor: "#ffffff",
    heading: "Welcome back, {{firstName}}!",
    body: "Your personalized journey is ready.",
    animationType: "slide_top",
    animationDelay: 500,
    dismissButton: true,
    dismissDuration: "session",
    clickBehavior: "none",
    ctaButtonId: ctaBookDemoId,
    ctaButtonPosition: "right",
    tagTargeting: { mode: "everyone", tag: "" },
  })]);
  const welcomeBannerId = welcomeBannerRow.rows[0].id as number;

  const vipBannerRow = await pool.query(`
    INSERT INTO banners (tenant_id, name, position, zone, status, original_width, original_height, config)
    VALUES (1, 'Exclusive offer — VIP tag', 'bottom_bar', NULL, 'active', 1200, 120, $1::jsonb)
    RETURNING id
  `, [JSON.stringify({
    type: "image",
    imageUrl: vipBannerImgPath,
    bgColor: "#1e1b4b",
    textColor: "#ffffff",
    overlayText: "VIP Exclusive Access",
    overlaySubtext: "Claim your early-access demo now",
    textAlignment: "center",
    textShadow: true,
    animationType: "fade",
    animationDelay: 1000,
    dismissButton: true,
    dismissDuration: "7d",
    clickBehavior: "url",
    clickUrl: "https://acme.agency/vip",
    openInNewTab: true,
    tagTargeting: { mode: "with_tag", tag: "vip" },
  })]);
  const vipBannerId = vipBannerRow.rows[0].id as number;

  // Zone-assigned demo banner — appears in the "top" zone on all journeys
  const zoneDemoName = "Q3 AI Launch — Top Zone Banner";
  await pool.query(`DELETE FROM banners WHERE tenant_id=1 AND name=$1`, [zoneDemoName]);
  const zoneBannerRow = await pool.query(`
    INSERT INTO banners (tenant_id, name, position, zone, status, original_width, original_height, config)
    VALUES (1, $1, 'top_bar', 'top', 'active', 1200, 90, $2::jsonb)
    RETURNING id
  `, [zoneDemoName, JSON.stringify({
    type: "text",
    bgColor: "#0f172a",
    textColor: "#e0e7ff",
    heading: "Q3 AI Analytics Launch — Early Access Now Open",
    body: "Limited seats available for Q3 cohort.",
    ctaText: "Claim Your Spot",
    ctaUrl: "https://calendly.com/acme-agency",
    tagTargeting: { mode: "everyone", tag: "" },
  })]);
  const zoneBannerId = zoneBannerRow.rows[0].id as number;

  await pool.query(`SELECT setval('banners_id_seq', (SELECT MAX(id) FROM banners))`);
  console.log(`✓ Banners: Welcome (id=${welcomeBannerId}), VIP Offer (id=${vipBannerId}), Top Zone (id=${zoneBannerId})`);

  // ── Journey 1: TechNova AI Intro (create if absent) ──────────────────────────
  // The journey must exist before we can attach page_components; we seed it here
  // so the script is self-contained and works on a fresh database.
  const existingJourneyRow = (await pool.query(
    `SELECT id FROM journeys WHERE tenant_id=1 AND name='TechNova AI Intro Journey' LIMIT 1`,
  )).rows[0] as { id: number } | undefined;

  let journeyId: number;
  if (existingJourneyRow) {
    journeyId = existingJourneyRow.id;
    await pool.query(`UPDATE journeys SET client_id=$1 WHERE id=$2`, [cId1, journeyId]);
  } else {
    const newRow = (await pool.query(`
      INSERT INTO journeys (tenant_id, client_id, name, slug, description, status, theme,
                            header_btn_text, header_btn_url)
      VALUES (1, $1, 'TechNova AI Intro Journey', 'technova-ai-intro',
              'AI-powered analytics journey for TechNova Solutions prospects',
              'published', 'dark', 'Book a Demo', 'https://calendly.com/acme-agency')
      ON CONFLICT (slug) DO UPDATE
        SET name=EXCLUDED.name, client_id=EXCLUDED.client_id, status=EXCLUDED.status
      RETURNING id
    `, [cId1])).rows[0] as { id: number };
    journeyId = newRow.id;
    await pool.query(`SELECT setval('journeys_id_seq', (SELECT MAX(id) FROM journeys))`);
  }

  // Resolve the ROI PDF serving URL for page 2 content
  const roiPdfObjectPath = (await pool.query(
    `SELECT object_path FROM media_assets WHERE id=$1 LIMIT 1`,
    [roiPdfId],
  )).rows[0]?.object_path as string;
  const roiPdfServingUrl = `/api/storage${roiPdfObjectPath}`;

  // Ensure the journey has at least 4 pages in sort_order 0–3
  const pageSpecs = [
    { title: "Product Overview Video", page_type: "youtube",      sort_order: 0, content: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", page_stage: "aware" },
    { title: "Case Study PDF",         page_type: "pdf",          sort_order: 1, content: roiPdfServingUrl,                               page_stage: "consider" },
    { title: "Book a Demo",            page_type: "iframe",       sort_order: 2, content: "https://calendly.com/acme-agency",             page_stage: "decide" },
    { title: "About Us",               page_type: "infographic",  sort_order: 3, content: vipBannerImgPath,                              page_stage: "aware" },
  ];

  const existingPageSortOrders = new Set(
    (await pool.query(
      `SELECT sort_order FROM journey_pages WHERE journey_id=$1`,
      [journeyId],
    )).rows.map(r => r.sort_order as number),
  );

  for (const p of pageSpecs) {
    if (!existingPageSortOrders.has(p.sort_order)) {
      await pool.query(`
        INSERT INTO journey_pages
          (journey_id, title, page_type, content, sort_order, page_stage, cta_enabled)
        VALUES ($1, $2, $3, $4, $5, $6, 'false')
      `, [journeyId, p.title, p.page_type, p.content, p.sort_order, p.page_stage]);
    }
  }
  await pool.query(`SELECT setval('journey_pages_id_seq', (SELECT MAX(id) FROM journey_pages))`);

  // Resolve the first 4 page IDs by sort_order (deterministic, ascending)
  const j1Pages = (await pool.query(
    `SELECT id FROM journey_pages WHERE journey_id=$1 ORDER BY sort_order LIMIT 4`,
    [journeyId],
  )).rows.map(r => r.id as number);

  if (j1Pages.length < 4) {
    throw new Error(
      `Journey "${journeyId}" has only ${j1Pages.length} pages after seeding — cannot attach page_components`,
    );
  }

  const [pg1, pg2, pg3, pg4] = j1Pages as [number, number, number, number];
  console.log(`✓ Journey 1: 'TechNova AI Intro Journey' (id=${journeyId}), pages [${j1Pages.join(", ")}]`);

  // ── Link play 1 to journey 1 via journey_plays ───────────────────────────────
  if (play1Id) {
    await pool.query(
      `INSERT INTO journey_plays (journey_id, play_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [journeyId, play1Id],
    );
    console.log(`✓ Journey plays: linked play ${play1Id} → journey ${journeyId}`);
  }

  // ── Page Components for Journey 1 ─────────────────────────────────────────────
  // Page 1 (Video):  welcome banner top_bar + book demo floating
  // Page 2 (PDF):    content gate form inline
  // Page 3 (iframe): demo request form inline + download CTA inline
  // Page 4 (Video):  welcome banner top_bar + get case study floating
  await pool.query(`DELETE FROM page_components WHERE journey_page_id = ANY($1::int[])`, [j1Pages]);

  await pool.query(`INSERT INTO page_components (journey_page_id, component_type, component_id, position, sort_order, override_config) VALUES ($1,'banner',$2,'top_bar',0,'{}'::jsonb)`, [pg1, welcomeBannerId]);
  await pool.query(`INSERT INTO page_components (journey_page_id, component_type, component_id, position, sort_order, override_config) VALUES ($1,'cta',$2,'floating',1,'{}'::jsonb)`, [pg1, ctaBookDemoId]);

  await pool.query(`INSERT INTO page_components (journey_page_id, component_type, component_id, position, sort_order, override_config) VALUES ($1,'form',$2,'inline',0,'{}'::jsonb)`, [pg2, contentGateFormId]);

  await pool.query(`INSERT INTO page_components (journey_page_id, component_type, component_id, position, sort_order, override_config) VALUES ($1,'form',$2,'inline',0,'{}'::jsonb)`, [pg3, demoRequestFormId]);
  await pool.query(`INSERT INTO page_components (journey_page_id, component_type, component_id, position, sort_order, override_config) VALUES ($1,'cta',$2,'inline',1,'{}'::jsonb)`, [pg3, ctaDownloadRoiId]);

  await pool.query(`INSERT INTO page_components (journey_page_id, component_type, component_id, position, sort_order, override_config) VALUES ($1,'banner',$2,'top_bar',0,'{}'::jsonb)`, [pg4, welcomeBannerId]);
  await pool.query(`INSERT INTO page_components (journey_page_id, component_type, component_id, position, sort_order, override_config) VALUES ($1,'cta',$2,'floating',1,'{}'::jsonb)`, [pg4, ctaGetCaseStudyId]);

  console.log(`✓ Page components: seeded for Journey 1 pages [${j1Pages.join(", ")}]`);

  // ── Segments ──────────────────────────────────────────────────────────────────
  await pool.query(`DELETE FROM segments WHERE tenant_id = $1`, [1]);

  const seg1 = await pool.query(`
    INSERT INTO segments (tenant_id, name, description, segment_type, filter_criteria, last_computed_count)
    VALUES ($1, 'Hot Leads (Score 50+)', 'Contacts with lead score above 50 — ready for active outreach', 'dynamic',
      '[{"field":"lead_score","operator":"gt","value":50}]'::jsonb, 0)
    RETURNING id
  `, [1]);
  const seg2 = await pool.query(`
    INSERT INTO segments (tenant_id, name, description, segment_type, filter_criteria, last_computed_count)
    VALUES ($1, 'TechNova Contacts', 'All contacts from the TechNova Solutions company', 'dynamic',
      '[{"field":"company_name","operator":"contains","value":"TechNova"}]'::jsonb, 0)
    RETURNING id
  `, [1]);
  const seg3 = await pool.query(`
    INSERT INTO segments (tenant_id, name, description, segment_type, filter_criteria, last_computed_count)
    VALUES ($1, 'Video Engaged — Q3', 'Contacts tagged with video engagement from the Q3 campaign', 'dynamic',
      '[{"field":"tags","operator":"contains_any","value":["video_engaged","q3_campaign"]}]'::jsonb, 0)
    RETURNING id
  `, [1]);

  const [segHotId, segTechNovaId, segVideoId] = [seg1.rows[0].id, seg2.rows[0].id, seg3.rows[0].id];
  console.log(`✓ Segments: Hot Leads (${segHotId}), TechNova (${segTechNovaId}), Video Engaged (${segVideoId})`);

  // ── Journey Routing Rules ────────────────────────────────────────────────────
  await pool.query(`DELETE FROM journey_routing_rules WHERE tenant_id = $1`, [1]);

  const [journeyRes, seqRes] = await Promise.all([
    pool.query(`SELECT id FROM journeys WHERE tenant_id = $1 ORDER BY id LIMIT 1`, [1]),
    pool.query(`SELECT id FROM email_sequences WHERE tenant_id = $1 AND name ILIKE '%Q3 AI%' ORDER BY id LIMIT 1`, [1]),
  ]);
  if (journeyRes.rows.length > 0) {
    const firstJourneyId = journeyRes.rows[0].id as number;
    const enrollSeqId = (seqRes.rows[0]?.id as number | undefined) ?? null;
    await pool.query(`
      INSERT INTO journey_routing_rules
        (tenant_id, name, condition_type, condition_value, journey_id, apply_to,
         if_already_in_journey, enroll_sequence_id, is_active)
      VALUES
        ($1, 'Score > 40 → TechNova AI Journey', 'score_above',
         '{"threshold":40}'::jsonb, $2, 'all', 'skip', $3, true),
        ($1, 'Score > 70 → Champion Outreach', 'score_above',
         '{"threshold":70}'::jsonb, $2, 'all', 're_add', $3, true),
        ($1, 'Score < 20 → Cold Lead Re-engage', 'score_below',
         '{"threshold":20}'::jsonb, $2, 'all', 'skip', $3, true),
        ($1, 'VIP Tag Added → Priority Journey', 'tag_added',
         '{"tag":"vip"}'::jsonb, $2, 'all', 're_add', $3, true),
        ($1, 'Video Engaged → AI Journey Enroll', 'tag_added',
         '{"tag":"video_engaged"}'::jsonb, $2, 'all', 'skip', $3, true)
    `, [1, firstJourneyId, enrollSeqId]);
    console.log(`✓ Journey routing rules: 5 rules → journey ${firstJourneyId}, sequence ${enrollSeqId}`);
  }

  // ── Additional Plays ──────────────────────────────────────────────────────────
  // Delete-then-reinsert (no unique constraint on name) so re-runs don't duplicate.
  await pool.query(`
    DELETE FROM abm_plays WHERE tenant_id=1 AND name IN (
      'Greenfield Q4 Campaign', 'Mid-Market Expansion', 'Renewal Acceleration'
    )
  `);
  await pool.query(`
    INSERT INTO abm_plays (tenant_id, client_id, name, status, description, target_audience, start_date, end_date, page_views, contacts_enrolled)
    VALUES
      ($1, $2, 'Greenfield Q4 Campaign', 'active',
       'Q4 push targeting LP prospects and CFOs in the Greenfield portfolio.',
       'LPs, CFOs, and Series B-D founders in PE-backed companies',
       NOW() - INTERVAL '45 days', NOW() + INTERVAL '45 days', 198, 22),
      ($1, $3, 'Mid-Market Expansion', 'active',
       'Expand into mid-market companies with 51-500 employees.',
       'Heads of Marketing and RevOps at mid-market SaaS companies',
       NOW() - INTERVAL '20 days', NOW() + INTERVAL '70 days', 134, 18),
      ($1, $3, 'Renewal Acceleration', 'paused',
       'Re-engage accounts approaching renewal with personalised content.',
       'Customer success leads at renewal-stage accounts',
       NOW() - INTERVAL '90 days', NOW() + INTERVAL '10 days', 56, 9)
  `, [1, cId2, cId1]);
  await pool.query(`SELECT setval('plays_id_seq', (SELECT MAX(id) FROM abm_plays))`);
  console.log("✓ Plays: 3 additional plays seeded (Greenfield Q4, Mid-Market Expansion, Renewal Acceleration)");

  const gfQ4PlayId = (await pool.query(`SELECT id FROM abm_plays WHERE tenant_id=1 AND name='Greenfield Q4 Campaign' LIMIT 1`)).rows[0]?.id as number;
  const mmPlayId   = (await pool.query(`SELECT id FROM abm_plays WHERE tenant_id=1 AND name='Mid-Market Expansion'   LIMIT 1`)).rows[0]?.id as number;

  // ── Journey 2: Greenfield Capital ABM Journey ──────────────────────────────
  const j2Row = (await pool.query(`
    INSERT INTO journeys (tenant_id, client_id, name, slug, description, status, theme, header_btn_text, header_btn_url)
    VALUES (1, $1, 'Greenfield Capital ABM Journey', 'greenfield-abm',
            'Personalised ABM journey for Greenfield Capital LP and CFO prospects',
            'published', 'light', 'Book a Demo', 'https://calendly.com/acme-agency')
    ON CONFLICT (slug) DO UPDATE
      SET name=EXCLUDED.name, client_id=EXCLUDED.client_id, status=EXCLUDED.status
    RETURNING id
  `, [cId2])).rows[0] as { id: number };
  const j2Id = j2Row.id;

  const j2PageSpecs = [
    { title: "Greenfield — The LP Playbook",   page_type: "html",   sort_order: 0, page_stage: "aware"    },
    { title: "Greenfield — ROI Deep Dive",     page_type: "html",   sort_order: 1, page_stage: "consider" },
    { title: "Greenfield — Book Your Session", page_type: "iframe", sort_order: 2, page_stage: "decide"   },
  ];
  const existingJ2Orders = new Set(
    (await pool.query(`SELECT sort_order FROM journey_pages WHERE journey_id=$1`, [j2Id])).rows.map(r => r.sort_order as number),
  );
  for (const p of j2PageSpecs) {
    if (!existingJ2Orders.has(p.sort_order)) {
      await pool.query(
        `INSERT INTO journey_pages (journey_id, title, page_type, sort_order, page_stage, cta_enabled) VALUES ($1,$2,$3,$4,$5,'false')`,
        [j2Id, p.title, p.page_type, p.sort_order, p.page_stage],
      );
    }
  }
  if (gfQ4PlayId) {
    await pool.query(`INSERT INTO journey_plays (journey_id, play_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [j2Id, gfQ4PlayId]);
  }
  const j2Pages = (await pool.query(`SELECT id FROM journey_pages WHERE journey_id=$1 ORDER BY sort_order`, [j2Id])).rows.map(r => r.id as number);
  console.log(`✓ Journey 2: 'Greenfield Capital ABM Journey' (id=${j2Id}), pages [${j2Pages.join(", ")}]`);

  // ── Journey 3: Enterprise Upsell Intro ──────────────────────────────────────
  const j3Row = (await pool.query(`
    INSERT INTO journeys (tenant_id, client_id, name, slug, description, status, theme, header_btn_text, header_btn_url)
    VALUES (1, $1, 'Enterprise Upsell Intro', 'enterprise-upsell-intro',
            'Upsell journey for TechNova starter-plan customers moving to Enterprise',
            'published', 'dark', 'Talk to Sales', 'https://calendly.com/acme-agency')
    ON CONFLICT (slug) DO UPDATE
      SET name=EXCLUDED.name, client_id=EXCLUDED.client_id, status=EXCLUDED.status
    RETURNING id
  `, [cId1])).rows[0] as { id: number };
  const j3Id = j3Row.id;

  const j3PageSpecs = [
    { title: "Why Upgrade to Enterprise?", page_type: "html",   sort_order: 0, page_stage: "aware"    },
    { title: "Feature Comparison",         page_type: "html",   sort_order: 1, page_stage: "consider" },
    { title: "Customer Stories",           page_type: "html",   sort_order: 2, page_stage: "consider" },
    { title: "Talk to Sales",              page_type: "iframe", sort_order: 3, page_stage: "decide"   },
  ];
  const existingJ3Orders = new Set(
    (await pool.query(`SELECT sort_order FROM journey_pages WHERE journey_id=$1`, [j3Id])).rows.map(r => r.sort_order as number),
  );
  for (const p of j3PageSpecs) {
    if (!existingJ3Orders.has(p.sort_order)) {
      await pool.query(
        `INSERT INTO journey_pages (journey_id, title, page_type, sort_order, page_stage, cta_enabled) VALUES ($1,$2,$3,$4,$5,'false')`,
        [j3Id, p.title, p.page_type, p.sort_order, p.page_stage],
      );
    }
  }
  if (mmPlayId) {
    await pool.query(`INSERT INTO journey_plays (journey_id, play_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [j3Id, mmPlayId]);
  }
  const j3Pages = (await pool.query(`SELECT id FROM journey_pages WHERE journey_id=$1 ORDER BY sort_order`, [j3Id])).rows.map(r => r.id as number);
  await pool.query(`SELECT setval('journeys_id_seq', (SELECT MAX(id) FROM journeys))`);
  await pool.query(`SELECT setval('journey_pages_id_seq', (SELECT MAX(id) FROM journey_pages))`);
  console.log(`✓ Journey 3: 'Enterprise Upsell Intro' (id=${j3Id}), pages [${j3Pages.join(", ")}]`);

  // ── Journey Events ────────────────────────────────────────────────────────────
  // Realistic anonymous traffic across all seeded journeys for the last 60 days.
  // Idempotent: delete seed events (visitor_token LIKE 'seed-vt-%') then re-insert.
  const allJourneyDefs: { id: number; pages: number[] }[] = [
    { id: journeyId, pages: j1Pages },
    { id: j2Id,      pages: j2Pages },
    { id: j3Id,      pages: j3Pages },
  ];
  const allJourneyIdList = allJourneyDefs.map(j => j.id);

  await pool.query(
    `DELETE FROM journey_events WHERE tenant_id=1 AND journey_id = ANY($1::int[]) AND visitor_token LIKE 'seed-vt-%'`,
    [allJourneyIdList],
  );
  await pool.query(`DELETE FROM form_submissions  WHERE tenant_id=1 AND visitor_token LIKE 'seed-vt-%'`);
  await pool.query(`DELETE FROM visitor_tokens    WHERE tenant_id=1 AND token         LIKE 'seed-vt-%'`);

  // 25 unique visitor tokens (stable prefix so idempotency DELETE above catches them)
  const VISITOR_COUNT = 25;
  const visitorTokens: string[] = Array.from({ length: VISITOR_COUNT }, () => `seed-vt-${randomUUID()}`);

  // Journey weights: journey 1 gets ~50% of traffic
  const journeyWeights = [0.50, 0.28, 0.22];
  function pickJourneyDef(): { id: number; pages: number[] } {
    const r = Math.random();
    if (r < journeyWeights[0]) return allJourneyDefs[0];
    if (r < journeyWeights[0] + journeyWeights[1]) return allJourneyDefs[1];
    return allJourneyDefs[2];
  }

  // Realistic IP address pools to simulate traffic from different "sources"
  // (journey_events has no source/UTM columns — ip_address is the only attribution field available)
  const IP_POOLS = {
    email:    ["203.0.113.10", "203.0.113.11", "203.0.113.12", "203.0.113.13"], // email client IPs
    linkedin: ["198.41.128.1", "198.41.128.2", "198.41.128.3"],                  // LinkedIn proxy range
    google:   ["66.249.64.1",  "66.249.64.2",  "66.249.64.3"],                   // Google crawler range
    direct:   ["192.0.2.50",   "192.0.2.51",   "192.0.2.52",   "192.0.2.53",    // Direct / unknown
               "192.0.2.54",   "192.0.2.55",   "192.0.2.56"],
  };
  const ALL_IPS = Object.values(IP_POOLS).flat();
  function pickIp(): string { return ALL_IPS[Math.floor(Math.random() * ALL_IPS.length)]; }

  // Build ~650 events spread over last 60 days
  // Event mix: mostly page_view, plus cta_click and form_start for interactive depth
  type JE = { journey_id: number; page_id: number; event_type: string; visitor_token: string; days_ago: number; ip: string };
  const EVENT_MIX = ["page_view", "page_view", "page_view", "page_view", "cta_click", "form_start"];
  const events: JE[] = [];
  const TOTAL_EVENTS = 650;

  for (let i = 0; i < TOTAL_EVENTS; i++) {
    const token   = visitorTokens[Math.floor(Math.random() * VISITOR_COUNT)];
    const jDef    = pickJourneyDef();
    const pageId  = jDef.pages[Math.floor(Math.random() * jDef.pages.length)];
    const evType  = EVENT_MIX[Math.floor(Math.random() * EVENT_MIX.length)];
    // Weight toward recent days (Poisson-like: more events in last 30 days)
    const daysAgo = Math.random() < 0.6 ? Math.floor(Math.random() * 30) : Math.floor(Math.random() * 60);
    events.push({ journey_id: jDef.id, page_id: pageId, event_type: evType, visitor_token: token, days_ago: daysAgo, ip: pickIp() });
  }

  // Batch insert in chunks of 100
  const JE_CHUNK = 100;
  for (let i = 0; i < events.length; i += JE_CHUNK) {
    const chunk = events.slice(i, i + JE_CHUNK);
    const placeholders = chunk.map((_, idx) => {
      const b = idx * 7;
      return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, NOW() - ($${b+7} || ' days')::interval + (random()*3600 || ' seconds')::interval)`;
    }).join(", ");
    const params = chunk.flatMap(e => [1, e.journey_id, e.page_id, e.event_type, e.visitor_token, e.ip, e.days_ago]);
    await pool.query(
      `INSERT INTO journey_events (tenant_id, journey_id, page_id, event_type, visitor_token, ip_address, created_at) VALUES ${placeholders}`,
      params,
    );
  }
  console.log(`✓ Journey events: ${events.length} events seeded across ${allJourneyDefs.length} journeys (last 60 days, weighted toward recent 30d)`);

  // ── Visitor Tokens + Form Submissions ─────────────────────────────────────────
  // Link ~20% of visitor tokens to real contacts → makes ABM Data tab show identified users.
  const identifiedCount  = Math.max(4, Math.round(VISITOR_COUNT * 0.2));
  const identifiedTokens = visitorTokens.slice(0, identifiedCount);
  const allContactIds    = allContacts.rows.map(r => r.id as number);

  for (let i = 0; i < identifiedTokens.length; i++) {
    const token     = identifiedTokens[i];
    const contactId = allContactIds[i % allContactIds.length];
    await pool.query(
      `INSERT INTO visitor_tokens (token, contact_id, tenant_id) VALUES ($1,$2,$3) ON CONFLICT (token) DO NOTHING`,
      [token, contactId, 1],
    );
  }
  console.log(`✓ Visitor tokens: linked ${identifiedCount} seed visitors to contacts`);

  // Insert form submissions for identified visitors (Demo Request form)
  for (let i = 0; i < identifiedTokens.length; i++) {
    const token     = identifiedTokens[i];
    const contactId = allContactIds[i % allContactIds.length];
    const jDef      = allJourneyDefs[i % allJourneyDefs.length];
    const pageId    = jDef.pages[Math.min(1, jDef.pages.length - 1)];
    const daysAgo   = Math.floor(Math.random() * 45) + 1;
    await pool.query(`
      INSERT INTO form_submissions
        (tenant_id, form_id, contact_id, journey_id, page_id, visitor_token, field_values, action_type, submitted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'form_submit', NOW() - ($8 || ' days')::interval)
    `, [
      1, demoRequestFormId, contactId, jDef.id, pageId, token,
      JSON.stringify({ firstName: "Seed", lastName: "Visitor", email: `seed-visitor-${i}@example.com`, company: "Seed Corp" }),
      daysAgo,
    ]);
  }
  await pool.query(`SELECT setval('form_submissions_id_seq', (SELECT MAX(id) FROM form_submissions))`);
  console.log(`✓ Form submissions: ${identifiedCount} demo request submissions seeded`);

  // ── Extra Activity Events (Form Fills + Downloads for Traffic tab) ─────────────
  // The Traffic tab KPI "Form Fills" reads from activity_events (event_type='form_submit').
  // "Downloads" reads from activity_events (event_type='asset_download').
  // Idempotent: delete seed events (identified by description suffix) before re-inserting.
  await pool.query(`
    DELETE FROM activity_events
    WHERE event_type IN ('form_submit','asset_download')
      AND contact_id IN (SELECT id FROM contacts WHERE tenant_id=1)
      AND (description LIKE '% submitted Demo Request [seed]' OR description LIKE '% downloaded ROI Calculator [seed]')
  `);
  const allContactRows = allContacts.rows;
  for (let i = 0; i < 12; i++) {
    const contact = allContactRows[i % allContactRows.length];
    const daysAgo = Math.floor(Math.random() * 50) + 1;
    await pool.query(`
      INSERT INTO activity_events (contact_id, contact_name, event_type, description, points_earned, created_at)
      VALUES ($1,$2,'form_submit',$3,20, NOW() - ($4 || ' days')::interval)
    `, [contact.id, `${contact.first_name} ${contact.last_name}`, `${contact.first_name} submitted Demo Request [seed]`, daysAgo]);
  }
  for (let i = 0; i < 8; i++) {
    const contact = allContactRows[(i + 5) % allContactRows.length];
    const daysAgo = Math.floor(Math.random() * 45) + 1;
    await pool.query(`
      INSERT INTO activity_events (contact_id, contact_name, event_type, description, points_earned, created_at)
      VALUES ($1,$2,'asset_download',$3,10, NOW() - ($4 || ' days')::interval)
    `, [contact.id, `${contact.first_name} ${contact.last_name}`, `${contact.first_name} downloaded ROI Calculator [seed]`, daysAgo]);
  }
  console.log("✓ Activity events: form_submit (12) and asset_download (8) events seeded for Traffic tab KPIs");

  await pool.end();
  console.log("\nSeed complete!");
}

main().catch(err => { console.error(err); process.exit(1); });
