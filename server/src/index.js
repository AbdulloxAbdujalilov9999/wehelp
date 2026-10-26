const db = require("./db");
const { createApp } = require("./app");
const { runReminders } = require("./lib/reminders");

async function main() {
  await db.migrate();
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`WeHelp server on :${port}`));

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
