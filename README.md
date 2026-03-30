# WhatsApp AI Agent

![WhatsApp AI Agent](header.png)

Your own AI receptionist on WhatsApp. Powered by Claude Code. No per-message costs.

Customers text your WhatsApp number. An AI agent reads your business details, answers their questions, books appointments, and escalates what it can't handle.

## How It Works

```
Customer texts → Zernio receives → Bridge catches webhook → Claude Code replies → Customer gets answer
```

The bridge receives incoming WhatsApp messages via Zernio webhooks and uses `claude -p` (pipe mode) to generate responses based on your business knowledge in `BUSINESS.md`. No extra API key needed.

## Quick Start

```bash
git clone https://github.com/Trejon-888/whatsapp-agent.git
cd whatsapp-agent
claude
```

Claude Code reads `SETUP.md` and walks you through everything:

1. Create a Zernio account and get an API key
2. Buy a WhatsApp number ($2/mo)
3. Fill in your business details
4. Start the bridge
5. Connect the webhook
6. Test it

~15 minutes to set up.

## What's Inside

```
whatsapp-agent/
├── CLAUDE.md          # Agent behavior (interactive session)
├── PERSONALITY.md     # Agent personality (pipe mode replies)
├── SETUP.md           # Claude Code follows this on first run
├── BUSINESS.md        # Your business details (edit this)
├── bridge.mjs         # Webhook bridge + dashboard (zero dependencies)
├── .env.example       # API key template
├── whatsapp-agent.service  # systemd for 24/7 on a VPS
├── conversations/     # Chat history per customer (auto-created)
├── memory/            # Daily logs (auto-created)
└── escalations/       # Items needing human attention (auto-created)
```

## Dashboard

The bridge serves a live dashboard at `http://localhost:18800`. Browse conversations, read message threads, check escalations. Auto-refreshes every 15 seconds.

## Costs (on top of your Claude Code plan)

| Item | Cost |
|------|------|
| Zernio WhatsApp number | $2/mo |
| Zernio Inbox add-on | $10/mo |
| Server (VPS) | $4-10/mo |
| **Total** | **~$16-22/mo** |

## Prerequisites

- [Claude Code](https://claude.ai/claude-code) installed and logged in
- [Node.js](https://nodejs.org) 18+
- A way to expose a port (Cloudflare Tunnel, Tailscale, or a VPS)

## License

MIT

---

Built by [AI Growth Partner](https://aigrowthpartner.ai) | WhatsApp powered by [Zernio](https://zernio.com?atp=enriquemarq)
