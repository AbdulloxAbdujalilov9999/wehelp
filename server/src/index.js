const db = require("./db");
const { createApp } = require("./app");
const { runReminders } = require("./lib/reminders");
const auth = require("./lib/auth");

// First admin on hosts without a shell (Render free): set ADMIN_EMAIL and
// ADMIN_PASSWORD once. Used only while no admin exists; remove them afterwards.
async function bootstrapAdmin() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) return;
  if (await db.one("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1")) return;
  if (password.length < 8) return console.error("[admin] ADMIN_PASSWORD needs 8+ characters");
  await db.query(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'`,
    [email, auth.hashPassword(password), process.env.ADMIN_NAME || email]
  );
  console.log(`[admin] created ${email}; you can now remove ADMIN_PASSWORD`);
}

async function main() {
  await db.migrate();
  await bootstrapAdmin();
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`UniSprint server on :${port}`));

  // Hourly reminder pass, only between 09:00 and 21:00 Tashkent time (UTC+5).
  if (process.env.REMINDERS !== "off") {
    const tick = async () => {
      const hour = (new Date().getUTCHours() + 5) % 24;
      if (hour < 9 || hour >= 21) return;
      try {
        const r = await runReminders();
        if (r.messages) console.log(`[reminders] sent ${r.messages} messages for ${r.students} students`);
      } catch (e) {
        console.error("[reminders]", e);
      }
    };
    setInterval(tick, 60 * 60 * 1000).unref();
    setTimeout(tick, 30 * 1000).unref();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
