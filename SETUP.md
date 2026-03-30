# Setup Guide -- Follow These Steps

Welcome. I'll walk you through setting up your WhatsApp AI agent. The whole thing takes about 15 minutes.

## Step 1: Zernio Account

1. Go to https://zernio.com and create an account
2. Go to **Settings > API Keys** and create an API key
3. Tell me the API key when you have it (starts with `sk_`)

I'll save it to your `.env` file.

## Step 2: Activate Inbox

1. In Zernio, go to your plan settings
2. Activate the **Inbox add-on** (free 7-day trial available)
3. Tell me when it's done

This is required for all WhatsApp features.

## Step 3: Buy a WhatsApp Number

1. In Zernio, go to **Connections > WhatsApp > + Connect**
2. Choose **Get a US number** ($2/mo)
3. Confirm the purchase
4. Zernio auto-verifies with Meta (~30 seconds)
5. Click **Continue to WhatsApp setup**
6. Complete Meta's Embedded Signup (create or connect a WhatsApp Business Account)
7. Select your verified number and finish

Tell me the number you got and I'll configure everything.

## Step 4: Get Your IDs

I need two things from your Zernio dashboard:

1. **Profile ID** -- visible in your dashboard URL or via the API
2. **WhatsApp Account ID** -- go to Connections > WhatsApp > Settings

Tell me both and I'll save them to `.env`.

## Step 5: Configure Your Business

Open `BUSINESS.md` and fill in your details:
- Company name, services, pricing
- Hours of operation
- FAQ answers
- Booking process
- Brand voice

The more detail you add, the smarter your agent is. I can help you fill this in if you tell me about your business.

## Step 6: Start the Bridge

I'll run:
```
node bridge.mjs
```

This starts the webhook server that connects WhatsApp to me.

## Step 7: Expose to Internet

Pick one:
- **Cloudflare Tunnel** (easiest): `cloudflared tunnel --url http://localhost:18800`
- **Tailscale Funnel**: `tailscale funnel --bg 18800`
- **Public IP**: Just open port 18800

I'll help you set this up.

## Step 8: Connect the Webhook

1. In Zernio dashboard: **Settings > Webhooks > Add Endpoint**
2. URL: `https://your-tunnel-url/webhook`
3. Event: `message.received`
4. Save

Tell me when it's done and we'll test it.

## Step 9: Test

Text your WhatsApp number from your phone. I'll process the message and reply. If it works, we're live.

## Step 10: Run as a Background Service (Recommended for Servers)

> This step is for users running on a private server (VPS, dedicated server, etc.) that's always on. If you're running on your personal computer, you can skip this -- but the agent will only work while your computer is on and the bridge is running.

Setting up systemd makes the bridge:
- Run 24/7 in the background
- Start automatically on boot
- Auto-restart if it ever crashes

### Setup

1. Copy the service file:
```bash
sudo cp whatsapp-agent.service /etc/systemd/system/
```

2. Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable whatsapp-agent
sudo systemctl start whatsapp-agent
```

3. Verify it's running:
```bash
sudo systemctl status whatsapp-agent
```

### Useful Commands

| Command | What it does |
|---------|-------------|
| `sudo systemctl status whatsapp-agent` | Check if it's running |
| `sudo systemctl restart whatsapp-agent` | Restart it |
| `sudo systemctl stop whatsapp-agent` | Stop it |
| `sudo journalctl -u whatsapp-agent -f` | Watch live logs |

### Note

If you update `bridge.mjs`, restart the service for changes to take effect:
```bash
sudo systemctl restart whatsapp-agent
```

Changes to `BUSINESS.md` take effect on the next incoming message -- no restart needed.

## Step 11: Done

Once everything is working, you're set up. Your agent is live 24/7.

---

Tell me when you're ready to start with Step 1.
