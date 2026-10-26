// Thin Telegram Bot API client. Without TELEGRAM_BOT_TOKEN every send is a
// logged no-op, so local dev and tests never hit the network.
const sent = [];

async function sendMessage(chatId, text) {
  if (!chatId) return false;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    sent.push({ chatId: Number(chatId), text });
    if (process.env.NODE_ENV !== "test") console.log(`[telegram:dry-run] ${chatId}: ${text.slice(0, 80)}`);
    return false;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!r.ok) console.error("[telegram] send failed", r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error("[telegram] send error", e.message);
    return false;
  }
}

function deepLink(payload) {
  const bot = process.env.TELEGRAM_BOT_USERNAME;
  return bot ? `https://t.me/${bot}?start=${encodeURIComponent(payload)}` : null;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

module.exports = { sendMessage, deepLink, escapeHtml, sent };
