// Telegram deadline reminders for missing documents and application deadlines.
// Safe to run as often as you like: each item is reminded once per lead-time bucket.
const db = require("../db");
const telegram = require("./telegram");
const svc = require("./students");

const BUCKETS = [14, 7, 3, 1, 0]; // days before the deadline; 0 = due today
const OVERDUE = -1;

function bucketFor(daysLeft) {
  if (daysLeft < 0) return OVERDUE;
  let b = null;
  for (const x of BUCKETS) if (daysLeft <= x) b = x;
  return b;
}

function whenText(daysLeft) {
  if (daysLeft < 0) return { uz: "muddati o'tdi", ru: "срок прошёл", en: "overdue" };
  if (daysLeft === 0) return { uz: "bugun", ru: "сегодня", en: "today" };
  return { uz: `${daysLeft} kun qoldi`, ru: `осталось ${daysLeft} дн.`, en: `${daysLeft} days left` };
}

async function claim(kind, id, bucket) {
  const r = await db.query(
    "INSERT INTO reminders_sent (item_kind, item_id, bucket) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [kind, id, bucket]
  );
  return r.rowCount === 1;
}

async function runReminders(today = new Date()) {
  const day = today.toISOString().slice(0, 10);
  const docs = await db.many(
    `SELECT d.id, d.label, d.student_id, d.due_date, (d.due_date - $1::date) AS days_left, s.full_name, u.name AS university
       FROM documents d JOIN students s ON s.id = d.student_id
       LEFT JOIN applications ap ON ap.id = d.application_id
       LEFT JOIN universities u ON u.id = ap.university_id
      WHERE d.status = 'missing' AND NOT s.closed AND d.due_date IS NOT NULL
        AND d.due_date <= $1::date + 14 AND d.due_date >= $1::date - 7`,
    [day]
  );
  const apps = await db.many(
    `SELECT ap.id, ap.student_id, ap.deadline, (ap.deadline - $1::date) AS days_left, s.full_name, u.name AS university
       FROM applications ap JOIN students s ON s.id = ap.student_id JOIN universities u ON u.id = ap.university_id
      WHERE ap.status = 'draft' AND NOT s.closed AND ap.deadline IS NOT NULL
        AND ap.deadline <= $1::date + 14 AND ap.deadline >= $1::date - 7`,
    [day]
  );

  // Group per student so each person gets one message, not one per document.
  const byStudent = new Map();
  for (const d of docs) {
    const b = bucketFor(d.days_left);
    if (b === null || !(await claim("document", d.id, b))) continue;
    if (!byStudent.has(d.student_id)) byStudent.set(d.student_id, { name: d.full_name, lines: [] });
    byStudent.get(d.student_id).lines.push({ text: d.label + (d.university ? ` (${d.university})` : ""), days: d.days_left });
  }
  for (const a of apps) {
    const b = bucketFor(a.days_left);
    if (b === null || !(await claim("application", a.id, b))) continue;
    if (!byStudent.has(a.student_id)) byStudent.set(a.student_id, { name: a.full_name, lines: [] });
    byStudent.get(a.student_id).lines.push({ text: `Application deadline: ${a.university}`, days: a.days_left });
  }

  let messages = 0;
  for (const [studentId, info] of byStudent) {
    const to = await svc.recipients(studentId);
    const body = info.lines
      .sort((x, y) => x.days - y.days)
      .map((l) => {
        const w = whenText(l.days);
        return `• ${telegram.escapeHtml(l.text)} — ${w.uz} / ${w.ru}`;
      })
      .join("\n");
    const first = telegram.escapeHtml(info.name.split(" ")[0]);
    const familyMsg = `⏰ <b>WeHelp</b> · ${first}\nHujjatlar muddati / Сроки документов:\n${body}`;
    for (const chat of [to.student, ...to.parents]) {
      if (!chat) continue;
      await telegram.sendMessage(chat, familyMsg);
      messages++;
    }
    if (to.agent) {
      await telegram.sendMessage(to.agent, `⏰ ${telegram.escapeHtml(info.name)} (#${studentId}):\n${body}`);
      messages++;
    }
  }
  return { students: byStudent.size, messages };
}

module.exports = { runReminders, bucketFor };
