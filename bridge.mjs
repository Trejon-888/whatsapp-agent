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

  // Load agent personality (not CLAUDE.md -- that's for the interactive session)
  let behavior = "";
  const personalityPath = resolve(WORKSPACE, "PERSONALITY.md");
  if (existsSync(personalityPath)) {
    try { behavior = readFileSync(personalityPath, "utf8"); } catch {}
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
<title>WhatsApp Agent</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',system-ui,sans-serif;background:#0a0d0b;color:#e0e0e0;height:100vh;overflow:hidden}

  /* LAYOUT */
  .app{display:grid;grid-template-columns:340px 1fr;grid-template-rows:auto 1fr;height:100vh}
  .header{grid-column:1/-1;background:#111613;border-bottom:1px solid #1e2620;padding:16px 28px;display:flex;align-items:center;gap:28px}
  .header h1{color:#FF7614;font-size:18px;font-weight:800;letter-spacing:-0.5px;white-space:nowrap}
  .header .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;animation:blink 3s ease-in-out infinite}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}
  .stats{display:flex;gap:20px;margin-left:auto}
  .stat{background:#161c18;border:1px solid #1e2620;border-radius:10px;padding:8px 16px;text-align:center;min-width:80px}
  .stat .n{font-size:20px;font-weight:800;color:#fff}
  .stat .l{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}

  /* SIDEBAR */
  .sidebar{background:#0f1311;border-right:1px solid #1e2620;display:flex;flex-direction:column;overflow:hidden}
  .tab-bar{display:flex;padding:4px;margin:12px 12px 0;background:#161c18;border-radius:10px}
  .tab{flex:1;padding:10px;font-size:12px;font-weight:700;color:#666;cursor:pointer;border-radius:8px;text-align:center;transition:all .2s}
  .tab.active{background:#FF7614;color:#000}
  .tab:hover:not(.active){color:#aaa}
  .contacts{flex:1;overflow-y:auto;padding:8px}
  .contacts::-webkit-scrollbar{width:4px}
  .contacts::-webkit-scrollbar-thumb{background:#2a3530;border-radius:4px}
  .contact{padding:14px;border-radius:12px;cursor:pointer;transition:all .15s;margin-bottom:2px;position:relative}
  .contact:hover{background:#161c18}
  .contact.active{background:#1a221d;border:1px solid #2a3530}
  .contact .row{display:flex;justify-content:space-between;align-items:center}
  .contact .name{font-weight:700;font-size:14px;color:#fff}
  .contact .time{font-size:11px;color:#555}
  .contact .preview{font-size:13px;color:#777;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
  .contact .badge{display:flex;align-items:center;gap:6px;margin-top:6px}
  .contact .pill{font-size:10px;font-weight:600;padding:2px 8px;border-radius:6px;background:#1e2620;color:#888}
  .contact .pill.esc{background:rgba(255,68,68,.15);color:#ff6666}
  .contact .unread{position:absolute;top:14px;right:14px;width:10px;height:10px;border-radius:50%;background:#FF7614}

  /* CHAT AREA */
  .chat{display:flex;flex-direction:column;background:#0a0d0b;overflow:hidden}
  .chat-header{padding:20px 28px;border-bottom:1px solid #1e2620;background:#111613;display:flex;align-items:center;gap:16px}
  .avatar{width:44px;height:44px;border-radius:12px;background:#FF7614;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;color:#000;flex-shrink:0}
  .chat-info .name{font-weight:800;font-size:16px;color:#fff}
  .chat-info .phone{font-size:13px;color:#666;margin-top:2px}
  .messages{flex:1;overflow-y:auto;padding:28px;display:flex;flex-direction:column;gap:8px}
  .messages::-webkit-scrollbar{width:4px}
  .messages::-webkit-scrollbar-thumb{background:#2a3530;border-radius:4px}
  .msg{max-width:65%;padding:12px 16px;border-radius:16px;font-size:14px;line-height:1.6;word-wrap:break-word;position:relative}
  .msg.in{background:#161c18;border:1px solid #1e2620;align-self:flex-start;border-bottom-left-radius:4px}
  .msg.out{background:#FF7614;color:#000;align-self:flex-end;border-bottom-right-radius:4px;font-weight:500}
  .msg .ts{font-size:10px;margin-top:6px;opacity:.5}
  .date-sep{text-align:center;padding:16px 0;font-size:11px;color:#444;font-weight:600}
  .empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#333;gap:12px}
  .empty .icon{font-size:48px;opacity:.3}
  .empty .text{font-size:15px}

  /* MOBILE */
  @media(max-width:768px){
    .app{grid-template-columns:1fr}
    .sidebar.hidden{display:none}
    .chat.hidden{display:none}
  }
</style>
</head><body>
<div class="app">
  <div class="header">
    <h1>WhatsApp Agent</h1>
    <div class="dot"></div>
    <div class="stats" id="stats"></div>
  </div>
  <div class="sidebar">
    <div class="tab-bar">
      <div class="tab active" id="tab-convos" onclick="switchTab('convos')">Conversations</div>
      <div class="tab" id="tab-esc" onclick="switchTab('esc')">Escalations</div>
    </div>
    <div class="contacts" id="sidebar-content"></div>
  </div>
  <div class="chat" id="chat">
    <div class="empty"><div class="icon">💬</div><div class="text">Select a conversation</div></div>
  </div>
</div>
<script>
let activeTab='convos', activeChat=null, pollTimer=null;
async function api(p){const r=await fetch(p);return r.json()}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function relTime(iso){
  if(!iso)return '';
  const d=new Date(iso),now=new Date(),diff=now-d,m=Math.floor(diff/60000);
  if(m<1)return 'now';if(m<60)return m+'m';
  const h=Math.floor(m/60);if(h<24)return h+'h';
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
}
async function loadStats(){
  const s=await api('/api/stats');
  document.getElementById('stats').innerHTML=[
    {n:s.active_today,l:'Active'},
    {n:s.messages_today,l:'Messages'},
    {n:s.open_escalations,l:'Escalations'},
    {n:s.total_contacts,l:'Contacts'}
  ].map(x=>'<div class="stat"><div class="n">'+x.n+'</div><div class="l">'+x.l+'</div></div>').join('');
}
function switchTab(tab){
  activeTab=tab;
  document.getElementById('tab-convos').classList.toggle('active',tab==='convos');
  document.getElementById('tab-esc').classList.toggle('active',tab==='esc');
  if(tab==='convos')loadConversations();else loadEscalations();
}
async function loadConversations(){
  const convos=await api('/api/conversations');
  const el=document.getElementById('sidebar-content');
  if(!convos.length){el.innerHTML='<div style="padding:32px;text-align:center;color:#444">No conversations yet</div>';return}
  el.innerHTML=convos.map(c=>{
    const init=(c.name||c.phone||'?')[0].toUpperCase();
    return '<div class="contact'+(activeChat===c.id?' active':'')+'" onclick="loadChat('+c.id+')">'+
      '<div class="row"><div class="name">'+esc(c.name||c.phone)+'</div><div class="time">'+relTime(c.last_seen)+'</div></div>'+
      '<div class="preview">'+esc(c.last_message||'')+'</div>'+
      '<div class="badge"><span class="pill">'+c.platform+'</span><span class="pill">'+c.message_count+' msgs</span></div>'+
    '</div>'}).join('');
}
async function loadEscalations(){
  const escs=await api('/api/escalations');
  const el=document.getElementById('sidebar-content');
  if(!escs.length){el.innerHTML='<div style="padding:32px;text-align:center;color:#444">No open escalations</div>';return}
  el.innerHTML=escs.map(e=>
    '<div class="contact" onclick="loadChat('+e.contact_id+')">'+
      '<div class="row"><div class="name">'+esc(e.name||e.phone)+'</div><div class="time">'+relTime(e.created_at)+'</div></div>'+
      '<div class="preview">'+esc(e.reason)+'</div>'+
      '<div class="badge"><span class="pill esc">ESCALATED</span><span class="pill">'+esc(e.context?.substring(0,40)||'')+'</span></div>'+
    '</div>').join('');
}
async function loadChat(id){
  activeChat=id;
  const data=await api('/api/conversations/'+id);
  const c=data.contact, msgs=data.messages;
  const init=(c.name||c.phone||'?')[0].toUpperCase();
  let lastDate='';
  const msgHTML=msgs.map(m=>{
    const d=m.created_at.substring(0,10);
    let sep='';
    if(d!==lastDate){lastDate=d;sep='<div class="date-sep">'+new Date(d).toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})+'</div>'}
    return sep+'<div class="msg '+(m.direction==='in'?'in':'out')+'">'+esc(m.text)+'<div class="ts">'+m.created_at.substring(11,16)+'</div></div>';
  }).join('');
  document.getElementById('chat').innerHTML=
    '<div class="chat-header"><div class="avatar">'+init+'</div><div class="chat-info"><div class="name">'+esc(c.name||c.phone)+'</div><div class="phone">'+esc(c.phone)+' &middot; '+c.message_count+' messages &middot; First seen '+relTime(c.first_seen)+'</div></div></div>'+
    '<div class="messages" id="msgs">'+msgHTML+'</div>';
  const el=document.getElementById('msgs');el.scrollTop=el.scrollHeight;
  if(activeTab==='convos')loadConversations();
  startPoll(id);
}
function startPoll(id){
  if(pollTimer)clearInterval(pollTimer);
  pollTimer=setInterval(()=>{if(activeChat===id)loadChat(id)},10000);
}
loadStats();loadConversations();
setInterval(loadStats,15000);
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
