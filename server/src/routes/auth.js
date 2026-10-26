const express = require("express");
const db = require("../db");
const auth = require("../lib/auth");
const rateLimit = require("../lib/rate-limit");

const router = express.Router();

const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: (req) => `${req.ip}|${String(req.body?.email || "").toLowerCase()}` });

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role, telegram_linked: !!u.telegram_chat_id };
}

router.post("/login", loginLimit, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const user = await db.one("SELECT * FROM users WHERE email = $1", [email]);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Wrong email or password" });
  }
  const token = await auth.createSession(user.id);
  auth.setSessionCookie(res, token);
  res.json({ user: publicUser(user), token });
});

router.post("/logout", async (req, res) => {
  await auth.destroySession(auth.sessionToken(req));
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/me", async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const student = req.user.role === "student"
    ? await db.one("SELECT id, full_name, stage FROM students WHERE user_id = $1", [req.user.id])
    : null;
  res.json({ user: publicUser(req.user), student });
});

// A student creates their account with the invite code the agency gave them,
// which ties the login to their existing card on the board.
router.post("/register", loginLimit, async (req, res) => {
  const code = String(req.body?.invite_code || "").trim().toUpperCase();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!code) return res.status(400).json({ error: "Invite code is required" });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const result = await db.tx(async (c) => {
    const student = (await c.query("SELECT * FROM students WHERE invite_code = $1 AND user_id IS NULL FOR UPDATE", [code])).rows[0];
    if (!student) return { error: "This invite code is not valid or was already used" };
    const exists = (await c.query("SELECT 1 FROM users WHERE email = $1", [email])).rows[0];
    if (exists) return { error: "An account with this email already exists" };
    const name = String(req.body?.name || student.full_name).trim() || student.full_name;
    const user = (await c.query(
      "INSERT INTO users (email, password_hash, name, phone, role) VALUES ($1,$2,$3,$4,'student') RETURNING *",
      [email, auth.hashPassword(password), name, student.phone]
    )).rows[0];
    await c.query("UPDATE students SET user_id = $1, invite_code = NULL, email = COALESCE(email, $2), updated_at = now() WHERE id = $3", [user.id, email, student.id]);
    await c.query("INSERT INTO events (student_id, actor_id, kind, message, public) VALUES ($1,$2,'account','Student created their WeHelp account',false)", [student.id, user.id]);
    return { user };
  });
  if (result.error) return res.status(400).json({ error: result.error });

  const token = await auth.createSession(result.user.id);
  auth.setSessionCookie(res, token);
  res.status(201).json({ user: publicUser(result.user), token });
});

router.post("/password", auth.requireRole(), async (req, res) => {
  const current = String(req.body?.current || "");
  const next = String(req.body?.next || "");
  if (next.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
  const user = await db.one("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  if (!auth.verifyPassword(current, user.password_hash)) return res.status(400).json({ error: "Current password is wrong" });
  await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [auth.hashPassword(next), req.user.id]);
  await db.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [req.user.id, auth.sha256(auth.sessionToken(req))]);
  res.json({ ok: true });
});

// Telegram linking for any signed-in user: returns a t.me deep link.
router.post("/telegram-link", auth.requireRole(), async (req, res) => {
  const code = auth.shortCode(10);
  await db.query("UPDATE users SET telegram_link_code = $1 WHERE id = $2", [code, req.user.id]);
  const { deepLink } = require("../lib/telegram");
  res.json({ code, link: deepLink(`u_${code}`) });
});

module.exports = { router, publicUser };
