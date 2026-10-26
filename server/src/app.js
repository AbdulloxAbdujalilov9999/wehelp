const path = require("path");
const express = require("express");
const auth = require("./lib/auth");

const ROOT = path.join(__dirname, "..", "..");
const PAGES = { "/": "index.html", "/index.html": "index.html", "/agency": "agency.html", "/agency.html": "agency.html", "/parent.html": "parent.html" };

function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer"); // parent links carry a secret in the URL
    next();
  });

  // Payment providers and Telegram call these; they must not be blocked by the CSRF check.
  app.use("/api/payments", express.json({ limit: "64kb" }), require("./routes/payments").router);

  app.use("/api", express.json({ limit: "256kb" }), auth.loadUser, (req, res, next) => {
    // Cookie sessions + SameSite=Lax, plus: state-changing calls must be JSON,
    // which a cross-site HTML form cannot send.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !req.path.startsWith("/telegram/") && !req.is("application/json")) {
      return res.status(415).json({ error: "Send JSON" });
    }
    next();
  });
  app.use("/api/auth", require("./routes/auth").router);
  app.use("/api/board", require("./routes/board").router);
  app.use("/api/universities", require("./routes/universities").router);
  app.use("/api", require("./routes/public").router);
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  for (const [route, file] of Object.entries(PAGES)) {
    app.get(route, (_req, res) => res.sendFile(path.join(ROOT, file)));
  }

  app.use((err, _req, res, _next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "Too large" });
    console.error(err);
    if (res.headersSent) return;
    res.status(err.status || 500).json({ error: err.status ? err.message : "Server error" });
  });
  return app;
}

module.exports = { createApp };
