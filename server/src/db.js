const fs = require("fs");
const path = require("path");
const { Pool, types } = require("pg");

// BIGINT ids and money fit comfortably in a JS number at this scale.
types.setTypeParser(20, (v) => Number(v));
// Keep DATE columns as plain 'YYYY-MM-DD' strings, never shifted by timezone.
types.setTypeParser(1082, (v) => v);

let pool = null;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const ssl = /sslmode=require/.test(url) || /supabase\.(com|co)\b/.test(url) || process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined;
    pool = new Pool({ connectionString: url, ssl, max: 10 });
    // DB_SCHEMA keeps UniSprint's tables in their own schema when the database
    // is shared with another app (e.g. a Supabase project). Use a session-mode
    // connection (Supabase's session pooler on port 5432), not transaction mode.
    const schema = dbSchema();
    if (schema) pool.on("connect", (client) => client.query(`SET search_path TO "${schema}"`).catch((e) => console.error("[db] search_path:", e.message)));
  }
  return pool;
}

function dbSchema() {
  const s = (process.env.DB_SCHEMA || "").trim();
  if (s && !/^[a-z_][a-z0-9_]{0,62}$/.test(s)) throw new Error("DB_SCHEMA must be a lowercase identifier");
  return s || null;
}

function query(text, params) {
  return getPool().query(text, params);
}

async function one(text, params) {
  const r = await query(text, params);
  return r.rows[0] || null;
}

async function many(text, params) {
  const r = await query(text, params);
  return r.rows;
}

async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  const schema = dbSchema();
  if (schema) {
    await query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await query(`SET search_path TO "${schema}"`); // this pooled client may predate the schema
  }
  await query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const dir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set((await many("SELECT name FROM schema_migrations")).map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    await tx(async (c) => {
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
    });
  }
  await seed();
}

function slugify(name) {
  return name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Idempotent: inserts what is missing and never overwrites edits made on the board.
async function seed() {
  const dataDir = path.join(__dirname, "..", "data");
  const unis = JSON.parse(fs.readFileSync(path.join(dataDir, "universities.json"), "utf8"));
  for (const u of unis) {
    await query(
      `INSERT INTO universities (id, name, city, country, in_catalog, deadline_note, intake, apply_url)
       VALUES ($1,$2,$3,$4,true,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [u.id, u.name, u.city, u.country, u.deadline_note, u.intake, u.apply_url]
    );
  }

  const r = JSON.parse(fs.readFileSync(path.join(dataDir, "restricted-2026.json"), "utf8"));
  const restricted = [
    ...r.degree.map((name) => [name, "degree"]),
    ...r.language.map((name) => [name, "language"]),
  ];
  for (const [name, programs] of restricted) {
    await query(
      `INSERT INTO universities (id, name, ieqas_status, restricted_programs, restricted_until, ieqas_note, ieqas_checked_at, ieqas_source)
       VALUES ($1,$2,'restricted',$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [slugify(name), name, programs, r.restricted_until, r.note, r.announced, r.source]
    );
  }

  const templates = JSON.parse(fs.readFileSync(path.join(dataDir, "document-templates.json"), "utf8"));
  for (const programType of ["degree", "language", "visa"]) {
    const items = templates[programType];
    for (let i = 0; i < items.length; i++) {
      const [key, label] = items[i];
      await query(
        `INSERT INTO document_templates (university_id, program_type, doc_key, label, sort)
         VALUES (NULL,$1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [programType, key, label, i]
      );
    }
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { query, one, many, tx, migrate, seed, slugify, close, getPool };
