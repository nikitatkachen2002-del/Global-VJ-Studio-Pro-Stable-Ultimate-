const MAX_VIDEO_BYTES = 45 * 1024 * 1024;
const MAX_REQUEST_BYTES = 48 * 1024 * 1024;
const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;
const encoder = new TextEncoder();

function allowedOrigins(env) {
    return new Set((env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean));
}

function jsonResponse(body, status, origin) {
    const headers = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Vary": "Origin"
    });

    if (origin) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data");
        headers.set("Access-Control-Max-Age", "600");
    }

    const responseBody = status === 204 ? null : JSON.stringify(body);
    return new Response(responseBody, { status, headers });
}

function bytesToHex(bytes) {
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
        difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
}

export async function validateTelegramInitData(initData, botToken, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (typeof initData !== "string" || !initData || initData.length > 8192 || !botToken) return null;

    const params = new URLSearchParams(initData);
    const entries = Array.from(params.entries());
    if (entries.length !== new Set(entries.map(([key]) => key)).size) return null;

    const receivedHash = params.get("hash");
    const authDateText = params.get("auth_date");
    const userText = params.get("user");
    if (!receivedHash || !/^[a-f\d]{64}$/i.test(receivedHash) || !authDateText || !userText) return null;

    const authDate = Number(authDateText);
    if (!Number.isSafeInteger(authDate) || authDate > nowSeconds + 60 || nowSeconds - authDate > MAX_AUTH_AGE_SECONDS) return null;

    let user;
    try {
        user = JSON.parse(userText);
    } catch {
        return null;
    }
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot === true) return null;

    const dataCheckString = entries
        .filter(([key]) => key !== "hash")
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");

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
    const expectedHash = bytesToHex(await crypto.subtle.sign("HMAC", signingKey, encoder.encode(dataCheckString)));

    return constantTimeEqual(expectedHash, receivedHash.toLowerCase()) ? user : null;
}

async function sendVideoToTelegram(request, env, origin) {
    if (!env.TELEGRAM_BOT_TOKEN) {
        return jsonResponse({ error: "Worker is missing its Telegram bot token secret." }, 503, origin);
    }

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_REQUEST_BYTES) {
        return jsonResponse({ error: "Request is too large. Maximum video size is 45 MiB." }, 413, origin);
    }

    const user = await validateTelegramInitData(
        request.headers.get("X-Telegram-Init-Data"),
        env.TELEGRAM_BOT_TOKEN
    );
    if (!user) return jsonResponse({ error: "Telegram session is invalid or expired." }, 401, origin);

    let form;
    try {
        form = await request.formData();
    } catch {
        return jsonResponse({ error: "Expected a multipart video upload." }, 400, origin);
    }

    const video = form.get("video");
    if (!video || typeof video.size !== "number" || typeof video.arrayBuffer !== "function") {
        return jsonResponse({ error: "No video file was uploaded." }, 400, origin);
    }
    if (video.size === 0 || video.size > MAX_VIDEO_BYTES) {
        return jsonResponse({ error: "Video must be between 1 byte and 45 MiB." }, 413, origin);
    }
    if (!video.type.startsWith("video/")) {
        return jsonResponse({ error: "The uploaded file must have a video MIME type." }, 415, origin);
    }

    const filename = (video.name || "VJ_Studio.webm")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 100) || "VJ_Studio.webm";
    const method = video.type.startsWith("video/mp4") ? "sendVideo" : "sendDocument";
    const telegramForm = new FormData();
    telegramForm.set("chat_id", String(user.id));
    telegramForm.set("caption", "Global VJ Studio recording");
    telegramForm.set(method === "sendVideo" ? "video" : "document", video, filename);

    let telegramResponse;
    try {
        telegramResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
            method: "POST",
            body: telegramForm,
            signal: AbortSignal.timeout(55_000)
        });
    } catch {
        return jsonResponse({ error: "Could not reach the Telegram Bot API." }, 502, origin);
    }

    const telegramResult = await telegramResponse.json().catch(() => null);
    if (!telegramResponse.ok || !telegramResult || telegramResult.ok !== true) {
        return jsonResponse({ error: "Telegram rejected the upload. Start the bot chat and try again." }, 502, origin);
    }

    return jsonResponse({ ok: true, messageId: telegramResult.result.message_id }, 200, origin);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get("Origin");
        const origins = allowedOrigins(env);

        if (!origin || !origins.has(origin)) {
            return jsonResponse({ error: "Origin is not allowed." }, 403, null);
        }
        if (url.pathname !== "/api/send-video") {
            return jsonResponse({ error: "Not found." }, 404, origin);
        }
        if (request.method === "OPTIONS") return jsonResponse({}, 204, origin);
        if (request.method !== "POST") {
            return jsonResponse({ error: "Method not allowed." }, 405, origin);
        }

        return sendVideoToTelegram(request, env, origin);
    }
};