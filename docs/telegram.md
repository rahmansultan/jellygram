# Telegram setup

## 1. Create a bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot`.
3. Give it a display name, then a username ending in `bot`.
4. Copy the token. It looks like `123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.

Use a bot **dedicated to this application**. Two processes long-polling the same
token steal each other's updates, so pointing a second deployment — or a
development copy — at the same bot makes both behave erratically in a way that
is genuinely hard to diagnose.

Store the token with `npm run setup`, which prompts without echoing and writes
straight to `.env`, so it never lands in your shell history:

```bash
npm run setup
```

Or set `TELEGRAM_BOT_TOKEN` in `.env` by hand.

### Recommended BotFather settings

```
/setprivacy    → Enable    (the bot only sees commands and direct messages)
/setcommands
```

```
start - Register and see your Telegram ID
status - Your recent uploads
library - What you have in Jellyfin
help - What this bot accepts
```

`/setprivacy Enable` is the meaningful one. It stops the bot from receiving
every message in any group it is added to — this application is designed for
private chats and ignores group messages anyway, but there is no reason for the
messages to arrive at all.

## 2. Find your Telegram ID

Send `/start` to your bot. The reply ends with your numeric ID.

You need it twice:

- as **`TELEGRAM_ADMIN_CHAT_ID`** in `.env`, so health alerts have somewhere to
  go, and
- in the dashboard, when you add yourself as a media user.

Leave `TELEGRAM_ADMIN_CHAT_ID` empty and alerting still *works* — disk filling
up, backups failing, Jellyfin rejecting its key and repeated upload failures are
all detected — but every alert is then discarded. The Health page reports that
as a warning and the worker logs each dropped alert, so it is a choice rather
than a surprise.

## 3. Register users

An unknown Telegram ID gets "You are not registered" and nothing else: no file
is accepted, no row is written, nothing is downloaded. Registration is a
deliberate act by an administrator.

1. Create the person's account **in Jellyfin** first, as a normal user.
2. Have them send `/start` to the bot and tell you the ID it reports.
3. Dashboard → *Users* → *Add user*: name, Telegram ID, Jellyfin username.

See [jellyfin.md](jellyfin.md) for what that provisioning actually does.

## 4. Polling, not webhooks

The bot uses **long polling**. There is no webhook to register, no public URL to
expose, and no inbound port to open for the bot itself.

That is a deliberate fit for the target deployment — a home server behind NAT —
and it costs almost nothing at this scale. A webhook would need a public HTTPS
endpoint with a valid certificate, which is exactly the requirement this avoids.

The Mini App is the one part that *does* need a public HTTPS URL, and it is
optional. See [networking.md](networking.md).

## Bot commands

| Command | What it does |
| --- | --- |
| `/start` | Registers interest and reports your Telegram ID |
| `/status` | Your recent uploads and their states |
| `/library` | What you have in your Jellyfin libraries |
| `/help` | What the bot accepts, and the size limits in force |
| `/finish` | Close a hand-split multi-part upload (see [large-files.md](large-files.md)) |
| `/cancel` | Cancel your in-flight upload |

## What the bot accepts

- Video documents and videos, with an extension in `ALLOWED_EXTENSIONS`
  (`mp4,mkv,avi,mov` by default).
- From registered users only, in private chats only.
- Up to `MAX_FILE_SIZE_BYTES`, and only if the disk has room for it plus
  `DISK_SAFETY_MARGIN_BYTES` while still leaving `MIN_FREE_DISK_BYTES` free.

Everything else is refused with the reason. Subtitle files are refused
explicitly rather than silently ignored, because "nothing happened" is the worst
possible response to a file somebody just spent minutes uploading.

## The Mini App

Registering it is two steps, and the first is not in Telegram.

**1. Get an https URL.** Telegram refuses plain HTTP and refuses bare IP
addresses. [networking.md](networking.md) covers the options — a reverse proxy
with a real certificate, Cloudflare Tunnel, Tailscale Funnel — and what each one
exposes.

**2. Point `.env` at it and register the button:**

```env
MINIAPP_ENABLED=true
MINIAPP_URL=https://media.example.com/app
```

Restart the bot. It registers the menu button itself; there is nothing to
configure in BotFather.

If you would rather do it in BotFather anyway: `/mybots` → your bot → *Bot
Settings* → *Menu Button* → the same URL.

With `MINIAPP_URL` empty, no button is registered at all — which is better than
registering one that opens a page Telegram will not load.

How the authentication works, and why `initData` is verified rather than
trusted, is in [miniapp.md](miniapp.md).

## Account credentials (`TELEGRAM_API_ID` / `TELEGRAM_API_HASH`)

Two of the four large-file routes need these, and they are **not** bot
credentials — they cannot be derived from the bot token, and they identify *you*
rather than your bot.

Get them from [my.telegram.org](https://my.telegram.org) → *API development
tools*. `npm run setup` prompts for both (the hash is not echoed).

They are used by:

- the **local Bot API server**, which needs them to talk to Telegram at all, and
- **MTProto ingestion**, which authenticates as your own account.

Both are optional and both are off by default. See
[large-files.md](large-files.md), and read the account-safety notes there before
enabling MTProto.
