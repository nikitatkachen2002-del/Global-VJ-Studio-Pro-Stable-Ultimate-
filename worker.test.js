import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { validateTelegramInitData } from "../src/index.js";

const botToken = "123456:test-token-for-unit-tests";
const origin = "https://nikitatkachen2002-del.github.io";

async function signInitData(fields) {
    const params = new URLSearchParams(fields);
    const dataCheckString = Array.from(params.entries())
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode("WebAppData"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const secret = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(botToken));
    const signingKey = await crypto.subtle.importKey(
        "raw",
        secret,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, encoder.encode(dataCheckString)));
    params.set("hash", Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join(""));
    return params.toString();
}

test("accepts a valid, current Telegram initData signature", async () => {
    const now = 1_800_000_000;
    const initData = await signInitData([
        ["auth_date", String(now)],
        ["user", JSON.stringify({ id: 12345, first_name: "Test" })]
    ]);

    assert.equal((await validateTelegramInitData(initData, botToken, now)).id, 12345);
});

test("rejects tampered, expired, duplicated, and unsafe user data", async () => {
    const now = 1_800_000_000;
    const signed = await signInitData([
        ["auth_date", String(now)],
        ["user", JSON.stringify({ id: 12345 })]
    ]);

    assert.equal(await validateTelegramInitData(`${signed}&user=%7B%22id%22%3A999%7D`, botToken, now), null);
    assert.equal(await validateTelegramInitData(signed, botToken, now + 86_401), null);
    assert.equal(await validateTelegramInitData(`${signed}&auth_date=${now}`, botToken, now), null);

    const unsafeUser = await signInitData([
        ["auth_date", String(now)],
        ["user", JSON.stringify({ id: "12345" })]
    ]);
    assert.equal(await validateTelegramInitData(unsafeUser, botToken, now), null);
});

test("answers CORS preflight only for configured app origins", async () => {
    const env = { ALLOWED_ORIGINS: `${origin},https://example.invalid` };
    const response = await worker.fetch(new Request("https://worker.invalid/api/send-video", {
        method: "OPTIONS",
        headers: { Origin: origin }
    }), env);

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
});

test("rejects oversized uploads before reading the body", async () => {
    const response = await worker.fetch(new Request("https://worker.invalid/api/send-video", {
        method: "POST",
        headers: {
            Origin: origin,
            "Content-Length": String(48 * 1024 * 1024 + 1),
            "X-Telegram-Init-Data": "invalid"
        }
    }), {
        ALLOWED_ORIGINS: origin,
        TELEGRAM_BOT_TOKEN: botToken
    });

    assert.equal(response.status, 413);
});

test("sends an authenticated WebM recording to the verified user's chat", async () => {
    const now = Math.floor(Date.now() / 1000);
    const initData = await signInitData([
        ["auth_date", String(now)],
        ["user", JSON.stringify({ id: 12345, first_name: "Test" })]
    ]);
    const body = new FormData();
    body.set("video", new File([new Uint8Array([1, 2, 3])], "capture.webm", { type: "video/webm" }));
    const originalFetch = globalThis.fetch;
    let sentUrl;
    let sentForm;

    globalThis.fetch = async (url, options) => {
        sentUrl = String(url);
        sentForm = options.body;
        return Response.json({ ok: true, result: { message_id: 77 } });
    };

    try {
        const response = await worker.fetch(new Request("https://worker.invalid/api/send-video", {
            method: "POST",
            headers: { Origin: origin, "X-Telegram-Init-Data": initData },
            body
        }), {
            ALLOWED_ORIGINS: origin,
            TELEGRAM_BOT_TOKEN: botToken
        });
        const result = await response.json();

        assert.equal(response.status, 200);
        assert.deepEqual(result, { ok: true, messageId: 77 });
        assert.match(sentUrl, /\/sendDocument$/);
        assert.equal(sentForm.get("chat_id"), "12345");
        assert.equal(sentForm.get("document").name, "capture.webm");
    } finally {
        globalThis.fetch = originalFetch;
    }
});