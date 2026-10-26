// Agency board API. Every route here needs an admin or agent session.
const express = require("express");
const db = require("../db");
const auth = require("../lib/auth");
const svc = require("../lib/students");
const { STAGES, APP_STATUSES, restrictionFor } = require("../lib/pipeline");

const router = express.Router();
router.use(auth.requireStaff);

function bad(res, msg, status = 400) {
  return res.status(status).json({ error: msg });
}

function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const isDate = (v) => v == null || v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v);

async function loadStudent(req, res) {
  const id = toInt(req.params.id);
  const s = id && (await db.one("SELECT * FROM students WHERE id = $1", [id]));
  if (!s) {
    bad(res, "Student not found", 404);
    return null;
  }
  return s;
}

/* ---------- Board ---------- */

router.get("/summary", async (_req, res) => {
  const stages = await db.many("SELECT stage, count(*)::int AS n FROM students WHERE NOT closed GROUP BY stage");
  const money = await db.one(
    `SELECT COALESCE(sum(amount_uzs) FILTER (WHERE status = 'paid'), 0)::bigint AS paid,
            COALESCE(sum(amount_uzs) FILTER (WHERE status = 'pending'), 0)::bigint AS pending
       FROM invoices`
  );
  const dueSoon = await db.one(
    `SELECT count(*)::int AS n FROM documents d JOIN students s ON s.id = d.student_id
      WHERE d.status = 'missing' AND NOT s.closed AND d.due_date IS NOT NULL AND d.due_date <= CURRENT_DATE + 7`
  );
  const byStage = Object.fromEntries(STAGES.map((k) => [k, 0]));
  for (const r of stages) byStage[r.stage] = r.n;
  res.json({ stages: byStage, paid_uzs: Number(money.paid), pending_uzs: Number(money.pending), documents_due_7d: dueSoon.n });
});

router.get("/students", async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.closed === "1") where.push("s.closed");
  else where.push("NOT s.closed");
  if (req.query.stage) {
    params.push(req.query.stage);
    where.push(`s.stage = $${params.length}`);
  }
  if (req.query.agent === "me") {
    params.push(req.user.id);
    where.push(`s.agent_id = $${params.length}`);
  }
  if (req.query.q) {
    params.push(`%${String(req.query.q).toLowerCase()}%`);
    where.push(`(lower(s.full_name) LIKE $${params.length} OR s.phone LIKE $${params.length} OR lower(COALESCE(s.email,'')) LIKE $${params.length})`);
  }
  const rows = await db.many(
    `SELECT s.id, s.full_name, s.phone, s.city, s.stage, s.closed, s.program_type, s.target_intake, s.package,
            s.source, s.updated_at, s.agent_id, a.name AS agent_name, (s.user_id IS NOT NULL) AS has_account,
            (SELECT count(*)::int FROM documents d WHERE d.student_id = s.id) AS docs_total,
            (SELECT count(*)::int FROM documents d WHERE d.student_id = s.id AND d.status <> 'missing') AS docs_done,
            (SELECT min(d.due_date) FROM documents d WHERE d.student_id = s.id AND d.status = 'missing') AS next_due,
            (SELECT count(*)::int FROM applications ap WHERE ap.student_id = s.id) AS apps,
            (SELECT COALESCE(sum(amount_uzs),0)::bigint FROM invoices i WHERE i.student_id = s.id AND i.status = 'pending') AS unpaid_uzs,
            EXISTS (SELECT 1 FROM applications ap JOIN universities u ON u.id = ap.university_id
                     WHERE ap.student_id = s.id AND u.ieqas_status = 'restricted'
                       AND (u.restricted_until IS NULL OR u.restricted_until >= CURRENT_DATE)
                       AND (u.restricted_programs IN ('all') OR u.restricted_programs = ap.program_type)) AS restricted_warning
       FROM students s LEFT JOIN users a ON a.id = s.agent_id
      WHERE ${where.join(" AND ")}
      ORDER BY s.updated_at DESC`,
    params
  );
  res.json({ stages: STAGES, students: rows });
});

const STUDENT_FIELDS = ["full_name", "phone", "email", "city", "parent_name", "parent_phone", "program_type", "target_intake", "package", "source", "notes", "agent_id"];

router.post("/students", async (req, res) => {
  const b = req.body || {};
  const name = String(b.full_name || "").trim();
  if (!name) return bad(res, "Name is required");
  if (b.program_type && !["degree", "language"].includes(b.program_type)) return bad(res, "Program type must be degree or language");
  const stage = b.stage && STAGES.includes(b.stage) ? b.stage : "lead";
  const s = await db.one(
    `INSERT INTO students (full_name, phone, email, city, parent_name, parent_phone, program_type, target_intake, package, source, notes, agent_id, stage)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [name, b.phone || null, b.email || null, b.city || null, b.parent_name || null, b.parent_phone || null,
      b.program_type || "degree", b.target_intake || null, b.package || null, b.source || "agency", b.notes || null,
      toInt(b.agent_id) || req.user.id, stage]
  );
  await svc.addEvent(s.id, req.user.id, "created", "Added to WeHelp", true);
  res.status(201).json({ student: s });
});

router.get("/students/:id", async (req, res) => {
  const s = await loadStudent(req, res);
  if (!s) return;
  const view = await svc.progressView(s.id);
  const events = await db.many(
    `SELECT e.id, e.kind, e.message, e.public, e.created_at, u.name AS actor
       FROM events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.student_id = $1 ORDER BY e.created_at DESC LIMIT 100`,
    [s.id]
  );
  const invoices = await db.many("SELECT * FROM invoices WHERE student_id = $1 ORDER BY created_at", [s.id]);
  const parentChats = await db.one("SELECT count(*)::int AS n FROM parent_chats WHERE student_id = $1", [s.id]);
  const { portal_state, ...student } = s;
  res.json({
    student,
    applications: view.applications,
    documents: view.documents,
    events,
    invoices,
    parent_telegram_links: parentChats.n,
    portal: portal_state ? summarizePortal(portal_state) : null,
  });
});

// What the student filled in on the student site, condensed for the card.
function summarizePortal(p) {
  const prof = p.profile || {};
  return {
    profile: {
      name: [prof.firstName, prof.lastName].filter(Boolean).join(" "),
      school: prof.school || null,
      gpa: prof.gpa ? `${prof.gpa}/${prof.gpaScale || "4.0"}` : null,
      ielts: prof.ielts || null,
      sat: prof.sat || null,
      statement_chars: (prof.statement || "").length,
      activities: (prof.activities || []).length,
    },
    shortlist: Array.isArray(p.shortlist) ? p.shortlist : [],
    apps: Array.isArray(p.apps) ? p.apps.map((a) => ({ uniId: a.uniId, status: a.status, program: a.program })) : [],
    saved_at: p.saved_at || null,
  };
}

router.patch("/students/:id", async (req, res) => {
  let s = await loadStudent(req, res);
  if (!s) return;
  const b = req.body || {};
  const sets = [];
  const params = [];
  for (const f of STUDENT_FIELDS) {
    if (f in b) {
      if (f === "program_type" && !["degree", "language"].includes(b[f])) return bad(res, "Program type must be degree or language");
      params.push(f === "agent_id" ? toInt(b[f]) : b[f] === "" ? null : b[f]);
      sets.push(`${f} = $${params.length}`);
    }
  }
  if ("closed" in b) {
    params.push(!!b.closed);
    sets.push(`closed = $${params.length}`);
    params.push(b.closed ? b.closed_reason || null : null);
    sets.push(`closed_reason = $${params.length}`);
  }
  if (sets.length) {
    params.push(s.id);
    s = await db.one(`UPDATE students SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
    if ("closed" in b) await svc.addEvent(s.id, req.user.id, "closed", b.closed ? `Closed${b.closed_reason ? ": " + b.closed_reason : ""}` : "Reopened", false);
  }
  if (b.stage) {
    if (!STAGES.includes(b.stage)) return bad(res, "Unknown stage");
    s = await svc.setStage(s, b.stage, req.user.id);
  }
  const { portal_state, ...student } = s;
  res.json({ student });
});

router.delete("/students/:id", auth.requireRole("admin"), async (req, res) => {
  const s = await loadStudent(req, res);
  if (!s) return;
  const paid = await db.one("SELECT 1 FROM invoices WHERE student_id = $1 AND status IN ('paid','refunded')", [s.id]);
  if (paid) return bad(res, "This student has payments on record. Close the card instead of deleting it.", 409);
  await db.query("DELETE FROM students WHERE id = $1", [s.id]);
  res.json({ ok: true });
});

router.post("/students/:id/notes", async (req, res) => {
  const s = await loadStudent(req, res);
  if (!s) return;
  const text = String(req.body?.text || "").trim();
  if (!text) return bad(res, "Note is empty");
  await svc.addEvent(s.id, req.user.id, req.body?.public ? "update" : "note", text, !!req.body?.public);
  await db.query("UPDATE students SET updated_at = now() WHERE id = $1", [s.id]);
  res.status(201).json({ ok: true });
});

router.post("/students/:id/invite", async (req, res) => {
  const s = await loadStudent(req, res);
  if (!s) return;
  if (s.user_id) return bad(res, "This student already has an account", 409);
  const code = auth.shortCode(8);
  await db.query("UPDATE students SET invite_code = $1 WHERE id = $2", [code, s.id]);
  res.json({ invite_code: code });
});

router.post("/students/:id/parent-link", async (req, res) => {
  const s = await loadStudent(req, res);
  if (!s) return;
  const token = auth.randomToken(24);
  await db.query("UPDATE students SET parent_token = $1 WHERE id = $2", [token, s.id]);
  // A new link revokes the old one, and the Telegram chats linked through it.
  await db.query("DELETE FROM parent_chats WHERE student_id = $1", [s.id]);
  const { deepLink } = require("../lib/telegram");
  res.json({ token, path: `/parent.html#${token}`, telegram: deepLink(`p_${token}`) });
});

/* ---------- Applications ---------- */

router.post("/students/:id/applications", async (req, res) => {
  const s = await loadStudent(req, res);
  if (!s) return;
  const b = req.body || {};
  if (!isDate(b.deadline)) return bad(res, "Deadline must be YYYY-MM-DD");
  if (b.program_type && !["degree", "language"].includes(b.program_type)) return bad(res, "Program type must be degree or language");
  try {
    const result = await svc.createApplication(s.id, { ...b, program_type: b.program_type || s.program_type }, req.user.id, { force: !!b.force });
    if (s.stage === "lead") await svc.setStage(s, "documents", req.user.id);
    res.status(201).json(result);
  } catch (e) {
    if (e.code === "23505") return bad(res, "This student already has an application to that university for this program type", 409);
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
});

router.patch("/applications/:id", async (req, res) => {
  const id = toInt(req.params.id);
  const app = id && (await db.one("SELECT ap.*, u.name AS university FROM applications ap JOIN universities u ON u.id = ap.university_id WHERE ap.id = $1", [id]));
  if (!app) return bad(res, "Application not found", 404);
  const b = req.body || {};
  if (b.status && !APP_STATUSES.includes(b.status)) return bad(res, "Unknown status");
  if (!isDate(b.deadline)) return bad(res, "Deadline must be YYYY-MM-DD");
  const updated = await db.one(
    `UPDATE applications SET status = COALESCE($1, status), program = COALESCE($2, program),
            deadline = CASE WHEN $3::boolean THEN $4::date ELSE deadline END, updated_at = now()
      WHERE id = $5 RETURNING *`,
    [b.status || null, b.program || null, "deadline" in b, b.deadline || null, id]
  );
  if (b.status && b.status !== app.status) {
    const labels = { draft: "Draft", submitted: "Submitted", review: "Under review", admitted: "Admitted 🎉", waitlisted: "Waitlisted", declined: "Not admitted" };
    await svc.addEvent(app.student_id, req.user.id, "application", `${app.university}: ${labels[b.status]}`);
  }
  if ("deadline" in b) {
    // Missing documents for this application follow the application deadline.
    await db.query("UPDATE documents SET due_date = $1 WHERE application_id = $2 AND status = 'missing'", [b.deadline || null, id]);
  }
  await db.query("UPDATE students SET updated_at = now() WHERE id = $1", [app.student_id]);
  res.json({ application: updated });
});

router.delete("/applications/:id", async (req, res) => {
  const id = toInt(req.params.id);
  const app = id && (await db.one("DELETE FROM applications WHERE id = $1 RETURNING *", [id]));
  if (!app) return bad(res, "Application not found", 404);
  res.json({ ok: true });
});

/* ---------- Documents ---------- */

router.post("/students/:id/documents", async (req, res) => {
  const s = await loadStudent(req, res);
  if (!s) return;
  const b = req.body || {};
  const label = String(b.label || "").trim();
  if (!label) return bad(res, "Label is required");
  if (!isDate(b.due_date)) return bad(res, "Due date must be YYYY-MM-DD");
  const appId = toInt(b.application_id);
  if (appId && !(await db.one("SELECT 1 FROM applications WHERE id = $1 AND student_id = $2", [appId, s.id]))) {
    return bad(res, "Application does not belong to this student");
  }
  const doc = await db.one(
    "INSERT INTO documents (student_id, application_id, doc_key, label, due_date, sort) VALUES ($1,$2,'custom',$3,$4,50) RETURNING *",
    [s.id, appId, label, b.due_date || null]
  );
  res.status(201).json({ document: doc });
});

router.post("/students/:id/visa-checklist", async (req, res) => {
  const s = await loadStudent(req, res);
  if (!s) return;
  await svc.addVisaChecklist(s.id);
  res.json({ ok: true });
});

router.patch("/documents/:id", async (req, res) => {
  const id = toInt(req.params.id);
  const doc = id && (await db.one("SELECT * FROM documents WHERE id = $1", [id]));
  if (!doc) return bad(res, "Document not found", 404);
  const b = req.body || {};
  if (b.status && !["missing", "received", "verified"].includes(b.status)) return bad(res, "Unknown status");
  if (!isDate(b.due_date)) return bad(res, "Due date must be YYYY-MM-DD");
  const updated = await db.one(
    `UPDATE documents SET status = COALESCE($1, status), note = CASE WHEN $2::boolean THEN $3 ELSE note END,
            due_date = CASE WHEN $4::boolean THEN $5::date ELSE due_date END, updated_at = now()
      WHERE id = $6 RETURNING *`,
    [b.status || null, "note" in b, b.note || null, "due_date" in b, b.due_date || null, id]
  );
  if (b.status && b.status !== doc.status && b.status !== "missing") {
    await svc.addEvent(doc.student_id, req.user.id, "document", `${doc.label}: ${b.status === "verified" ? "checked ✓" : "received"}`);
  }
  await db.query("UPDATE students SET updated_at = now() WHERE id = $1", [doc.student_id]);
  res.json({ document: updated });
});

router.delete("/documents/:id", async (req, res) => {
  const id = toInt(req.params.id);
  const doc = id && (await db.one("DELETE FROM documents WHERE id = $1 RETURNING id", [id]));
  if (!doc) return bad(res, "Document not found", 404);
  res.json({ ok: true });
});

/* ---------- Invoices ---------- */

router.post("/students/:id/invoices", async (req, res) => {
  const s = await loadStudent(req, res);
  if (!s) return;
  const description = String(req.body?.description || "").trim();
  const amount = Number(req.body?.amount_uzs);
  if (!description) return bad(res, "Description is required");
  if (!Number.isInteger(amount) || amount < 1000) return bad(res, "Amount must be a whole number of so'm, at least 1,000");
  const inv = await db.one(
    "INSERT INTO invoices (student_id, description, amount_uzs, created_by) VALUES ($1,$2,$3,$4) RETURNING *",
    [s.id, description, amount, req.user.id]
  );
  await svc.addEvent(s.id, req.user.id, "invoice", `New invoice: ${description} — ${amount.toLocaleString("en-US")} so'm`);
  res.status(201).json({ invoice: inv });
});

// Manual status changes: cash/bank payments, cancelling an unpaid invoice,
// or recording a refund (Korea's 2026 agent rules require refunds when a visa is denied).
router.patch("/invoices/:id", async (req, res) => {
  const id = toInt(req.params.id);
  const inv = id && (await db.one("SELECT * FROM invoices WHERE id = $1", [id]));
  if (!inv) return bad(res, "Invoice not found", 404);
  const status = req.body?.status;
  const allowed = { pending: ["paid", "cancelled"], paid: ["refunded"] };
  if (!(allowed[inv.status] || []).includes(status)) return bad(res, `Cannot change a ${inv.status} invoice to ${status}`, 409);
  if (status === "paid" && !["cash", "bank"].includes(req.body?.provider)) return bad(res, "Manual payments must be cash or bank");
  if (inv.status === "pending" && status === "cancelled") {
    const live = await db.one(
      `SELECT 1 FROM payme_transactions WHERE invoice_id = $1 AND state = 1
        UNION ALL SELECT 1 FROM click_transactions WHERE invoice_id = $1 AND status = 'prepared'`,
      [id]
    );
    if (live) return bad(res, "A Click or Payme payment for this invoice is in progress", 409);
  }
  const updated = await db.one(
    `UPDATE invoices SET status = $1, provider = COALESCE($2, provider), paid_at = CASE WHEN $1 = 'paid' THEN now() ELSE paid_at END
      WHERE id = $3 RETURNING *`,
    [status, status === "paid" ? req.body.provider : null, id]
  );
  const verb = { paid: "Payment received", cancelled: "Invoice cancelled", refunded: "Refunded" }[status];
  await svc.addEvent(inv.student_id, req.user.id, "invoice", `${verb}: ${inv.description}`);
  res.json({ invoice: updated });
});

/* ---------- Staff ---------- */

router.get("/staff", async (_req, res) => {
  res.json({ staff: await db.many("SELECT id, name, email, phone, role, (telegram_chat_id IS NOT NULL) AS telegram_linked FROM users WHERE role IN ('admin','agent') ORDER BY id") });
});

router.post("/staff", auth.requireRole("admin"), async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, "Enter a valid email");
  if (String(b.password || "").length < 8) return bad(res, "Password must be at least 8 characters");
  const role = b.role === "admin" ? "admin" : "agent";
  try {
    const u = await db.one(
      "INSERT INTO users (email, password_hash, name, phone, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, phone, role",
      [email, auth.hashPassword(b.password), String(b.name || email).trim(), b.phone || null, role]
    );
    res.status(201).json({ user: u });
  } catch (e) {
    if (e.code === "23505") return bad(res, "That email is already used", 409);
    throw e;
  }
});

module.exports = { router, restrictionFor };
