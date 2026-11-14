// Done-for-you service packages and intake deadlines (server/data/packages.json),
// plus the public contact handles, which come from the environment.
const path = require("path");
const fs = require("fs");

const FILE = path.join(__dirname, "..", "..", "data", "packages.json");
let cache = null;

function load() {
  if (!cache) cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
  return cache;
}

function packages() {
  return load().packages;
}

function findPackage(id) {
  if (!id) return null;
  return packages().find((p) => p.id === String(id)) || null;
}

// Only deadlines that have not passed yet (Tashkent date), soonest first.
function deadlines(now = new Date()) {
  const today = new Date(now.getTime() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  return load()
    .deadlines.filter((d) => d.closes >= today)
    .sort((a, b) => a.closes.localeCompare(b.closes));
}

function contact() {
  const tg = (process.env.CONTACT_TELEGRAM || "").replace(/^@/, "").trim();
  return {
    telegram: tg || null,
    phone: (process.env.CONTACT_PHONE || "").trim() || null,
    instagram: (process.env.CONTACT_INSTAGRAM || "").replace(/^@/, "").trim() || null,
  };
}

module.exports = { packages, findPackage, deadlines, contact };
