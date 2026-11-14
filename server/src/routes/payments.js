// Merchant endpoints called by Payme (JSON-RPC) and Click (SHOP API), plus
// pay-link builders. Invoices are in whole so'm; Payme amounts are tiyin (x100).
const crypto = require("crypto");
const express = require("express");
const db = require("../db");
const svc = require("../lib/students");
const telegram = require("../lib/telegram");

const router = express.Router();

const PAYME_TIMEOUT_MS = 12 * 60 * 60 * 1000;

function accountField() {
  return process.env.PAYME_ACCOUNT_FIELD || "invoice_id";
}

function payUrl(provider, invoice, returnUrl) {
  if (provider === "payme") {
    const merchant = process.env.PAYME_MERCHANT_ID;
    if (!merchant) return null;
    const base = process.env.PAYME_CHECKOUT_URL || "https://checkout.paycom.uz";
    let params = `m=${merchant};ac.${accountField()}=${invoice.id};a=${invoice.amount_uzs * 100}`;
    if (returnUrl) params += `;c=${returnUrl}`;
    return `${base}/${Buffer.from(params).toString("base64")}`;
  }
  if (provider === "click") {
    const service = process.env.CLICK_SERVICE_ID;
    const merchant = process.env.CLICK_MERCHANT_ID;
    if (!service || !merchant) return null;
    const q = new URLSearchParams({ service_id: service, merchant_id: merchant, amount: String(invoice.amount_uzs), transaction_param: String(invoice.id) });
    if (returnUrl) q.set("return_url", returnUrl);
    return `https://my.click.uz/services/pay?${q}`;
  }
  return null;
}

function enabledProviders() {
  return {
    payme: !!process.env.PAYME_MERCHANT_ID,
    click: !!(process.env.CLICK_SERVICE_ID && process.env.CLICK_MERCHANT_ID),
  };
}

async function onPaid(invoice, provider) {
  await svc.addEvent(invoice.student_id, null, "invoice", `Payment received via ${provider === "payme" ? "Payme" : "Click"}: ${invoice.description}`);
  const to = await svc.recipients(invoice.student_id);
  await telegram.sendMessage(to.agent, `💳 Paid via ${provider}: ${telegram.escapeHtml(invoice.description)} — ${invoice.amount_uzs.toLocaleString("en-US")} so'm (student #${invoice.student_id})`);
}

/* ===================== Payme ===================== */

function paymeError(id, code, en, data) {
  const msgs = {
    "-31001": { ru: "Неверная сумма", uz: "Noto'g'ri summa", en: "Wrong amount" },
    "-31003": { ru: "Транзакция не найдена", uz: "Tranzaksiya topilmadi", en: "Transaction not found" },
    "-31008": { ru: "Невозможно выполнить операцию", uz: "Amalni bajarib bo'lmaydi", en: "Cannot perform operation" },
    "-31050": { ru: "Счёт не найден", uz: "Hisob topilmadi", en: "Invoice not found" },
    "-31051": { ru: "Счёт уже оплачен или отменён", uz: "Hisob to'langan yoki bekor qilingan", en: "Invoice is not payable" },
    "-31052": { ru: "Счёт ожидает другую оплату", uz: "Hisob boshqa to'lovni kutmoqda", en: "Invoice has a payment in progress" },
  };
  const message = msgs[String(code)] || { ru: en, uz: en, en };
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

function paymeAuthorized(req) {
  const key = process.env.PAYME_KEY;
  if (!key) return false;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const [login, pass] = Buffer.from(h.slice(6), "base64").toString().split(":");
  const expected = Buffer.from(key);
  const got = Buffer.from(pass || "");
  return login === "Paycom" && got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

class RpcError extends Error {
  constructor(code, msg, data) {
    super(msg);
    this.code = code;
    this.data = data;
  }
}

async function paymeCheckInvoice(c, params) {
  const field = accountField();
  const invoiceId = Number(params?.account?.[field]);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) throw new RpcError(-31050, "Invoice not found", field);
  const inv = (await c.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [invoiceId])).rows[0];
  if (!inv) throw new RpcError(-31050, "Invoice not found", field);
  if (inv.status !== "pending") throw new RpcError(-31051, "Invoice is not payable", field);
  if (Number(params.amount) !== inv.amount_uzs * 100) throw new RpcError(-31001, "Wrong amount", "amount");
  return inv;
}

function txOut(t) {
  return { transaction: String(t.id), state: t.state };
}

const payme = {
  async CheckPerformTransaction(c, p) {
    await paymeCheckInvoice(c, p);
    return { allow: true };
  },

  async CreateTransaction(c, p) {
    const existing = (await c.query("SELECT * FROM payme_transactions WHERE payme_id = $1 FOR UPDATE", [String(p.id)])).rows[0];
    if (existing) {
      if (existing.state !== 1) throw new RpcError(-31008, "Transaction is not active");
      if (Date.now() - existing.create_time > PAYME_TIMEOUT_MS) {
        await c.query("UPDATE payme_transactions SET state = -1, reason = 4, cancel_time = $1 WHERE id = $2", [Date.now(), existing.id]);
        throw new RpcError(-31008, "Transaction timed out");
      }
      return { create_time: existing.create_time, ...txOut(existing) };
    }
    const inv = await paymeCheckInvoice(c, p);
    const busy = (await c.query("SELECT 1 FROM payme_transactions WHERE invoice_id = $1 AND state = 1", [inv.id])).rows[0];
    if (busy) throw new RpcError(-31052, "Invoice has a payment in progress", accountField());
    const now = Date.now();
    const t = (await c.query(
      `INSERT INTO payme_transactions (payme_id, invoice_id, amount_tiyin, state, payme_time, create_time)
       VALUES ($1,$2,$3,1,$4,$5) RETURNING *`,
      [String(p.id), inv.id, Number(p.amount), Number(p.time) || now, now]
    )).rows[0];
    return { create_time: t.create_time, ...txOut(t) };
  },

  async PerformTransaction(c, p) {
    const t = (await c.query("SELECT * FROM payme_transactions WHERE payme_id = $1 FOR UPDATE", [String(p.id)])).rows[0];
    if (!t) throw new RpcError(-31003, "Transaction not found");
    if (t.state === 2) return { perform_time: t.perform_time, ...txOut(t) };
    if (t.state !== 1) throw new RpcError(-31008, "Transaction is cancelled");
    if (Date.now() - t.create_time > PAYME_TIMEOUT_MS) {
      await c.query("UPDATE payme_transactions SET state = -1, reason = 4, cancel_time = $1 WHERE id = $2", [Date.now(), t.id]);
      throw new RpcError(-31008, "Transaction timed out");
    }
    const now = Date.now();
    const done = (await c.query("UPDATE payme_transactions SET state = 2, perform_time = $1 WHERE id = $2 RETURNING *", [now, t.id])).rows[0];
    const inv = (await c.query("UPDATE invoices SET status = 'paid', provider = 'payme', paid_at = now() WHERE id = $1 RETURNING *", [t.invoice_id])).rows[0];
    c.after.push(() => onPaid(inv, "payme"));
    return { perform_time: done.perform_time, ...txOut(done) };
  },

  async CancelTransaction(c, p) {
    const t = (await c.query("SELECT * FROM payme_transactions WHERE payme_id = $1 FOR UPDATE", [String(p.id)])).rows[0];
    if (!t) throw new RpcError(-31003, "Transaction not found");
    if (t.state === 1 || t.state === 2) {
      const state = t.state === 1 ? -1 : -2;
      const updated = (await c.query(
        "UPDATE payme_transactions SET state = $1, reason = $2, cancel_time = $3 WHERE id = $4 RETURNING *",
        [state, Number(p.reason) || null, Date.now(), t.id]
      )).rows[0];
      if (state === -2) {
        const inv = (await c.query("UPDATE invoices SET status = 'refunded' WHERE id = $1 RETURNING *", [t.invoice_id])).rows[0];
        c.after.push(() => svc.addEvent(inv.student_id, null, "invoice", `Refunded via Payme: ${inv.description}`));
      }
      return { cancel_time: updated.cancel_time, ...txOut(updated) };
    }
    return { cancel_time: t.cancel_time, ...txOut(t) };
  },

  async CheckTransaction(c, p) {
    const t = (await c.query("SELECT * FROM payme_transactions WHERE payme_id = $1", [String(p.id)])).rows[0];
    if (!t) throw new RpcError(-31003, "Transaction not found");
    return { create_time: t.create_time, perform_time: t.perform_time, cancel_time: t.cancel_time, ...txOut(t), reason: t.reason };
  },

  async GetStatement(c, p) {
    const rows = (await c.query(
      "SELECT * FROM payme_transactions WHERE payme_time BETWEEN $1 AND $2 ORDER BY payme_time",
      [Number(p.from) || 0, Number(p.to) || 0]
    )).rows;
    return {
      transactions: rows.map((t) => ({
        id: t.payme_id,
        time: t.payme_time,
        amount: t.amount_tiyin,
        account: { [accountField()]: String(t.invoice_id) },
        create_time: t.create_time,
        perform_time: t.perform_time,
        cancel_time: t.cancel_time,
        transaction: String(t.id),
        state: t.state,
        reason: t.reason,
      })),
    };
  },
};

router.post("/payme", async (req, res) => {
  const body = req.body || {};
  const id = body.id ?? null;
  if (!paymeAuthorized(req)) return res.json(paymeError(id, -32504, "Unauthorized"));
  const method = payme[body.method];
  if (!method || !Object.prototype.hasOwnProperty.call(payme, body.method)) return res.json(paymeError(id, -32601, "Method not found", body.method));
  const after = [];
  try {
    const result = await db.tx((c) => {
      c.after = after;
      return method(c, body.params || {});
    });
    for (const fn of after) await fn().catch((e) => console.error("[payme] after-hook", e));
    res.json({ jsonrpc: "2.0", id, result });
  } catch (e) {
    if (e instanceof RpcError) return res.json(paymeError(id, e.code, e.message, e.data));
    console.error("[payme]", e);
    res.json(paymeError(id, -32400, "Internal error"));
  }
});

/* ===================== Click ===================== */

function clickSign(p, withPrepare) {
  const secret = process.env.CLICK_SECRET_KEY || "";
  const parts = [p.click_trans_id, p.service_id, secret, p.merchant_trans_id];
  if (withPrepare) parts.push(p.merchant_prepare_id);
  parts.push(p.amount, p.action, p.sign_time);
  return crypto.createHash("md5").update(parts.join("")).digest("hex");
}

function clickReply(p, error, error_note, extra = {}) {
  return {
    click_trans_id: Number(p.click_trans_id) || 0,
    merchant_trans_id: String(p.merchant_trans_id || ""),
    ...extra,
    error,
    error_note,
  };
}

function clickCheck(p, action, withPrepare) {
  if (!process.env.CLICK_SECRET_KEY) return [-8, "Click is not configured"];
  const required = ["click_trans_id", "service_id", "merchant_trans_id", "amount", "action", "sign_time", "sign_string"];
  if (withPrepare) required.push("merchant_prepare_id");
  if (required.some((k) => p[k] === undefined || p[k] === "")) return [-8, "Error in request from click"];
  const sign = String(p.sign_string).toLowerCase();
  const expected = clickSign(p, withPrepare);
  if (sign.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sign), Buffer.from(expected))) return [-1, "SIGN CHECK FAILED!"];
  if (String(p.service_id) !== String(process.env.CLICK_SERVICE_ID)) return [-8, "Wrong service"];
  if (String(p.action) !== String(action)) return [-3, "Action not found"];
  return null;
}

const amountMatches = (inv, amount) => Math.abs(Number(amount) - inv.amount_uzs) < 0.01;

router.post("/click/prepare", express.urlencoded({ extended: false }), async (req, res) => {
  const p = { ...req.body };
  const fail = clickCheck(p, 0, false);
  if (fail) return res.json(clickReply(p, ...fail));
  const out = await db.tx(async (c) => {
    const invId = Number(p.merchant_trans_id);
    const inv = Number.isInteger(invId) && (await c.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [invId])).rows[0];
    if (!inv) return [-5, "Invoice does not exist"];
    if (inv.status === "paid") return [-4, "Already paid"];
    if (inv.status !== "pending") return [-9, "Invoice cancelled"];
    if (!amountMatches(inv, p.amount)) return [-2, "Incorrect parameter amount"];
    const existing = (await c.query("SELECT * FROM click_transactions WHERE click_trans_id = $1", [Number(p.click_trans_id)])).rows[0];
    if (existing) {
      if (existing.status === "cancelled") return [-9, "Transaction cancelled"];
      return [0, "Success", { merchant_prepare_id: existing.id }];
    }
    const t = (await c.query(
      "INSERT INTO click_transactions (click_trans_id, invoice_id, amount, status) VALUES ($1,$2,$3,'prepared') RETURNING id",
      [Number(p.click_trans_id), inv.id, Number(p.amount)]
    )).rows[0];
    return [0, "Success", { merchant_prepare_id: t.id }];
  });
  res.json(clickReply(p, ...out));
});

router.post("/click/complete", express.urlencoded({ extended: false }), async (req, res) => {
  const p = { ...req.body };
  const fail = clickCheck(p, 1, true);
  if (fail) return res.json(clickReply(p, ...fail));
  let paidInvoice = null;
  const out = await db.tx(async (c) => {
    const t = (await c.query(
      "SELECT * FROM click_transactions WHERE id = $1 AND click_trans_id = $2 FOR UPDATE",
      [Number(p.merchant_prepare_id), Number(p.click_trans_id)]
    )).rows[0];
    if (!t) return [-6, "Transaction does not exist"];
    if (t.status === "completed") return [-4, "Already paid", { merchant_confirm_id: t.id }];
    if (t.status === "cancelled") return [-9, "Transaction cancelled"];
    if (String(t.invoice_id) !== String(p.merchant_trans_id)) return [-6, "Transaction does not exist"];
    const inv = (await c.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [t.invoice_id])).rows[0];
    // Click reports its own failure with a negative error; we cancel our side.
    if (Number(p.error) < 0) {
      await c.query("UPDATE click_transactions SET status = 'cancelled', updated_at = now() WHERE id = $1", [t.id]);
      return [-9, "Transaction cancelled"];
    }
    if (!amountMatches(inv, p.amount)) return [-2, "Incorrect parameter amount"];
    if (inv.status === "paid") return [-4, "Already paid"];
    if (inv.status !== "pending") return [-9, "Invoice cancelled"];
    await c.query("UPDATE click_transactions SET status = 'completed', updated_at = now() WHERE id = $1", [t.id]);
    paidInvoice = (await c.query("UPDATE invoices SET status = 'paid', provider = 'click', paid_at = now() WHERE id = $1 RETURNING *", [inv.id])).rows[0];
    return [0, "Success", { merchant_confirm_id: t.id }];
  });
  if (paidInvoice) await onPaid(paidInvoice, "click").catch((e) => console.error("[click] after-hook", e));
  res.json(clickReply(p, ...out));
});

module.exports = { router, payUrl, enabledProviders, clickSign };
