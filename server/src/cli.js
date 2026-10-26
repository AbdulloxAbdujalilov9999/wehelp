// Usage:
//   node src/cli.js migrate
//   node src/cli.js create-admin <email> <password> [name]
//   node src/cli.js remind
const db = require("./db");
const auth = require("./lib/auth");

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  await db.migrate();
  if (cmd === "migrate") {
    console.log("Database is up to date");
  } else if (cmd === "create-admin") {
    const [email, password, ...name] = args;
    if (!email || !password || password.length < 8) throw new Error("Usage: create-admin <email> <password (8+ chars)> [name]");
    const u = await db.one(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,'admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin' RETURNING id, email`,
      [email.toLowerCase(), auth.hashPassword(password), name.join(" ") || email]
    );
    console.log(`Admin ready: ${u.email} (id ${u.id})`);
  } else if (cmd === "remind") {
    console.log(await require("./lib/reminders").runReminders());
  } else {
    throw new Error("Commands: migrate | create-admin | remind");
  }
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
