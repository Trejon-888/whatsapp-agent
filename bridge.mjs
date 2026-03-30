#!/usr/bin/env node

/**
 * WhatsApp Agent Bridge (Claude Code CLI Mode)
 *
 * Receives Zernio webhooks, calls claude -p for AI responses, replies on WhatsApp.
 * Zero API cost -- uses Claude Code's OAuth connection.
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

if (!ZERNIO_KEY) { console.error("\x1b[31mMissing ZERNIO_API_KEY in .env\x1b[0m"); process.exit(1); }
if (!WA_ACCOUNT_ID) { console.error("\x1b[31mMissing ZERNIO_WA_ACCOUNT_ID in .env\x1b[0m"); process.exit(1); }

for (const d of ["conversations", "memory", "escalations"]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// === TERMINAL UI ===
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  orange: "\x1b[38;2;255;118;20m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
  bgOrange: "\x1b[48;2;255;118;20m",
  bgGreen: "\x1b[42m",
  bgCyan: "\x1b[46m",
  bgDark: "\x1b[48;2;23;30;25m",
};

let msgCount = 0;
let replyCount = 0;
const startTime = Date.now();

function timestamp() {
  return new Date().toLocaleTimeString("en-US", { hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function divider() {
  return C.gray + "─".repeat(60) + C.reset;
}

function showBanner() {
  console.clear();
  console.log("");
  console.log(C.orange + C.bold + "  ╔══════════════════════════════════════════════╗" + C.reset);
  console.log(C.orange + C.bold + "  ║     WhatsApp AI Agent  -  Live Dashboard     ║" + C.reset);
  console.log(C.orange + C.bold + "  ╚══════════════════════════════════════════════╝" + C.reset);
  console.log("");
  console.log(C.gray + "  Mode:    " + C.white + "Claude Code CLI (OAuth, zero cost)" + C.reset);
  console.log(C.gray + "  Port:    " + C.white + PORT + C.reset);
  console.log(C.gray + "  Webhook: " + C.white + "POST /webhook" + C.reset);
  console.log(C.gray + "  Health:  " + C.white + "GET  /health" + C.reset);
  console.log("");
  console.log(divider());
  console.log(C.green + C.bold + "  Listening for WhatsApp messages..." + C.reset);
  console.log(divider());
  console.log("");
}

function showIncoming(phone, name, text) {
  msgCount++;
  const t = timestamp();
  console.log(C.cyan + C.bold + "  INCOMING MESSAGE" + C.reset + C.gray + "  " + t + C.reset);
  console.log(C.cyan + "  From: " + C.white + C.bold + (name || phone) + C.reset + C.gray + "  " + phone + C.reset);
  console.log("");
  // WhatsApp-style bubble
  console.log(C.bgCyan + C.bold + " " + C.reset + C.cyan + " " + text + C.reset);
  console.log("");
  console.log(C.yellow + "  Thinking..." + C.reset);
}

function showThinking(seconds) {
  process.stdout.write("\r" + C.yellow + "  Thinking... " + C.dim + "(" + seconds + "s)" + C.reset + "  ");
}

function showReply(phone, reply, durationSec) {
  replyCount++;
  process.stdout.write("\r" + " ".repeat(40) + "\r");
  console.log(C.orange + C.bold + "  AGENT REPLY" + C.reset + C.gray + "  " + durationSec.toFixed(1) + "s" + C.reset);
  console.log("");
  // Agent bubble
  console.log(C.bgOrange + C.bold + " " + C.reset + C.orange + " " + reply + C.reset);
  console.log("");
}

function showSent(phone) {
  console.log(C.green + "  Delivered to WhatsApp" + C.reset);
  console.log("");
  console.log(divider());
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(uptime / 60);
  const secs = uptime % 60;
  console.log(C.gray + "  Messages: " + C.white + msgCount + C.gray + "  Replies: " + C.white + replyCount + C.gray + "  Uptime: " + C.white + mins + "m " + secs + "s" + C.reset);
  console.log(divider());
  console.log("");
}

function showError(msg) {
  console.log(C.red + C.bold + "  ERROR: " + C.reset + C.red + msg + C.reset);
  console.log("");
}

// === CORE ===
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
  const ts = new Date().toISOString().substring(0, 19).replace("T", " ");
  const convFile = resolve(WORKSPACE, "conversations", phone.replace(/\+/g, "") + ".md");

  let history = "";
  try { history = readFileSync(convFile, "utf8"); } catch {}
  const entry = "\n**Customer [" + ts + "]:** " + text + "\n";
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
    "  Example:",
    "  ESCALATE: Customer wants custom catering pricing for 200 guests",
    "",
    "  I'd love to help with that! Let me have our team put together a custom quote for you. Someone will follow up shortly.",
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

    // Check for escalation
    let customerReply = reply;
    if (reply.startsWith("ESCALATE:")) {
      const parts = reply.split("\n\n");
      const reason = parts[0].replace("ESCALATE:", "").trim();
      customerReply = parts.slice(1).join("\n\n").trim() || "Thanks for reaching out! Someone from our team will follow up with you shortly.";

      const escFile = resolve(WORKSPACE, "escalations", new Date().toISOString().substring(0, 10) + ".md");
      let existing = "";
      try { existing = readFileSync(escFile, "utf8"); } catch {}
      const escEntry = "\n### " + ts + " — " + phone + "\n- **Reason:** " + reason + "\n- **Context:** " + text + "\n";
      writeFileSync(escFile, existing + escEntry);
    }

    // Daily memory log
    const memFile = resolve(WORKSPACE, "memory", new Date().toISOString().substring(0, 10) + ".md");
    let memExisting = "";
    try { memExisting = readFileSync(memFile, "utf8"); } catch {}
    const memEntry = "\n- **" + ts + "** — " + phone + ": Asked: " + text.substring(0, 100) + " → Replied: " + customerReply.substring(0, 100) + (reply.startsWith("ESCALATE:") ? " [ESCALATED]" : "") + "\n";
    writeFileSync(memFile, memExisting + memEntry);

    writeFileSync(convFile, readFileSync(convFile, "utf8") + "**Agent [" + ts + "]:** " + customerReply + "\n");
    return customerReply;
  } catch (err) {
    showError("Claude: " + (err.message?.substring(0, 100) || "unknown error"));
    return "Hey! Got your message. Let me get back to you shortly.";
  }
}

async function drain() {
  if (busy || queue.length === 0) return;
  busy = true;
  while (queue.length > 0) {
    const j = queue.shift();
    try {
      showIncoming(j.phone, j.name, j.text);

      const start = Date.now();
      const thinkInterval = setInterval(() => showThinking(((Date.now() - start) / 1000).toFixed(0)), 1000);

      const reply = askClaude(j.phone, j.text);
      clearInterval(thinkInterval);

      const duration = (Date.now() - start) / 1000;
      showReply(j.phone, reply, duration);

      const result = await zernio("/inbox/conversations/" + j.convId + "/messages", {
        method: "POST",
        body: JSON.stringify({ accountId: WA_ACCOUNT_ID, message: reply }),
      });

      if (result.success || result.data) {
        showSent(j.phone);
      } else {
        showError("Zernio: " + JSON.stringify(result).substring(0, 100));
      }
    } catch (e) {
      showError(e.message);
    }
  }
  busy = false;
}

http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, mode: "claude-cli", messages: msgCount, replies: replyCount, queued: queue.length }));
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
      } catch (e) { showError(e.message); }
    });
    return;
  }
  res.writeHead(404);
  res.end("Not found");
}).listen(PORT, "0.0.0.0", () => {
  showBanner();
});
