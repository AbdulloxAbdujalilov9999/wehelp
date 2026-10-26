const crypto = require("crypto");
const db = require("../db");

const SESSION_DAYS = 30;
const COOKIE = "wh_session";

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split("$");
  if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, expected);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

// Short, readable code for invites and Telegram linking (no 0/O/1/I).
function shortCode(len = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function createSession(userId) {
  const token = randomToken();
  await db.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + make_interval(days => $3))",
    [sha256(token), userId, SESSION_DAYS]
  );
  return token;
}

async function destroySession(token) {
  if (token) await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function sessionToken(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return readCookie(req, COOKIE);
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Attaches req.user when a valid session is present. Never rejects.
async function loadUser(req, _res, next) {
  try {
    const token = sessionToken(req);
    if (token) {
      req.user = await db.one(
        `SELECT u.id, u.email, u.name, u.phone, u.role, u.telegram_chat_id
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [sha256(token)]
      );
    }
    next();
  } catch (e) {
    next(e);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Sign in first" });
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: "Not allowed" });
    next();
  };
}

const requireStaff = requireRole("admin", "agent");

module.exports = {
  hashPassword,
  verifyPassword,
  randomToken,
  shortCode,
  sha256,
  createSession,
  destroySession,
  sessionToken,
  setSessionCookie,
  clearSessionCookie,
  loadUser,
  requireRole,
  requireStaff,
};
