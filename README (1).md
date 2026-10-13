# Global VJ Studio Pro

This repository contains the GitHub Pages app and the Cloudflare Worker that securely uploads recordings to the user's Telegram private chat.

## Publish the app

Keep `index.html` in the repository root and enable GitHub Pages for the `main` branch root. The Worker URL is prefilled in the recording controls.

## Deploy the Cloudflare Worker

From `cloudflare-worker`, install dependencies, log in to Cloudflare, store the bot token as a secret, then deploy:

```powershell
npm.cmd install
npm.cmd exec -- wrangler --config wrangler.toml secret put TELEGRAM_BOT_TOKEN
npm.cmd exec -- wrangler --config wrangler.toml deploy
```

Enter the bot token only at Wrangler's terminal prompt. Never place it in `index.html`, `wrangler.toml`, or GitHub.

`cloudflare-worker/wrangler.toml` restricts browser requests to this GitHub Pages origin. Adjust `ALLOWED_ORIGINS` if the Pages URL changes. A user must start the bot chat and allow the bot to write before uploads can reach their private chat.

The Worker validates Telegram `initData`, rejects expired or altered sessions, and accepts videos up to 45 MiB. MP4 is sent as a Telegram video; WebM is sent as a file.

## Tests

```powershell
node --test
```

Run the test command from `cloudflare-worker`.