// End-to-end API tests against a real Postgres. Point TEST_DATABASE_URL at a
// throwaway database: the public schema is dropped and rebuilt on every run.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://postgres@localhost/wehelp_test";
process.env.PAYME_KEY = "test-payme-key";
process.env.PAYME_MERCHANT_ID = "merchant123";
process.env.CLICK_SECRET_KEY = "click-secret";
process.env.CLICK_SERVICE_ID = "777";
process.env.CLICK_MERCHANT_ID = "888";
process.env.TELEGRAM_WEBHOOK_SECRET = "hook";
process.env.TELEGRAM_BOT_USERNAME = "wehelp_test_bot";
delete process.env.TELEGRAM_BOT_TOKEN;

const db = require("../src/db");
const auth = require("../src/lib/auth");
const telegram = require("../src/lib/telegram");
const { createApp } = require("../src/app");
const { runReminders } = require("../src/lib/reminders");
const { clickSign } = require("../src/routes/payments");

let server;
let base;

async function call(method, path, { body, token, headers = {}, form } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    h["content-type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const r = await fetch(base + path, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}

const payme = (method, params, key = "test-payme-key") =>
  call("POST", "/api/payments/payme", {
    body: { jsonrpc: "2.0", id: 1, method, params },
    headers: { authorization: "Basic " + Buffer.from(`Paycom:${key}`).toString("base64") },
  });

let admin;
let agentToken;

test.before(async () => {
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await db.migrate();
  await db.query("INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,'Admin','admin')", ["admin@x.uz", auth.hashPassword("adminpass1")]);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await db.close();
});

test("login, me, wrong password", async () => {
  const bad = await call("POST", "/api/auth/login", { body: { email: "admin@x.uz", password: "nope" } });
  assert.equal(bad.status, 401);
  const ok = await call("POST", "/api/auth/login", { body: { email: "ADMIN@x.uz", password: "adminpass1" } });
  assert.equal(ok.status, 200);
  admin = ok.body.token;
  const me = await call("GET", "/api/auth/me", { token: admin });
  assert.equal(me.body.user.role, "admin");
});

test("board needs staff; non-JSON writes are refused", async () => {
  assert.equal((await call("GET", "/api/board/students")).status, 401);
  const r = await fetch(base + "/api/board/students", { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/x-www-form-urlencoded" }, body: "full_name=x" });
  assert.equal(r.status, 415);
});

test("admin adds an agent who can sign in", async () => {
  const r = await call("POST", "/api/board/staff", { token: admin, body: { email: "agent@x.uz", password: "agentpass1", name: "Friend" } });
  assert.equal(r.status, 201);
  const login = await call("POST", "/api/auth/login", { body: { email: "agent@x.uz", password: "agentpass1" } });
  agentToken = login.body.token;
  assert.equal(login.body.user.role, "agent");
  // agents cannot add staff
  assert.equal((await call("POST", "/api/board/staff", { token: agentToken, body: { email: "z@x.uz", password: "zzzzzzzz" } })).status, 403);
});

test("universities: catalog, IEQAS flags and restricted lookup", async () => {
  const r = await call("GET", "/api/universities");
  assert.equal(r.body.universities.length, 20);
  assert.ok(r.body.universities.every((u) => u.in_catalog && u.ieqas_status === "unverified"));
  const all = await call("GET", "/api/universities?all=1");
  assert.equal(all.body.universities.filter((u) => u.ieqas_status === "restricted").length, 20);
  const chk = await call("GET", "/api/universities/check?name=sangji");
  assert.equal(chk.body.matches[0].name, "Sangji University");
  assert.equal(chk.body.matches[0].restricted_language, true);
  assert.equal(chk.body.matches[0].restricted_degree, false);

  const upd = await call("PATCH", "/api/universities/kaist", { token: agentToken, body: { ieqas_status: "excellent" } });
  assert.equal(upd.body.university.ieqas_status, "excellent");
  assert.ok(upd.body.university.ieqas_checked_at);
});

let studentId;

test("full pipeline: lead → application with checklist → stage changes", async () => {
  const c = await call("POST", "/api/board/students", { token: agentToken, body: { full_name: "Dilnoza Karimova", phone: "+998901112233", program_type: "degree", target_intake: "2027-03" } });
  assert.equal(c.status, 201);
  studentId = c.body.student.id;
  assert.equal(c.body.student.stage, "lead");

  const app = await call("POST", `/api/board/students/${studentId}/applications`, { token: agentToken, body: { university_id: "kaist", program: "Computer Science", deadline: "2026-11-30" } });
  assert.equal(app.status, 201);

  const detail = await call("GET", `/api/board/students/${studentId}`, { token: agentToken });
  assert.equal(detail.body.student.stage, "documents", "first application moves a lead to documents");
  assert.equal(detail.body.documents.length, 11);
  assert.ok(detail.body.documents.every((d) => d.due_date === "2026-11-30"));

  // duplicate application is refused
  const dup = await call("POST", `/api/board/students/${studentId}/applications`, { token: agentToken, body: { university_id: "kaist" } });
  assert.equal(dup.status, 409);

  // board listing has counts
  const list = await call("GET", "/api/board/students", { token: agentToken });
  const card = list.body.students.find((s) => s.id === studentId);
  assert.equal(card.docs_total, 11);
  assert.equal(card.docs_done, 0);
  assert.equal(card.next_due, "2026-11-30");
  assert.equal(card.restricted_warning, false);
});

test("restricted university is blocked unless forced, then flagged on the card", async () => {
  const blocked = await call("POST", `/api/board/students/${studentId}/applications`, { token: agentToken, body: { university_id: "geumgang-university", program_type: "degree" } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "restricted");
  // Sangji is only restricted for language programs, so a degree application is fine.
  const ok = await call("POST", `/api/board/students/${studentId}/applications`, { token: agentToken, body: { university_id: "sangji-university", program_type: "degree" } });
  assert.equal(ok.status, 201);
  const forced = await call("POST", `/api/board/students/${studentId}/applications`, { token: agentToken, body: { university_id: "geumgang-university", program_type: "degree", force: true } });
  assert.equal(forced.status, 201);
  assert.match(forced.body.warning, /visa-restriction/);
  const list = await call("GET", "/api/board/students", { token: agentToken });
  assert.equal(list.body.students.find((s) => s.id === studentId).restricted_warning, true);
  await call("DELETE", `/api/board/applications/${forced.body.application.id}`, { token: agentToken });
});

test("per-university checklist overrides the default", async () => {
  const put = await call("PUT", "/api/universities/yonsei-university/documents", { token: agentToken, body: { program_type: "degree", documents: [{ label: "Passport copy" }, { label: "Portfolio" }] } });
  assert.equal(put.body.documents.length, 2);
  const app = await call("POST", `/api/board/students/${studentId}/applications`, { token: agentToken, body: { university_id: "yonsei-university" } });
  const detail = await call("GET", `/api/board/students/${studentId}`, { token: agentToken });
  const docs = detail.body.documents.filter((d) => d.application_id === app.body.application.id);
  assert.deepEqual(docs.map((d) => d.label), ["Passport copy", "Portfolio"]);
});

let parentToken;

test("parent link: progress view, Telegram linking, stage notifications", async () => {
  const link = await call("POST", `/api/board/students/${studentId}/parent-link`, { token: agentToken, body: {} });
  parentToken = link.body.token;
  assert.match(link.body.telegram, /^https:\/\/t\.me\/wehelp_test_bot\?start=p_/);

  const view = await call("GET", `/api/parent/${parentToken}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.student.first_name, "Dilnoza");
  assert.equal(view.body.student.stage, "documents");
  assert.equal(view.body.stages.length, 6);
  assert.ok(view.body.events.length > 0);

  // Note events stay private.
  await call("POST", `/api/board/students/${studentId}/notes`, { token: agentToken, body: { text: "Family prefers Daejeon" } });
  const v2 = await call("GET", `/api/parent/${parentToken}`);
  assert.ok(!v2.body.events.some((e) => e.message.includes("Daejeon")));

  // Parent presses Start in the bot.
  await call("POST", "/api/telegram/webhook/hook", { body: { message: { chat: { id: 5551 }, text: `/start p_${parentToken}` } } });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(telegram.sent.some((m) => m.chatId === 5551 && m.text.includes("Dilnoza")));

  telegram.sent.length = 0;
  await call("PATCH", `/api/board/students/${studentId}`, { token: agentToken, body: { stage: "applied" } });
  const notice = telegram.sent.find((m) => m.chatId === 5551);
  assert.ok(notice, "parent is told about the stage change");
  assert.match(notice.text, /Ariza topshirildi/);

  assert.equal((await call("GET", "/api/parent/not-a-real-token-at-all-xx")).status, 404);
  assert.equal((await call("POST", "/api/telegram/webhook/wrong", { body: {} })).status, 404);
});

test("visa stage adds the visa checklist once", async () => {
  await call("PATCH", `/api/board/students/${studentId}`, { token: agentToken, body: { stage: "admitted" } });
  await call("PATCH", `/api/board/students/${studentId}`, { token: agentToken, body: { stage: "visa" } });
  await call("POST", `/api/board/students/${studentId}/visa-checklist`, { token: agentToken, body: {} });
  const d = await call("GET", `/api/board/students/${studentId}`, { token: agentToken });
  assert.equal(d.body.documents.filter((x) => x.application_id === null).length, 5);
});

test("student invite, register, portal state sync", async () => {
  const inv = await call("POST", `/api/board/students/${studentId}/invite`, { token: agentToken, body: {} });
  const code = inv.body.invite_code;
  const reg = await call("POST", "/api/auth/register", { body: { invite_code: code.toLowerCase(), email: "dilnoza@x.uz", password: "student123" } });
  assert.equal(reg.status, 201);
  const st = reg.body.token;
  const again = await call("POST", "/api/auth/register", { body: { invite_code: code, email: "other@x.uz", password: "student123" } });
  assert.equal(again.status, 400);

  const put = await call("PUT", "/api/me/state", { token: st, body: { state: { profile: { firstName: "Dilnoza", gpa: "3.9", ielts: "6.5" }, shortlist: ["kaist"], apps: [] } } });
  assert.equal(put.status, 200);
  const get = await call("GET", "/api/me/state", { token: st });
  assert.equal(get.body.state.profile.gpa, "3.9");
  const prog = await call("GET", "/api/me/progress", { token: st });
  assert.equal(prog.body.student.stage, "visa");

  const card = await call("GET", `/api/board/students/${studentId}`, { token: agentToken });
  assert.equal(card.body.portal.profile.ielts, "6.5");
  assert.equal(card.body.student.portal_state, undefined);

  // students cannot read the board
  assert.equal((await call("GET", "/api/board/students", { token: st })).status, 403);

  // Telegram link for the student
  const tl = await call("POST", "/api/auth/telegram-link", { token: st, body: {} });
  await call("POST", "/api/telegram/webhook/hook", { body: { message: { chat: { id: 7001 }, text: `/start u_${tl.body.code}` } } });
  await new Promise((r) => setTimeout(r, 100));
  const u = await db.one("SELECT telegram_chat_id FROM users WHERE email = 'dilnoza@x.uz'");
  assert.equal(u.telegram_chat_id, 7001);
});

test("Payme: check, create, perform, idempotency, refund", async () => {
  const inv = (await call("POST", `/api/board/students/${studentId}/invoices`, { token: agentToken, body: { description: "Application package", amount_uzs: 1500000 } })).body.invoice;

  assert.equal((await payme("CheckPerformTransaction", { amount: 1, account: { invoice_id: inv.id } }, "wrong")).body.error.code, -32504);
  assert.equal((await payme("CheckPerformTransaction", { amount: 100, account: { invoice_id: inv.id } })).body.error.code, -31001);
  assert.equal((await payme("CheckPerformTransaction", { amount: 150000000, account: { invoice_id: 99999 } })).body.error.code, -31050);
  assert.equal((await payme("CheckPerformTransaction", { amount: 150000000, account: { invoice_id: inv.id } })).body.result.allow, true);
  assert.equal((await payme("Nope", {})).body.error.code, -32601);

  const create = await payme("CreateTransaction", { id: "pm-1", time: Date.now(), amount: 150000000, account: { invoice_id: inv.id } });
  assert.equal(create.body.result.state, 1);
  const again = await payme("CreateTransaction", { id: "pm-1", time: Date.now(), amount: 150000000, account: { invoice_id: inv.id } });
  assert.equal(again.body.result.transaction, create.body.result.transaction);
  const other = await payme("CreateTransaction", { id: "pm-2", time: Date.now(), amount: 150000000, account: { invoice_id: inv.id } });
  assert.equal(other.body.error.code, -31052);

  // invoice cannot be cancelled by staff while Payme holds it
  assert.equal((await call("PATCH", `/api/board/invoices/${inv.id}`, { token: agentToken, body: { status: "cancelled" } })).status, 409);

  const perf = await payme("PerformTransaction", { id: "pm-1" });
  assert.equal(perf.body.result.state, 2);
  const perf2 = await payme("PerformTransaction", { id: "pm-1" });
  assert.equal(perf2.body.result.perform_time, perf.body.result.perform_time);
  assert.equal((await db.one("SELECT status, provider FROM invoices WHERE id = $1", [inv.id])).status, "paid");

  const chk = await payme("CheckTransaction", { id: "pm-1" });
  assert.equal(chk.body.result.state, 2);
  const stmt = await payme("GetStatement", { from: 0, to: Date.now() + 1000 });
  assert.equal(stmt.body.result.transactions.length, 1);

  const cancel = await payme("CancelTransaction", { id: "pm-1", reason: 5 });
  assert.equal(cancel.body.result.state, -2);
  assert.equal((await db.one("SELECT status FROM invoices WHERE id = $1", [inv.id])).status, "refunded");
  assert.equal((await payme("PerformTransaction", { id: "nope" })).body.error.code, -31003);
});

test("Payme pay link encodes merchant, invoice and tiyin amount", async () => {
  await call("POST", `/api/board/students/${studentId}/invoices`, { token: agentToken, body: { description: "Visa help", amount_uzs: 500000 } });
  const view = await call("GET", `/api/parent/${parentToken}`);
  const pending = view.body.invoices.find((i) => i.status === "pending");
  const decoded = Buffer.from(pending.pay.payme.split("/").pop(), "base64").toString();
  assert.match(decoded, new RegExp(`^m=merchant123;ac.invoice_id=${pending.id};a=50000000;c=`));
  assert.match(pending.pay.click, /service_id=777.*merchant_id=888.*amount=500000.*transaction_param=/);
});

test("Click: prepare and complete with signatures", async () => {
  const inv = (await call("POST", `/api/board/students/${studentId}/invoices`, { token: agentToken, body: { description: "Housing help", amount_uzs: 300000 } })).body.invoice;
  const base = { click_trans_id: "9001", service_id: "777", click_paydoc_id: "1", merchant_trans_id: String(inv.id), amount: "300000.00", error: "0", error_note: "Success", sign_time: "2026-10-26 10:00:00" };

  const badSig = await call("POST", "/api/payments/click/prepare", { form: { ...base, action: "0", sign_string: "abc" } });
  assert.equal(badSig.body.error, -1);

  const prepForm = { ...base, action: "0" };
  prepForm.sign_string = clickSign(prepForm, false);
  const prep = await call("POST", "/api/payments/click/prepare", { form: prepForm });
  assert.equal(prep.body.error, 0);
  const prepareId = prep.body.merchant_prepare_id;

  const wrongAmount = { ...base, amount: "1.00", action: "0" };
  wrongAmount.sign_string = clickSign(wrongAmount, false);
  assert.equal((await call("POST", "/api/payments/click/prepare", { form: wrongAmount })).body.error, -2);

  const compForm = { ...base, action: "1", merchant_prepare_id: String(prepareId) };
  compForm.sign_string = clickSign(compForm, true);
  const comp = await call("POST", "/api/payments/click/complete", { form: compForm });
  assert.equal(comp.body.error, 0);
  assert.equal(comp.body.merchant_confirm_id, prepareId);
  assert.equal((await db.one("SELECT status, provider FROM invoices WHERE id = $1", [inv.id])).provider, "click");
  assert.equal((await call("POST", "/api/payments/click/complete", { form: compForm })).body.error, -4);
});

test("Click: failed payment from Click cancels the transaction", async () => {
  const inv = (await call("POST", `/api/board/students/${studentId}/invoices`, { token: agentToken, body: { description: "Extra", amount_uzs: 100000 } })).body.invoice;
  const base = { click_trans_id: "9002", service_id: "777", merchant_trans_id: String(inv.id), amount: "100000", sign_time: "t" };
  const prep = { ...base, action: "0", error: "0" };
  prep.sign_string = clickSign(prep, false);
  const id = (await call("POST", "/api/payments/click/prepare", { form: prep })).body.merchant_prepare_id;
  const comp = { ...base, action: "1", error: "-5017", merchant_prepare_id: String(id) };
  comp.sign_string = clickSign(comp, true);
  assert.equal((await call("POST", "/api/payments/click/complete", { form: comp })).body.error, -9);
  assert.equal((await db.one("SELECT status FROM invoices WHERE id = $1", [inv.id])).status, "pending");
});

test("manual invoice rules", async () => {
  const inv = (await call("POST", `/api/board/students/${studentId}/invoices`, { token: agentToken, body: { description: "Cash", amount_uzs: 200000 } })).body.invoice;
  assert.equal((await call("PATCH", `/api/board/invoices/${inv.id}`, { token: agentToken, body: { status: "paid", provider: "payme" } })).status, 400);
  assert.equal((await call("PATCH", `/api/board/invoices/${inv.id}`, { token: agentToken, body: { status: "paid", provider: "cash" } })).status, 200);
  assert.equal((await call("PATCH", `/api/board/invoices/${inv.id}`, { token: agentToken, body: { status: "cancelled" } })).status, 409);
  assert.equal((await call("POST", `/api/board/students/${studentId}/invoices`, { token: agentToken, body: { description: "x", amount_uzs: 10.5 } })).status, 400);
  const sum = await call("GET", "/api/board/summary", { token: agentToken });
  assert.equal(sum.body.paid_uzs, 300000 + 200000);
});

test("Telegram reminders: grouped per student, once per bucket", async () => {
  const s = (await call("POST", "/api/board/students", { token: agentToken, body: { full_name: "Bekzod Aliyev" } })).body.student;
  const app = (await call("POST", `/api/board/students/${s.id}/applications`, { token: agentToken, body: { university_id: "hanyang-university", deadline: "2026-12-05" } })).body.application;
  const link = await call("POST", `/api/board/students/${s.id}/parent-link`, { token: agentToken, body: {} });
  await call("POST", "/api/telegram/webhook/hook", { body: { message: { chat: { id: 8001 }, text: `/start p_${link.body.token}` } } });
  await new Promise((r) => setTimeout(r, 100));
  // The agent links Telegram too.
  const tl = await call("POST", "/api/auth/telegram-link", { token: agentToken, body: {} });
  await call("POST", "/api/telegram/webhook/hook", { body: { message: { chat: { id: 9001 }, text: `/start u_${tl.body.code}` } } });
  await new Promise((r) => setTimeout(r, 100));

  // Mark one document done so it is not reminded.
  const docs = (await call("GET", `/api/board/students/${s.id}`, { token: agentToken })).body.documents;
  await call("PATCH", `/api/board/documents/${docs[0].id}`, { token: agentToken, body: { status: "received" } });

  telegram.sent.length = 0;
  const r1 = await runReminders(new Date("2026-12-02T06:00:00Z"));
  assert.ok(r1.students >= 1);
  const parentMsg = telegram.sent.filter((m) => m.chatId === 8001);
  assert.equal(parentMsg.length, 1, "one grouped message per person");
  assert.equal((parentMsg[0].text.match(/•/g) || []).length, docs.length - 1 + 1, "missing docs plus the draft application deadline");
  assert.match(parentMsg[0].text, /3 kun qoldi/);
  assert.ok(telegram.sent.some((m) => m.chatId === 9001 && m.text.includes("Bekzod")));

  telegram.sent.length = 0;
  await runReminders(new Date("2026-12-02T12:00:00Z"));
  assert.equal(telegram.sent.filter((m) => m.chatId === 8001).length, 0, "same day, same bucket: no repeat");

  await runReminders(new Date("2026-12-04T06:00:00Z"));
  assert.equal(telegram.sent.filter((m) => m.chatId === 8001).length, 1, "1-day bucket fires again");
  // Draft application deadline is included too.
  assert.ok(telegram.sent.some((m) => m.text.includes("Application deadline: Hanyang")));
  assert.ok(app.id);
});

test("public lead form creates a website lead", async () => {
  const r = await call("POST", "/api/leads", { body: { name: "Sardor", phone: "+998 90 123 45 67", program_type: "language", message: "March intake" } });
  assert.equal(r.status, 201);
  const row = await db.one("SELECT * FROM students WHERE full_name = 'Sardor'");
  assert.equal(row.source, "website");
  assert.equal(row.program_type, "language");
  assert.equal((await call("POST", "/api/leads", { body: { name: "x", phone: "1" } })).status, 400);
});

test("pages are served", async () => {
  for (const p of ["/", "/agency", "/parent.html"]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await call("GET", "/api/nope")).status, 404);
  assert.ok(crypto);
});
