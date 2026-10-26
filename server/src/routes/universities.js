const express = require("express");
const db = require("../db");
const auth = require("../lib/auth");
const { restrictionFor } = require("../lib/pipeline");

const router = express.Router();

const IEQAS = ["excellent", "certified", "unverified", "not_certified", "restricted"];
const PUBLIC_COLS = `id, name, city, country, in_catalog, deadline_note, intake, apply_url, ieqas_status,
  restricted_programs, restricted_until, ieqas_note, ieqas_checked_at, ieqas_source`;

function withFlag(u) {
  return {
    ...u,
    restricted_degree: !!restrictionFor(u, "degree"),
    restricted_language: !!restrictionFor(u, "language"),
  };
}

// Public: the student site reads this to show the certified/restricted flag.
router.get("/", async (req, res) => {
  const all = req.query.all === "1";
  const rows = await db.many(`SELECT ${PUBLIC_COLS} FROM universities ${all ? "" : "WHERE in_catalog"} ORDER BY in_catalog DESC, name`);
  res.json({ universities: rows.map(withFlag) });
});

// Public: "is this school safe for a visa?" lookup by name, for schools outside the catalog.
router.get("/check", async (req, res) => {
  const q = String(req.query.name || "").trim().toLowerCase();
  if (q.length < 3) return res.status(400).json({ error: "Type at least 3 letters" });
  const words = q.split(/\s+/).filter((w) => w.length > 2 && !["university", "college", "the", "of"].includes(w));
  const pattern = `%${(words.length ? words : [q]).join("%")}%`;
  const rows = await db.many(`SELECT ${PUBLIC_COLS} FROM universities WHERE lower(name) LIKE $1 ORDER BY name LIMIT 10`, [pattern]);
  res.json({ matches: rows.map(withFlag) });
});

router.post("/", auth.requireStaff, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required" });
  const id = b.id ? db.slugify(String(b.id)) : db.slugify(name);
  try {
    const u = await db.one(
      `INSERT INTO universities (id, name, city, in_catalog, deadline_note, intake, apply_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, name, b.city || null, !!b.in_catalog, b.deadline_note || null, b.intake || null, b.apply_url || null]
    );
    res.status(201).json({ university: withFlag(u) });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "A university with that id already exists" });
    throw e;
  }
});

router.patch("/:id", auth.requireStaff, async (req, res) => {
  const b = req.body || {};
  if (b.ieqas_status && !IEQAS.includes(b.ieqas_status)) return res.status(400).json({ error: "Unknown IEQAS status" });
  if (b.restricted_programs && !["degree", "language", "all"].includes(b.restricted_programs)) {
    return res.status(400).json({ error: "restricted_programs must be degree, language or all" });
  }
  const fields = ["name", "city", "in_catalog", "deadline_note", "intake", "apply_url", "ieqas_status", "restricted_programs", "restricted_until", "ieqas_note", "ieqas_source"];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (f in b) {
      params.push(b[f] === "" ? null : b[f]);
      sets.push(`${f} = $${params.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
  // Touching the flag records when someone last checked the official list.
  if (["ieqas_status", "restricted_programs", "restricted_until"].some((f) => f in b)) sets.push("ieqas_checked_at = CURRENT_DATE");
  params.push(req.params.id);
  const u = await db.one(`UPDATE universities SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
  if (!u) return res.status(404).json({ error: "University not found" });
  res.json({ university: withFlag(u) });
});

// Per-university checklist. Falls back to the default list when none is set.
router.get("/:id/documents", auth.requireStaff, async (req, res) => {
  const type = req.query.program_type === "language" ? "language" : "degree";
  let rows = await db.many("SELECT doc_key, label FROM document_templates WHERE university_id = $1 AND program_type = $2 ORDER BY sort", [req.params.id, type]);
  const custom = rows.length > 0;
  if (!custom) rows = await db.many("SELECT doc_key, label FROM document_templates WHERE university_id IS NULL AND program_type = $1 ORDER BY sort", [type]);
  res.json({ program_type: type, custom, documents: rows });
});

router.put("/:id/documents", auth.requireStaff, async (req, res) => {
  const type = req.body?.program_type === "language" ? "language" : "degree";
  const docs = Array.isArray(req.body?.documents) ? req.body.documents : null;
  if (!docs) return res.status(400).json({ error: "documents must be a list" });
  const uni = await db.one("SELECT id FROM universities WHERE id = $1", [req.params.id]);
  if (!uni) return res.status(404).json({ error: "University not found" });
  const clean = [];
  const seen = new Set();
  for (const d of docs) {
    const label = String(d.label || "").trim();
    if (!label) continue;
    let key = db.slugify(String(d.doc_key || label)).replace(/-/g, "_").slice(0, 40) || "doc";
    while (seen.has(key)) key += "_";
    seen.add(key);
    clean.push([key, label]);
  }
  await db.tx(async (c) => {
    await c.query("DELETE FROM document_templates WHERE university_id = $1 AND program_type = $2", [uni.id, type]);
    for (let i = 0; i < clean.length; i++) {
      await c.query("INSERT INTO document_templates (university_id, program_type, doc_key, label, sort) VALUES ($1,$2,$3,$4,$5)", [uni.id, type, clean[i][0], clean[i][1], i]);
    }
  });
  res.json({ program_type: type, custom: clean.length > 0, documents: clean.map(([doc_key, label]) => ({ doc_key, label })) });
});

module.exports = { router };
