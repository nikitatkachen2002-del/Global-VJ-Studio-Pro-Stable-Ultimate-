# VJ Studio Telegram Upload Worker

The Worker validates Telegram Mini App `initData` and sends the uploaded recording to the authenticated user's private chat. The bot token is stored as a Cloudflare secret and is never sent to the browser.

## Deploy

Run these commands in this directory:

```powershell
npm.cmd install
npx.cmd wrangler login
npx.cmd wrangler secret put TELEGRAM_BOT_TOKEN
npx.cmd wrangler deploy
```

When prompted for `TELEGRAM_BOT_TOKEN`, enter the token directly in the terminal. Do not put it in the HTML file, `wrangler.toml`, chat, or source control.

The deploy output includes a URL similar to `https://vj-studio-telegram-upload.<account-subdomain>.workers.dev`. In the app's **Cloudflare Worker URL** field, use that URL with `/api/send-video` appended.

The configured origin allowlist is in `wrangler.toml`. Update `ALLOWED_ORIGINS` there if the app is served from a different origin. Telegram must already have a private chat with the bot; the app requests write permission when Telegram reports that it is needed.

The Worker accepts recordings up to 45 MiB. MP4 files are sent with Telegram's `sendVideo`; WebM recordings are sent as files with `sendDocument` so they are not rejected as unsupported video containers.

## Test

```powershell
node --test
```