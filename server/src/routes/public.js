// Routes for students, parents (via their private link) and the public lead form.
const express = require("express");
const db = require("../db");
const auth = require("../lib/auth");
const svc = require("../lib/students");
const telegram = require("../lib/telegram");
const rateLimit = require("../lib/rate-limit");
const { payUrl, enabledProviders } = require("./payments");

const router = express.Router();

function baseUrl(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
}

function withPayLinks(view, returnUrl) {
  const providers = enabledProviders();
  view.payments = providers;
  view.invoices = view.invoices.map((inv) => ({
    ...inv,
    pay: inv.status === "pending"
      ? { payme: providers.payme ? payUrl("payme", inv, returnUrl) : null, click: providers.click ? payUrl("click", inv, returnUrl) : null }
      : null,
  }));
  return view;
}

/* ---------- Parent view (no account; a private link per student) ---------- */

const parentLimit = rateLimit({ windowMs: 60 * 1000, max: 60 });

router.get("/parent/:token", parentLimit, async (req, res) => {
  const token = String(req.params.token || "");
  const s = token.length >= 20 && (await db.one("SELECT id FROM students WHERE parent_token = $1", [token]));
  if (!s) return res.status(404).json({ error: "This link is not valid. Ask WeHelp for a new one." });
  const view = await svc.progressView(s.id);
  view.telegram = telegram.deepLink(`p_${token}`);
  res.json(withPayLinks(view, `${baseUrl(req)}/parent.html#${token}`));
});

/* ---------- Student portal ---------- */

const student = auth.requireRole("student");

async function myStudent(req) {
  return db.one("SELECT * FROM students WHERE user_id = $1", [req.user.id]);
}

router.get("/me/progress", student, async (req, res) => {
  const s = await myStudent(req);
  if (!s) return res.status(404).json({ error: "No student card linked to this account" });
  res.json(withPayLinks(await svc.progressView(s.id), `${baseUrl(req)}/#dashboard`));
});

// The student site keeps its profile, shortlist and app drafts as one JSON blob.
router.get("/me/state", student, async (req, res) => {
  const s = await myStudent(req);
  res.json({ state: s?.portal_state || null });
});

router.put("/me/state", student, express.json({ limit: "256kb" }), async (req, res) => {
  const s = await myStudent(req);
  if (!s) return res.status(404).json({ error: "No student card linked to this account" });
  const st = req.body?.state;
  if (!st || typeof st !== "object") return res.status(400).json({ error: "state must be an object" });
  const clean = {
    profile: st.profile && typeof st.profile === "object" ? st.profile : {},
    shortlist: Array.isArray(st.shortlist) ? st.shortlist.slice(0, 50).map(String) : [],
    apps: Array.isArray(st.apps) ? st.apps.slice(0, 50) : [],
    saved_at: new Date().toISOString(),
  };
  await db.query("UPDATE students SET portal_state = $1 WHERE id = $2", [clean, s.id]);
  res.json({ ok: true, saved_at: clean.saved_at });
});

/* ---------- Public lead form ("Get help applying") ---------- */

const leadLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });

router.post("/leads", leadLimit, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.status(201).json({ ok: true }); // honeypot field
  const name = String(b.name || "").trim().slice(0, 120);
  const phone = String(b.phone || "").trim().slice(0, 40);
  if (!name || phone.replace(/\D/g, "").length < 7) return res.status(400).json({ error: "Name and phone number are required" });
  const programType = b.program_type === "language" ? "language" : "degree";
  const s = await db.one(
    `INSERT INTO students (full_name, phone, email, city, parent_phone, program_type, target_intake, source, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'website',$8) RETURNING id`,
    [name, phone, b.email || null, b.city || null, b.parent_phone || null, programType, b.target_intake || null, String(b.message || "").slice(0, 2000) || null]
  );
  await svc.addEvent(s.id, null, "created", "Request from the website", false);
  const admins = await db.many("SELECT telegram_chat_id FROM users WHERE role = 'admin' AND telegram_chat_id IS NOT NULL");
  for (const a of admins) {
    await telegram.sendMessage(a.telegram_chat_id, `🆕 New lead: ${telegram.escapeHtml(name)}, ${telegram.escapeHtml(phone)} (${programType})`);
  }
  res.status(201).json({ ok: true });
});

/* ---------- Telegram bot webhook ---------- */

router.post("/telegram/webhook/:secret", async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.params.secret !== secret) return res.status(404).end();
  const msg = req.body?.message;
  const text = String(msg?.text || "");
  const chatId = msg?.chat?.id;
  res.json({ ok: true }); // answer Telegram fast; work continues below
  if (!chatId || !text.startsWith("/start")) return;

  const payload = text.split(/\s+/)[1] || "";
  if (payload.startsWith("u_")) {
    const u = await db.one(
      "UPDATE users SET telegram_chat_id = $1, telegram_link_code = NULL WHERE telegram_link_code = $2 RETURNING name",
      [chatId, payload.slice(2)]
    );
    await telegram.sendMessage(chatId, u
      ? `✅ ${telegram.escapeHtml(u.name)}, WeHelp reminders are on. / Eslatmalar yoqildi. / Напоминания включены.`
      : "This link has expired. Open WeHelp and press “Connect Telegram” again.");
  } else if (payload.startsWith("p_")) {
    const s = await db.one("SELECT id, full_name FROM students WHERE parent_token = $1", [payload.slice(2)]);
    if (s) {
      await db.query("INSERT INTO parent_chats (student_id, chat_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [s.id, chatId]);
      const first = telegram.escapeHtml(s.full_name.split(" ")[0]);
      await telegram.sendMessage(chatId,
        `✅ ${first}: WeHelp yangiliklari shu yerga keladi.\n✅ ${first}: новости WeHelp будут приходить сюда.\n✅ You'll get ${first}'s WeHelp updates here.`);
    } else {
      await telegram.sendMessage(chatId, "This link is not valid. Ask WeHelp for a new one.");
    }
  } else {
    await telegram.sendMessage(chatId, "WeHelp: open your WeHelp page and press “Connect Telegram” to get reminders here.");
  }
});

module.exports = { router };
