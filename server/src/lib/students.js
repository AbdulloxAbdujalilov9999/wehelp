// Board logic shared by the staff, student, parent and lead routes.
const db = require("../db");
const telegram = require("./telegram");
const { STAGES, STAGE_LABELS, restrictionFor } = require("./pipeline");

async function addEvent(studentId, actorId, kind, message, isPublic = true, client = db) {
  await client.query(
    "INSERT INTO events (student_id, actor_id, kind, message, public) VALUES ($1,$2,$3,$4,$5)",
    [studentId, actorId || null, kind, message, isPublic]
  );
}

// Everyone who should hear about a student: the student, their agent, and linked parents.
async function recipients(studentId) {
  const row = await db.one(
    `SELECT su.telegram_chat_id AS student_chat, au.telegram_chat_id AS agent_chat
       FROM students s
       LEFT JOIN users su ON su.id = s.user_id
       LEFT JOIN users au ON au.id = s.agent_id
      WHERE s.id = $1`,
    [studentId]
  );
  const parents = await db.many("SELECT chat_id FROM parent_chats WHERE student_id = $1", [studentId]);
  return {
    student: row?.student_chat || null,
    agent: row?.agent_chat || null,
    parents: parents.map((p) => p.chat_id),
  };
}

async function setStage(student, stage, actorId) {
  if (!STAGES.includes(stage)) throw Object.assign(new Error("Unknown stage"), { status: 400 });
  if (student.stage === stage) return student;
  const updated = await db.one("UPDATE students SET stage = $1, updated_at = now() WHERE id = $2 RETURNING *", [stage, student.id]);
  await addEvent(student.id, actorId, "stage", `Stage: ${STAGE_LABELS.en[student.stage]} → ${STAGE_LABELS.en[stage]}`);

  if (stage === "visa") await addVisaChecklist(student.id);

  const to = await recipients(student.id);
  const first = telegram.escapeHtml(student.full_name.split(" ")[0]);
  const msg =
    `<b>WeHelp</b> · ${first}\n` +
    `🇺🇿 ${STAGE_LABELS.uz[stage]}\n🇷🇺 ${STAGE_LABELS.ru[stage]}\n🇬🇧 ${STAGE_LABELS.en[stage]}`;
  for (const chat of [to.student, ...to.parents]) await telegram.sendMessage(chat, msg);
  return updated;
}

// Copy the checklist for a university into a new application. University-specific
// templates win; otherwise the default for the program type is used.
async function createApplication(studentId, { university_id, program, program_type = "degree", deadline }, actorId, { force = false } = {}) {
  const uni = await db.one("SELECT * FROM universities WHERE id = $1", [university_id]);
  if (!uni) throw Object.assign(new Error("Unknown university"), { status: 400 });
  const warning = restrictionFor(uni, program_type);
  if (warning && !force) throw Object.assign(new Error(warning), { status: 409, code: "restricted" });

  return db.tx(async (c) => {
    const app = (await c.query(
      `INSERT INTO applications (student_id, university_id, program, program_type, deadline)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [studentId, university_id, program || null, program_type, deadline || null]
    )).rows[0];

    let tpl = (await c.query(
      "SELECT doc_key, label, sort FROM document_templates WHERE university_id = $1 AND program_type = $2 ORDER BY sort",
      [university_id, program_type]
    )).rows;
    if (!tpl.length) {
      tpl = (await c.query(
        "SELECT doc_key, label, sort FROM document_templates WHERE university_id IS NULL AND program_type = $1 ORDER BY sort",
        [program_type]
      )).rows;
    }
    for (const t of tpl) {
      await c.query(
        "INSERT INTO documents (student_id, application_id, doc_key, label, due_date, sort) VALUES ($1,$2,$3,$4,$5,$6)",
        [studentId, app.id, t.doc_key, t.label, deadline || null, t.sort]
      );
    }
    await addEvent(studentId, actorId, "application", `Application started: ${uni.name}${program ? " — " + program : ""}`, true, c);
    return { application: app, warning };
  });
}

async function addVisaChecklist(studentId) {
  const has = await db.one("SELECT 1 FROM documents WHERE student_id = $1 AND application_id IS NULL AND doc_key = 'visa_form'", [studentId]);
  if (has) return;
  const tpl = await db.many("SELECT doc_key, label, sort FROM document_templates WHERE university_id IS NULL AND program_type = 'visa' ORDER BY sort");
  for (const t of tpl) {
    await db.query(
      "INSERT INTO documents (student_id, application_id, doc_key, label, sort) VALUES ($1,NULL,$2,$3,$4)",
      [studentId, t.doc_key, t.label, 100 + t.sort]
    );
  }
}

// What a parent (or the student) sees. No internal notes, no staff-only events.
async function progressView(studentId) {
  const s = await db.one(
    `SELECT s.id, s.full_name, s.stage, s.closed, s.target_intake, s.program_type, s.package,
            a.name AS agent_name, a.phone AS agent_phone
       FROM students s LEFT JOIN users a ON a.id = s.agent_id WHERE s.id = $1`,
    [studentId]
  );
  if (!s) return null;
  const applications = await db.many(
    `SELECT ap.id, ap.program, ap.program_type, ap.status, ap.deadline, u.name AS university, u.city,
            u.ieqas_status, u.restricted_programs, u.restricted_until
       FROM applications ap JOIN universities u ON u.id = ap.university_id
      WHERE ap.student_id = $1 ORDER BY ap.created_at`,
    [studentId]
  );
  const documents = await db.many(
    `SELECT d.id, d.application_id, d.label, d.status, d.due_date
       FROM documents d WHERE d.student_id = $1 ORDER BY d.application_id NULLS LAST, d.sort, d.id`,
    [studentId]
  );
  const events = await db.many(
    "SELECT kind, message, created_at FROM events WHERE student_id = $1 AND public ORDER BY created_at DESC LIMIT 30",
    [studentId]
  );
  const invoices = await db.many(
    "SELECT id, description, amount_uzs, status, provider, paid_at, created_at FROM invoices WHERE student_id = $1 AND status <> 'cancelled' ORDER BY created_at",
    [studentId]
  );
  return {
    student: {
      first_name: s.full_name.split(" ")[0],
      full_name: s.full_name,
      stage: s.stage,
      stage_index: STAGES.indexOf(s.stage),
      closed: s.closed,
      target_intake: s.target_intake,
      program_type: s.program_type,
      package: s.package,
    },
    agent: s.agent_name ? { name: s.agent_name, phone: s.agent_phone } : null,
    stages: STAGES.map((k) => ({ key: k, uz: STAGE_LABELS.uz[k], ru: STAGE_LABELS.ru[k], en: STAGE_LABELS.en[k] })),
    applications: applications.map((a) => ({ ...a, restriction: restrictionFor({ ...a, name: a.university }, a.program_type) })),
    documents,
    events,
    invoices,
  };
}

module.exports = { addEvent, recipients, setStage, createApplication, addVisaChecklist, progressView };
