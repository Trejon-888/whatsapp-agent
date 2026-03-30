# First Time Setup

You're setting up a WhatsApp AI agent. Walk the user through each step. Don't skip ahead. Wait for confirmation before moving on.

## Step 1: Check Prerequisites

Before starting, verify:

```bash
node --version    # Need 18+
claude --version  # Need Claude Code installed
```

If either is missing, tell the user what to install and wait.

## Step 2: Zernio Account + API Key

Tell the user:

> Go to **zernio.com** and create an account. Then go to **Settings > API Keys** and create a new key. Paste it here when you have it.

When they give you the key (starts with `sk_`), create the `.env` file:

```
ZERNIO_API_KEY=<their key>
```

## Step 3: Activate Inbox Add-on

Tell the user:

> In Zernio, go to your plan settings and activate the **Inbox add-on**. There's a free 7-day trial. Tell me when it's done.

Wait for confirmation.

## Step 4: Buy a WhatsApp Number

Tell the user:

> In Zernio, go to **Connections > WhatsApp > + Connect > Get a US number**. It's $2/month. Complete the purchase, then finish Meta's WhatsApp Business setup when prompted. Tell me the phone number you got.

Wait for the number.

## Step 5: Get Account IDs

Tell the user:

> I need two IDs from your Zernio dashboard:
> 1. **Profile ID** -- visible in your dashboard URL
> 2. **WhatsApp Account ID** -- go to Connections > WhatsApp > click Settings on your connected account
>
> Paste both here.

When they provide them, update `.env`:

```
ZERNIO_API_KEY=<from step 2>
ZERNIO_PROFILE_ID=<their profile id>
ZERNIO_WA_ACCOUNT_ID=<their wa account id>
```

## Step 6: Business Details

Tell the user:

> Now let's fill in BUSINESS.md. This is everything your agent knows. Tell me about your business:
> - Company name
> - What you do / sell
> - Pricing
> - Hours
> - Common questions customers ask
> - How you want the agent to sound

Take their answers and write them into `BUSINESS.md` in a clean format.

## Step 7: Start the Bridge

Run:

```bash
node bridge.mjs &
```

Check it started: `curl -s http://localhost:18800/health`

If it's running, tell the user the bridge is live.

## Step 8: Expose to Internet

Tell the user:

> The bridge needs to be reachable from the internet so Zernio can send you messages. Pick one:
>
> **Option A (easiest):** Cloudflare Tunnel
> ```
> cloudflared tunnel --url http://localhost:18800
> ```
>
> **Option B:** Tailscale Funnel
> ```
> tailscale funnel --bg 18800
> ```
>
> **Option C:** If your server has a public IP, just open port 18800.
>
> Run the command and give me the public URL you get.

When they give you the URL, confirm it ends with the domain (not localhost).

## Step 9: Connect Webhook

Tell the user:

> Go to your Zernio dashboard: **Settings > Webhooks > Add Endpoint**
> - URL: `<their public URL>/webhook`
> - Event: `message.received`
> - Save it.
>
> Tell me when it's done.

Wait for confirmation.

## Step 10: Test

Tell the user:

> Text your WhatsApp number from your phone. Say anything. I'll check if the bridge catches it.

Wait a few seconds, then check the bridge health and look for new files in `conversations/`.

If it works, tell them. If not, check the bridge log and troubleshoot.

## Step 11: Done

Once the test works:

1. Delete this file: `rm SETUP.md`
2. Tell the user:

> Your WhatsApp AI agent is live. Customers can text your number and get instant replies powered by Claude Code.
>
> **Commands you can use:**
> - "Show conversations" -- see what customers are asking
> - "Check escalations" -- see what needs your attention
> - "Update business info" -- change what the agent knows
> - "How's the agent?" -- check if the bridge is running
> - "Stop the agent" / "Restart the agent" -- control the bridge
>
> The bridge runs in the background. Keep this terminal open to manage your agent.
