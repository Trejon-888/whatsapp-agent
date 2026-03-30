#!/usr/bin/env node

/**
 * WhatsApp Agent Bridge
 *
 * Receives Zernio webhooks, calls claude -p, replies on WhatsApp.
 * Zero dependencies. File-based storage. Dashboard included.
 *
 * Usage:
 *   1. cp .env.example .env && fill in your keys
 *   2. node bridge.mjs
 *   3. Set Zernio webhook to: https://your-domain/webhook
 */

import http from "node:http";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";

// Load .env
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

const PORT = parseInt(process.env.BRIDGE_PORT || "18800");
const ZERNIO_API = "https://zernio.com/api/v1";
const ZERNIO_KEY = process.env.ZERNIO_API_KEY;
const WA_ACCOUNT_ID = process.env.ZERNIO_WA_ACCOUNT_ID;
const DIR = process.cwd();

if (!ZERNIO_KEY) { console.error("Missing ZERNIO_API_KEY in .env"); process.exit(1); }
if (!WA_ACCOUNT_ID) { console.error("Missing ZERNIO_WA_ACCOUNT_ID in .env"); process.exit(1); }

for (const d of ["conversations", "memory", "escalations"]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function ts() { return new Date().toISOString().substring(0, 19).replace("T", " "); }
function today() { return new Date().toISOString().substring(0, 10); }
function log(tag, msg) { console.log("[" + ts() + "] " + tag + " " + msg); }
function phoneFile(phone) { return phone.replace(/\+/g, "").replace(/\s/g, ""); }

// === FILE OPS ===

function appendConversation(phone, name, direction, text) {
  const file = resolve(DIR, "conversations", phoneFile(phone) + ".md");
  let existing = "";
  try { existing = readFileSync(file, "utf8"); } catch {}
  if (!existing) {
    existing = "# " + (name || phone) + "\n**Phone:** " + phone + "\n\n---\n";
  }
  const entry = "\n**" + (direction === "in" ? "Customer" : "Agent") + " [" + ts() + "]:** " + text + "\n";
  writeFileSync(file, existing + entry);
}

function appendMemory(phone, text, reply) {
  const file = resolve(DIR, "memory", today() + ".md");
  let existing = "";
  try { existing = readFileSync(file, "utf8"); } catch {
    existing = "# " + today() + "\n";
  }
  const entry = "\n- **" + ts().substring(11) + "** " + phone + ": " + text.substring(0, 80) + " -> " + reply.substring(0, 80) + "\n";
  writeFileSync(file, existing + entry);
}

function appendEscalation(phone, reason, context) {
  const file = resolve(DIR, "escalations", today() + ".md");
  let existing = "";
  try { existing = readFileSync(file, "utf8"); } catch {
    existing = "# Escalations " + today() + "\n";
  }
  const entry = "\n### " + ts() + " -- " + phone + "\n- **Reason:** " + reason + "\n- **Context:** " + context + "\n";
  writeFileSync(file, existing + entry);
}

function getHistory(phone) {
  const file = resolve(DIR, "conversations", phoneFile(phone) + ".md");
  try { return readFileSync(file, "utf8"); } catch { return ""; }
}

// === CLAUDE ===

function askClaude(phone, name, text) {
  appendConversation(phone, name, "in", text);

  let personality = "You are a WhatsApp business receptionist. Warm, helpful, concise.";
  try { personality = readFileSync(resolve(DIR, "PERSONALITY.md"), "utf8"); } catch {}

  let biz = "";
  try { biz = readFileSync(resolve(DIR, "BUSINESS.md"), "utf8"); } catch {}

  const history = getHistory(phone).split("\n").slice(-30).join("\n");

  const prompt = [
    personality,
    "",
    "Reply to the customer's latest message. Keep under 150 words.",
    "Output ONLY the reply text.",
    "If you need to escalate (custom pricing, complaints, things you can't handle):",
    "  Start with ESCALATE: followed by reason, then blank line, then reply.",
    "Otherwise just output the reply. No labels, no markdown formatting.",
    "",
    "=== BUSINESS ===",
    biz.substring(0, 3000),
    "",
    "=== CONVERSATION ===",
    history,
  ].join("\n");

  try {
    const reply = execSync("claude -p --output-format text", {
      input: prompt, encoding: "utf8", timeout: 90000, cwd: DIR,
    }).trim();

    let customerReply = reply;
    if (reply.startsWith("ESCALATE:")) {
      const parts = reply.split("\n\n");
      const reason = parts[0].replace("ESCALATE:", "").trim();
      customerReply = parts.slice(1).join("\n\n").trim() || "Thanks for reaching out! Someone from our team will follow up shortly.";
      appendEscalation(phone, reason, text);
      log("ESC", phone + ": " + reason);
    }

    appendConversation(phone, name, "out", customerReply);
    appendMemory(phone, text, customerReply);
    return customerReply;
  } catch (err) {
    log("ERR", "claude: " + (err.message?.substring(0, 100) || "unknown"));
    const fallback = "Hey! Got your message. Let me get back to you shortly.";
    appendConversation(phone, name, "out", fallback);
    return fallback;
  }
}

// === ZERNIO ===

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

// === DASHBOARD ===

function getConversationList() {
  const dir = resolve(DIR, "conversations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith(".md")).map(f => {
    const content = readFileSync(resolve(dir, f), "utf8");
    const lines = content.split("\n").filter(l => l.trim());
    const name = (content.match(/^# (.+)/m) || [])[1] || f.replace(".md", "");
    const phone = (content.match(/\*\*Phone:\*\* (.+)/m) || [])[1] || f.replace(".md", "");
    const msgs = content.match(/\*\*(Customer|Agent) \[/g) || [];
    const lastMsg = lines.filter(l => l.startsWith("**Customer") || l.startsWith("**Agent")).pop() || "";
    const lastText = lastMsg.replace(/\*\*.+?\*\*:?\s*/, "").substring(0, 80);
    const lastTime = (lastMsg.match(/\[(.+?)\]/) || [])[1] || "";
    const stat = statSync(resolve(dir, f));
    return { file: f, name, phone, count: msgs.length, lastText, lastTime, modified: stat.mtimeMs };
  }).sort((a, b) => b.modified - a.modified);
}

function getConversationMessages(file) {
  const content = readFileSync(resolve(DIR, "conversations", file), "utf8");
  const msgs = [];
  for (const line of content.split("\n")) {
    const m = line.match(/\*\*(Customer|Agent) \[(.+?)\]:\*\*\s*(.*)/);
    if (m) msgs.push({ direction: m[1] === "Customer" ? "in" : "out", time: m[2], text: m[3] });
  }
  return msgs;
}

function getEscalationList() {
  const dir = resolve(DIR, "escalations");
  if (!existsSync(dir)) return [];
  const items = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith(".md")).sort().reverse()) {
    const content = readFileSync(resolve(dir, f), "utf8");
    const blocks = content.split("### ").slice(1);
    for (const b of blocks) {
      const header = b.split("\n")[0];
      const reason = (b.match(/\*\*Reason:\*\* (.+)/) || [])[1] || "";
      const context = (b.match(/\*\*Context:\*\* (.+)/) || [])[1] || "";
      const phone = header.split("--")[1]?.trim() || "";
      const time = header.split("--")[0]?.trim() || "";
      items.push({ time, phone, reason, context });
    }
  }
  return items;
}

function getStats() {
  const convos = getConversationList();
  const todayFile = resolve(DIR, "memory", today() + ".md");
  let todayMsgs = 0;
  try { todayMsgs = (readFileSync(todayFile, "utf8").match(/^- \*\*/gm) || []).length; } catch {}
  const escDir = resolve(DIR, "escalations");
  let escCount = 0;
  try {
    const todayEsc = resolve(escDir, today() + ".md");
    escCount = (readFileSync(todayEsc, "utf8").match(/^### /gm) || []).length;
  } catch {}
  return { contacts: convos.length, messagesToday: todayMsgs, escalations: escCount };
}

function dashboardHTML() {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhatsApp Agent</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#0a0d0b;color:#e0e0e0;height:100vh;overflow:hidden}
.app{display:grid;grid-template-columns:340px 1fr;grid-template-rows:auto 1fr;height:100vh}
.header{grid-column:1/-1;background:#111613;border-bottom:1px solid #1e2620;padding:16px 28px;display:flex;align-items:center;gap:20px}
.header h1{color:#FF7614;font-size:18px;font-weight:800}
.dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;animation:blink 3s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}
.stats{display:flex;gap:16px;margin-left:auto}
.stat{background:#161c18;border:1px solid #1e2620;border-radius:10px;padding:8px 16px;text-align:center}
.stat .n{font-size:20px;font-weight:800;color:#fff}
.stat .l{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px}
.sidebar{background:#0f1311;border-right:1px solid #1e2620;display:flex;flex-direction:column;overflow:hidden}
.tab-bar{display:flex;padding:4px;margin:12px 12px 0;background:#161c18;border-radius:10px}
.tab{flex:1;padding:10px;font-size:12px;font-weight:700;color:#666;cursor:pointer;border-radius:8px;text-align:center;transition:all .2s}
.tab.active{background:#FF7614;color:#000}
.contacts{flex:1;overflow-y:auto;padding:8px}
.contacts::-webkit-scrollbar{width:4px}
.contacts::-webkit-scrollbar-thumb{background:#2a3530;border-radius:4px}
.contact{padding:14px;border-radius:12px;cursor:pointer;transition:all .15s;margin-bottom:2px}
.contact:hover{background:#161c18}
.contact.active{background:#1a221d;outline:1px solid #2a3530}
.contact .row{display:flex;justify-content:space-between;align-items:center}
.contact .name{font-weight:700;font-size:14px;color:#fff}
.contact .time{font-size:11px;color:#555}
.contact .preview{font-size:13px;color:#777;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
.contact .pills{display:flex;gap:6px;margin-top:6px}
.pill{font-size:10px;font-weight:600;padding:2px 8px;border-radius:6px;background:#1e2620;color:#888}
.pill.esc{background:rgba(255,68,68,.15);color:#ff6666}
.chat{display:flex;flex-direction:column;overflow:hidden}
.chat-header{padding:20px 28px;border-bottom:1px solid #1e2620;background:#111613;display:flex;align-items:center;gap:16px}
.avatar{width:44px;height:44px;border-radius:12px;background:#FF7614;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;color:#000;flex-shrink:0}
.chat-info .cname{font-weight:800;font-size:16px;color:#fff}
.chat-info .cphone{font-size:13px;color:#666;margin-top:2px}
.messages{flex:1;overflow-y:auto;padding:28px;display:flex;flex-direction:column;gap:8px}
.messages::-webkit-scrollbar{width:4px}
.messages::-webkit-scrollbar-thumb{background:#2a3530;border-radius:4px}
.msg{max-width:65%;padding:12px 16px;border-radius:16px;font-size:14px;line-height:1.6;word-wrap:break-word}
.msg.in{background:#161c18;border:1px solid #1e2620;align-self:flex-start;border-bottom-left-radius:4px}
.msg.out{background:#FF7614;color:#000;align-self:flex-end;border-bottom-right-radius:4px;font-weight:500}
.msg .mtime{font-size:10px;margin-top:6px;opacity:.5}
.msg.out .mtime{color:rgba(0,0,0,.5)}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#333;gap:12px}
.empty .eicon{font-size:48px;opacity:.3}
.editor{display:flex;flex-direction:column;height:100%;overflow:hidden}
.editor-header{padding:20px 28px;border-bottom:1px solid #1e2620;background:#111613;display:flex;align-items:center;justify-content:space-between}
.editor-header h2{font-size:16px;font-weight:800;color:#fff}
.editor-header .desc{font-size:12px;color:#666;margin-top:4px}
.save-btn{background:#FF7614;color:#000;border:none;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;transition:all .15s}
.save-btn:hover{background:#e06a10}
.save-btn.saved{background:#22c55e;color:#fff}
.editor textarea{flex:1;background:#0a0d0b;color:#e0e0e0;border:none;padding:28px;font-family:'JetBrains Mono','Fira Code',monospace;font-size:14px;line-height:1.7;resize:none;outline:none}
.editor textarea:focus{background:#0d100e}
.settings-list{padding:12px}
.settings-item{padding:16px;border-radius:12px;cursor:pointer;transition:all .15s;margin-bottom:4px;border:1px solid transparent}
.settings-item:hover{background:#161c18}
.settings-item.active{background:#1a221d;border-color:#2a3530}
.settings-item .sname{font-weight:700;font-size:14px;color:#fff}
.settings-item .sdesc{font-size:12px;color:#666;margin-top:4px}
@media(max-width:768px){.app{grid-template-columns:1fr}}
</style>
</head><body>
<div class="app">
<div class="header">
  <h1>WhatsApp Agent</h1><div class="dot"></div>
  <div class="stats" id="stats"></div>
</div>
<div class="sidebar">
  <div class="tab-bar">
    <div class="tab active" id="tab-c" onclick="switchTab('c')">Chats</div>
    <div class="tab" id="tab-e" onclick="switchTab('e')">Escalations</div>
    <div class="tab" id="tab-s" onclick="switchTab('s')">Settings</div>
  </div>
  <div class="contacts" id="list"></div>
</div>
<div class="chat" id="chat">
  <div class="empty"><div class="eicon">💬</div><div>Select a conversation</div></div>
</div>
</div>
<script>
let tab='c',activeFile=null,activeSettingsFile=null;
function h(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML}
async function api(p,opts){return(await fetch(p,opts)).json()}
async function loadStats(){
  const s=await api('/api/stats');
  document.getElementById('stats').innerHTML=[
    {n:s.contacts,l:'Contacts'},{n:s.messagesToday,l:'Today'},{n:s.escalations,l:'Escalations'}
  ].map(x=>'<div class="stat"><div class="n">'+x.n+'</div><div class="l">'+x.l+'</div></div>').join('');
}
function switchTab(t){
  tab=t;activeFile=null;activeSettingsFile=null;
  document.getElementById('tab-c').classList.toggle('active',t==='c');
  document.getElementById('tab-e').classList.toggle('active',t==='e');
  document.getElementById('tab-s').classList.toggle('active',t==='s');
  if(t==='c'){loadConvos();document.getElementById('chat').innerHTML='<div class="empty"><div class="eicon">💬</div><div>Select a conversation</div></div>';}
  else if(t==='e'){loadEscs();document.getElementById('chat').innerHTML='<div class="empty"><div class="eicon">💬</div><div>Select a conversation</div></div>';}
  else if(t==='s'){loadSettings();document.getElementById('chat').innerHTML='<div class="empty"><div class="eicon">⚙️</div><div>Select a file to edit</div></div>';}
}
async function loadConvos(){
  const cs=await api('/api/conversations');
  document.getElementById('list').innerHTML=cs.length?cs.map(c=>
    '<div class="contact'+(activeFile===c.file?' active':'')+'" onclick="openChat(\\''+c.file+'\\')">'+
    '<div class="row"><div class="name">'+h(c.name)+'</div><div class="time">'+h(c.lastTime)+'</div></div>'+
    '<div class="preview">'+h(c.lastText)+'</div>'+
    '<div class="pills"><span class="pill">'+c.count+' msgs</span></div></div>'
  ).join(''):'<div style="padding:32px;text-align:center;color:#444">No conversations yet</div>';
}
async function loadEscs(){
  const es=await api('/api/escalations');
  document.getElementById('list').innerHTML=es.length?es.map(e=>
    '<div class="contact" onclick="openChat(null)">'+
    '<div class="row"><div class="name">'+h(e.phone)+'</div><div class="time">'+h(e.time)+'</div></div>'+
    '<div class="preview">'+h(e.reason)+'</div>'+
    '<div class="pills"><span class="pill esc">ESCALATED</span><span class="pill">'+h(e.context?.substring(0,40))+'</span></div></div>'
  ).join(''):'<div style="padding:32px;text-align:center;color:#444">No escalations</div>';
}
function loadSettings(){
  const files=[
    {file:'PERSONALITY.md',name:'Personality',desc:'How the agent responds on WhatsApp'},
    {file:'BUSINESS.md',name:'Business Details',desc:'Services, pricing, hours, FAQ'}
  ];
  document.getElementById('list').innerHTML=files.map(f=>
    '<div class="settings-item'+(activeSettingsFile===f.file?' active':'')+'" onclick="openEditor(\\''+f.file+'\\')">'+
    '<div class="sname">'+f.name+'</div><div class="sdesc">'+f.desc+'</div></div>'
  ).join('');
}
async function openChat(file){
  if(!file)return;
  activeFile=file;
  const data=await api('/api/conversations/'+encodeURIComponent(file));
  const init=(data.name||'?')[0].toUpperCase();
  document.getElementById('chat').innerHTML=
    '<div class="chat-header"><div class="avatar">'+init+'</div><div class="chat-info"><div class="cname">'+h(data.name)+'</div><div class="cphone">'+h(data.phone)+' &middot; '+data.messages.length+' messages</div></div></div>'+
    '<div class="messages" id="msgs">'+data.messages.map(m=>
      '<div class="msg '+(m.direction==='in'?'in':'out')+'">'+h(m.text)+'<div class="mtime">'+h(m.time)+'</div></div>'
    ).join('')+'</div>';
  document.getElementById('msgs').scrollTop=99999;
  if(tab==='c')loadConvos();
}
async function openEditor(file){
  activeSettingsFile=file;
  loadSettings();
  const data=await api('/api/file/'+encodeURIComponent(file));
  const names={'PERSONALITY.md':'Agent Personality','BUSINESS.md':'Business Details'};
  const descs={'PERSONALITY.md':'Controls how the agent responds to WhatsApp messages. Changes take effect on the next incoming message.','BUSINESS.md':'Everything the agent knows about your business. Services, pricing, hours, FAQ, brand voice.'};
  document.getElementById('chat').innerHTML=
    '<div class="editor">'+
    '<div class="editor-header"><div><h2>'+h(names[file]||file)+'</h2><div class="desc">'+h(descs[file]||file)+'</div></div>'+
    '<button class="save-btn" onclick="saveFile(\\''+file+'\\')">Save</button></div>'+
    '<textarea id="editor-content">'+h(data.content)+'</textarea></div>';
}
async function saveFile(file){
  const content=document.getElementById('editor-content').value;
  const btn=document.querySelector('.save-btn');
  btn.textContent='Saving...';
  await fetch('/api/file/'+encodeURIComponent(file),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content})});
  btn.textContent='Saved!';btn.classList.add('saved');
  setTimeout(()=>{btn.textContent='Save';btn.classList.remove('saved')},2000);
}
loadStats();loadConvos();
setInterval(()=>{loadStats();if(tab==='c')loadConvos();if(activeFile)openChat(activeFile)},15000);
</script>
</body></html>`;
}

// === SERVER ===

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ...getStats() }));
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(dashboardHTML());
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getStats()));
  }

  if (req.method === "GET" && url.pathname === "/api/conversations") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getConversationList()));
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/conversations/")) {
    const file = decodeURIComponent(url.pathname.replace("/api/conversations/", ""));
    if (!file.endsWith(".md") || file.includes("..")) {
      res.writeHead(400); return res.end("Bad request");
    }
    const msgs = getConversationMessages(file);
    const content = readFileSync(resolve(DIR, "conversations", file), "utf8");
    const name = (content.match(/^# (.+)/m) || [])[1] || file.replace(".md", "");
    const phone = (content.match(/\*\*Phone:\*\* (.+)/m) || [])[1] || "";
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ name, phone, messages: msgs }));
  }

  if (req.method === "GET" && url.pathname === "/api/escalations") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getEscalationList()));
  }

  // File read/write (settings editor)
  const EDITABLE = ["PERSONALITY.md", "BUSINESS.md"];
  if (req.method === "GET" && url.pathname.startsWith("/api/file/")) {
    const file = decodeURIComponent(url.pathname.replace("/api/file/", ""));
    if (!EDITABLE.includes(file)) { res.writeHead(403); return res.end("Not editable"); }
    let content = "";
    try { content = readFileSync(resolve(DIR, file), "utf8"); } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ file, content }));
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/file/")) {
    const file = decodeURIComponent(url.pathname.replace("/api/file/", ""));
    if (!EDITABLE.includes(file)) { res.writeHead(403); return res.end("Not editable"); }
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        writeFileSync(resolve(DIR, file), data.content);
        log("EDIT", file + " updated via dashboard");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

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
  log("START", "WhatsApp Agent on port " + PORT);
  log("START", "Dashboard at http://localhost:" + PORT);
});
