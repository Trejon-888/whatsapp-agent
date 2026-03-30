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

if (!ZERNIO_KEY) { console.error("Missing ZERNIO_API_KEY in .env"); process.exit(1); }
if (!WA_ACCOUNT_ID) { console.error("Missing ZERNIO_WA_ACCOUNT_ID in .env"); process.exit(1); }

// Ensure directories
for (const d of ["conversations", "memory", "escalations"]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

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

  // Load conversation history
  let history = "";
  try { history = readFileSync(convFile, "utf8"); } catch {}
  const entry = "\n**Customer [" + ts + "]:** " + text + "\n";
  writeFileSync(convFile, history + entry);

  // Load business context
  let biz = "";
  try { biz = readFileSync(resolve(WORKSPACE, "BUSINESS.md"), "utf8"); } catch {}

  const prompt = [
    "You are a WhatsApp business receptionist. Reply to the customer's latest message.",
    "Use the business details and conversation history below.",
    "Keep under 150 words. Warm, helpful, concise. Output ONLY the reply. No labels or markdown.",
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

    writeFileSync(convFile, readFileSync(convFile, "utf8") + "**Agent [" + ts + "]:** " + reply + "\n");
    return reply;
  } catch (err) {
    console.error("[claude]", err.message?.substring(0, 150));
    return "Hey! Got your message. Let me get back to you shortly.";
  }
}

async function drain() {
  if (busy || queue.length === 0) return;
  busy = true;
  while (queue.length > 0) {
    const j = queue.shift();
    try {
      console.log("[in] " + j.phone + ": " + j.text);
      const reply = askClaude(j.phone, j.text);
      console.log("[out] " + j.phone + ": " + reply.substring(0, 80));
      await zernio("/inbox/conversations/" + j.convId + "/messages", {
        method: "POST",
        body: JSON.stringify({ accountId: WA_ACCOUNT_ID, message: reply }),
      });
      console.log("[sent]");
    } catch (e) { console.error("[err]", e.message); }
  }
  busy = false;
}

http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, mode: "claude-cli", replied: replied.size, queued: queue.length }));
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
        if (msg.direction === "outbound" || !text) return;
        if (msg.id && replied.has(msg.id)) return;
        if (msg.id) replied.add(msg.id);
        queue.push({ phone, text, convId: conv.id });
        drain();
      } catch (e) { console.error("[err]", e.message); }
    });
    return;
  }
  res.writeHead(404);
  res.end("Not found");
}).listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("  WhatsApp Agent Bridge (Claude Code CLI)");
  console.log("  Port:    " + PORT);
  console.log("  Webhook: POST /webhook");
  console.log("  Health:  GET  /health");
  console.log("  Mode:    claude -p (OAuth, zero API cost)");
  console.log("");
});
