#!/usr/bin/env node

/**
 * WhatsApp Agent Bridge (Claude Code CLI Mode)
 *
 * Receives Zernio webhooks, calls claude -p for AI responses, replies on WhatsApp.
 * Uses Claude Code's OAuth connection. No API key needed.
 *
 * Usage:
 *   1. Copy .env.example to .env and fill in your Zernio keys
 *   2. node bridge.mjs
 *   3. Set your Zernio webhook URL to: https://your-domain/webhook
 */

import http from "node:http";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Load .env
try {
  const env = readFileSync(".env", "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

const PORT = parseInt(process.env.BRIDGE_PORT || "18800");
const ZERNIO_API = "https://zernio.com/api/v1";
const ZERNIO_KEY = process.env.ZERNIO_API_KEY;
const WA_ACCOUNT_ID = process.env.ZERNIO_WA_ACCOUNT_ID;
const WORKSPACE = process.cwd();

if (!ZERNIO_KEY) { console.error("Missing ZERNIO_API_KEY in .env"); process.exit(1); }
if (!WA_ACCOUNT_ID) { console.error("Missing ZERNIO_WA_ACCOUNT_ID in .env"); process.exit(1); }

for (const d of ["conversations", "memory", "escalations"]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function ts() { return new Date().toISOString().substring(0, 19).replace("T", " "); }
function log(tag, msg) { console.log("[" + ts() + "] " + tag + " " + msg); }

const replied = new Set();
const queue = [];
let busy = false;

async function zernio(path, opts = {}) {
  const res = await fetch(ZERNIO_API + path, {
    ...opts,
    headers: { "Authorization": "Bearer " + ZERNIO_KEY, "Content-Type": "application/json", ...opts.headers },
  });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { error: txt.substring(0, 150) }; }
}

function askClaude(phone, text) {
  const now = ts();
  const convFile = resolve(WORKSPACE, "conversations", phone.replace(/\+/g, "") + ".md");

  let history = "";
  try { history = readFileSync(convFile, "utf8"); } catch {}
  const entry = "\n**Customer [" + now + "]:** " + text + "\n";
  writeFileSync(convFile, history + entry);

  let biz = "";
  try { biz = readFileSync(resolve(WORKSPACE, "BUSINESS.md"), "utf8"); } catch {}

  const prompt = [
    "You are a WhatsApp business receptionist. Reply to the customer's latest message.",
    "Use the business details and conversation history below.",
    "Keep under 150 words. Warm, helpful, concise.",
    "",
    "IMPORTANT: Output ONLY the reply text, UNLESS you need to escalate.",
    "If the customer asks about something you can't handle (custom pricing, complaints needing resolution, technical support beyond FAQ, or anything you're unsure about):",
    "  Start your response with ESCALATE: on its own line, followed by a brief reason, then a blank line, then your reply to the customer.",
    "",
    "If no escalation is needed, just output the reply. No labels or markdown.",
    "",
    "=== BUSINESS ===",
    biz.substring(0, 3000),
    "",
    "=== CONVERSATION ===",
    (history + entry).split("\n").slice(-30).join("\n"),
  ].join("\n");

  try {
    const reply = execSync("claude -p --output-format text", {
      input: prompt,
      encoding: "utf8",
      timeout: 90000,
      cwd: WORKSPACE,
    }).trim();

    let customerReply = reply;
    if (reply.startsWith("ESCALATE:")) {
      const parts = reply.split("\n\n");
      const reason = parts[0].replace("ESCALATE:", "").trim();
      customerReply = parts.slice(1).join("\n\n").trim() || "Thanks for reaching out! Someone from our team will follow up with you shortly.";

      const escFile = resolve(WORKSPACE, "escalations", new Date().toISOString().substring(0, 10) + ".md");
      let existing = "";
      try { existing = readFileSync(escFile, "utf8"); } catch {}
      writeFileSync(escFile, existing + "\n### " + now + " -- " + phone + "\n- **Reason:** " + reason + "\n- **Context:** " + text + "\n");
      log("ESC", phone + ": " + reason);
    }

    const memFile = resolve(WORKSPACE, "memory", new Date().toISOString().substring(0, 10) + ".md");
    let memExisting = "";
    try { memExisting = readFileSync(memFile, "utf8"); } catch {}
    writeFileSync(memFile, memExisting + "\n- **" + now + "** " + phone + ": " + text.substring(0, 80) + " -> " + customerReply.substring(0, 80) + "\n");

    writeFileSync(convFile, readFileSync(convFile, "utf8") + "**Agent [" + now + "]:** " + customerReply + "\n");
    return customerReply;
  } catch (err) {
    log("ERR", "claude: " + (err.message?.substring(0, 100) || "unknown"));
    return "Hey! Got your message. Let me get back to you shortly.";
  }
}

async function drain() {
  if (busy || queue.length === 0) return;
  busy = true;
  while (queue.length > 0) {
    const j = queue.shift();
    try {
      log("IN", j.phone + " (" + (j.name || "unknown") + "): " + j.text);
      const reply = askClaude(j.phone, j.text);
      log("OUT", j.phone + ": " + reply.substring(0, 100));
      const result = await zernio("/inbox/conversations/" + j.convId + "/messages", {
        method: "POST",
        body: JSON.stringify({ accountId: WA_ACCOUNT_ID, message: reply }),
      });
      log("SENT", result.success ? "ok" : JSON.stringify(result).substring(0, 80));
    } catch (e) { log("ERR", e.message); }
  }
  busy = false;
}

http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, replied: replied.size, queued: queue.length }));
  }
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"received":true}');
      try {
        const p = JSON.parse(body);
        if (p.event !== "message.received") return;
        const msg = p.message || {};
        const conv = p.conversation || {};
        const sender = msg.sender || {};
        const text = msg.text || msg.body || "";
        const phone = sender.phoneNumber || sender.id || conv.participantId || "unknown";
        const name = sender.name || conv.participantName || "";
        if (msg.direction === "outbound" || !text) return;
        if (msg.id && replied.has(msg.id)) return;
        if (msg.id) replied.add(msg.id);
        queue.push({ phone, text, name, convId: conv.id });
        drain();
      } catch (e) { log("ERR", e.message); }
    });
    return;
  }
  res.writeHead(404);
  res.end("Not found");
}).listen(PORT, "0.0.0.0", () => {
  log("START", "WhatsApp Agent Bridge on port " + PORT);
});
