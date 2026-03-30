#!/usr/bin/env node

/**
 * WhatsApp Agent Bridge (Claude Code CLI Mode)
 *
 * Receives Zernio webhooks, calls claude -p for AI responses, replies on WhatsApp.
 * Stores all conversations in SQLite. Serves a dashboard on /dashboard.
 *
 * Usage:
 *   1. Copy .env.example to .env and fill in your Zernio keys
 *   2. npm install
 *   3. node bridge.mjs
 *   4. Set your Zernio webhook URL to: https://your-domain/webhook
 */

import http from "node:http";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  recordIncoming, recordOutgoing, recordEscalation,
  getConversationHistory, getRecentConversations, getConversation,
  getOpenEscalations, getStats, getDailySummary,
} from "./db.mjs";

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

function askClaude(phone, name, text) {
  // Record incoming message
  recordIncoming(phone, name, text);

  // Load agent behavior rules
  let behavior = "";
  const claudePath = resolve(WORKSPACE, "CLAUDE.md");
  if (existsSync(claudePath)) {
    try { behavior = readFileSync(claudePath, "utf8"); } catch {}
  }

  // Load business knowledge
  let biz = "";
  try { biz = readFileSync(resolve(WORKSPACE, "BUSINESS.md"), "utf8"); } catch {}

  // Load conversation history from SQLite
  const history = getConversationHistory(phone, 20);
  const historyStr = history.map(m =>
    (m.direction === "in" ? "Customer" : "Agent") + " [" + m.created_at.substring(11, 19) + "]: " + m.text
  ).join("\n");

  const prompt = [
    behavior ? behavior.substring(0, 1500) : "You are a WhatsApp business receptionist. Warm, helpful, concise.",
    "",
    "Reply to the customer's latest message. Keep under 150 words.",
    "",
    "IMPORTANT: Output ONLY the reply text, UNLESS you need to escalate.",
    "If the customer asks about something you can't handle (custom pricing, complaints, technical support beyond FAQ):",
    "  Start with ESCALATE: followed by a reason, then a blank line, then your reply to the customer.",
    "If no escalation needed, just output the reply. No labels or markdown.",
    "",
    "=== BUSINESS ===",
    biz.substring(0, 3000),
    "",
    "=== CONVERSATION ===",
    historyStr,
    "Customer: " + text,
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
      customerReply = parts.slice(1).join("\n\n").trim() || "Thanks for reaching out! Someone from our team will follow up shortly.";
      recordEscalation(phone, reason, text);
      log("ESC", phone + ": " + reason);
    }

    recordOutgoing(phone, customerReply);
    return customerReply;
  } catch (err) {
    log("ERR", "claude: " + (err.message?.substring(0, 100) || "unknown"));
    const fallback = "Hey! Got your message. Let me get back to you shortly.";
    recordOutgoing(phone, fallback);
    return fallback;
  }
}

async function drain() {
  if (busy || queue.length === 0) return;
  busy = true;
  while (queue.length > 0) {
    const j = queue.shift();
    try {
      log("IN", j.phone + " (" + (j.name || "unknown") + "): " + j.text);
      const reply = askClaude(j.phone, j.name, j.text);
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

// === DASHBOARD HTML ===
function dashboardHTML() {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhatsApp Agent Dashboard</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',system-ui,sans-serif;background:#0f1210;color:#e0e0e0;min-height:100vh}
  .header{background:#171e19;border-bottom:2px solid #FF7614;padding:20px 32px;display:flex;align-items:center;justify-content:space-between}
  .header h1{color:#FF7614;font-size:20px;font-weight:800;letter-spacing:-0.5px}
  .stats{display:flex;gap:24px}
  .stat{text-align:center}.stat .n{font-size:24px;font-weight:800;color:#fff}.stat .l{font-size:11px;color:#888;text-transform:uppercase}
  .main{display:grid;grid-template-columns:320px 1fr;height:calc(100vh - 70px)}
  .sidebar{background:#141a16;border-right:1px solid #2a3530;overflow-y:auto}
  .sidebar .title{padding:16px;font-size:13px;font-weight:700;color:#888;text-transform:uppercase;border-bottom:1px solid #2a3530}
  .contact{padding:14px 16px;border-bottom:1px solid #1e2620;cursor:pointer;transition:background .15s}
  .contact:hover,.contact.active{background:#1e2822}
  .contact .name{font-weight:700;font-size:14px;color:#fff}
  .contact .preview{font-size:12px;color:#888;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .contact .meta{display:flex;justify-content:space-between;margin-top:6px;font-size:11px;color:#555}
  .chat{display:flex;flex-direction:column;height:100%}
  .chat-header{padding:16px 24px;border-bottom:1px solid #2a3530;background:#171e19}
  .chat-header .name{font-weight:800;font-size:16px;color:#fff}
  .chat-header .phone{font-size:13px;color:#888}
  .messages{flex:1;overflow-y:auto;padding:24px}
  .msg{max-width:70%;margin-bottom:12px;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.5}
  .msg.in{background:#1e2822;border:1px solid #2a3530;margin-right:auto}
  .msg.out{background:#FF7614;color:#000;margin-left:auto;font-weight:500}
  .msg .time{font-size:10px;color:#666;margin-top:4px}
  .msg.out .time{color:rgba(0,0,0,0.5)}
  .empty{display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:16px}
  .esc-badge{background:#ff4444;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700}
  .tab-bar{display:flex;border-bottom:1px solid #2a3530}
  .tab{padding:12px 20px;font-size:13px;font-weight:600;color:#888;cursor:pointer;border-bottom:2px solid transparent}
  .tab.active{color:#FF7614;border-bottom-color:#FF7614}
  @media(max-width:768px){.main{grid-template-columns:1fr}.sidebar{display:none}}
</style>
</head><body>
<div class="header">
  <h1>WhatsApp Agent</h1>
  <div class="stats" id="stats"></div>
</div>
<div class="main">
  <div class="sidebar">
    <div class="tab-bar">
      <div class="tab active" onclick="loadConversations()">Conversations</div>
      <div class="tab" onclick="loadEscalations()">Escalations</div>
    </div>
    <div id="sidebar-content"></div>
  </div>
  <div class="chat" id="chat">
    <div class="empty">Select a conversation</div>
  </div>
</div>
<script>
const API = '';
async function api(path){const r=await fetch(API+path);return r.json()}
async function loadStats(){
  const s=await api('/api/stats');
  document.getElementById('stats').innerHTML=
    '<div class="stat"><div class="n">'+s.active_today+'</div><div class="l">Active Today</div></div>'+
    '<div class="stat"><div class="n">'+s.messages_today+'</div><div class="l">Messages</div></div>'+
    '<div class="stat"><div class="n">'+s.open_escalations+'</div><div class="l">Escalations</div></div>'+
    '<div class="stat"><div class="n">'+s.total_contacts+'</div><div class="l">Contacts</div></div>';
}
async function loadConversations(){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab')[0].classList.add('active');
  const convos=await api('/api/conversations');
  document.getElementById('sidebar-content').innerHTML=convos.map(c=>
    '<div class="contact" onclick="loadChat('+c.id+')">'+
    '<div class="name">'+(c.name||c.phone)+'</div>'+
    '<div class="preview">'+(c.last_message||'')+'</div>'+
    '<div class="meta"><span>'+c.platform+'</span><span>'+c.message_count+' msgs</span></div>'+
    '</div>'
  ).join('');
}
async function loadEscalations(){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab')[1].classList.add('active');
  const escs=await api('/api/escalations');
  document.getElementById('sidebar-content').innerHTML=escs.map(e=>
    '<div class="contact" onclick="loadChat('+e.contact_id+')">'+
    '<div class="name">'+(e.name||e.phone)+' <span class="esc-badge">OPEN</span></div>'+
    '<div class="preview">'+e.reason+'</div>'+
    '<div class="meta"><span>'+e.created_at.substring(0,10)+'</span><span>'+e.context?.substring(0,30)+'</span></div>'+
    '</div>'
  ).join('')||'<div style="padding:24px;color:#555">No open escalations</div>';
}
async function loadChat(id){
  const data=await api('/api/conversations/'+id);
  const c=data.contact;
  const msgs=data.messages;
  document.getElementById('chat').innerHTML=
    '<div class="chat-header"><div class="name">'+(c.name||c.phone)+'</div><div class="phone">'+c.phone+' &middot; '+c.platform+' &middot; '+c.message_count+' messages</div></div>'+
    '<div class="messages" id="msgs">'+msgs.map(m=>
      '<div class="msg '+(m.direction==='in'?'in':'out')+'">'+m.text+'<div class="time">'+m.created_at.substring(11,19)+'</div></div>'
    ).join('')+'</div>';
  document.getElementById('msgs').scrollTop=99999;
}
loadStats();loadConversations();
setInterval(loadStats,30000);
</script>
</body></html>`;
}

// === HTTP SERVER ===
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Health
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ...getStats() }));
  }

  // Dashboard
  if (req.method === "GET" && (url.pathname === "/dashboard" || url.pathname === "/")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(dashboardHTML());
  }

  // API: Stats
  if (req.method === "GET" && url.pathname === "/api/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getStats()));
  }

  // API: Conversations list
  if (req.method === "GET" && url.pathname === "/api/conversations") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getRecentConversations(100)));
  }

  // API: Single conversation
  const convMatch = url.pathname.match(/^\/api\/conversations\/(\d+)$/);
  if (req.method === "GET" && convMatch) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getConversation(parseInt(convMatch[1]))));
  }

  // API: Escalations
  if (req.method === "GET" && url.pathname === "/api/escalations") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getOpenEscalations()));
  }

  // API: Daily summary
  if (req.method === "GET" && url.pathname === "/api/summary") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getDailySummary()));
  }

  // Webhook
  if (req.method === "POST" && url.pathname === "/webhook") {
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
  log("START", "Dashboard at http://localhost:" + PORT + "/dashboard");
});
