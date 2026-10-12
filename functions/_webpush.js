// Web Push без сторонних библиотек: VAPID (RFC 8292) + шифрование aes128gcm (RFC 8291).
// Работает на WebCrypto — и в Cloudflare Workers/Pages Functions, и в Node 20 (для тестов).

const enc = new TextEncoder();

export function b64urlToBytes(text) {
  const base = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base + "=".repeat((4 - (base.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) bin += String.fromCharCode(view[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// VAPID-ключ: публичный — 65 байт base64url, приватный — JWK (d, x, y) строкой или объектом.
export async function vapidHeaders(endpoint, vapid, now = Date.now()) {
  const jwk = typeof vapid.privateJwk === "string" ? JSON.parse(vapid.privateJwk) : vapid.privateJwk;
  const key = await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["sign"], ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: vapid.subject || "mailto:rasp-is2-241@users.noreply.github.com",
  };
  const body = bytesToB64url(enc.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${body}`));
  return { Authorization: `vapid t=${header}.${body}.${bytesToB64url(signature)}, k=${vapid.publicKey}` };
}

// Шифрует payload для подписки { endpoint, keys: { p256dh, auth } }. Возвращает тело запроса.
export async function encryptPayload(subscription, payload, { salt, serverKeys } = {}) {
  const uaPublic = b64urlToBytes(subscription.keys.p256dh);
  const authSecret = b64urlToBytes(subscription.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("bad subscription keys");
  const local = serverKeys || (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const saltBytes = salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(saltBytes, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(saltBytes, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const data = typeof payload === "string" ? enc.encode(payload) : payload;
  const plain = concat(data, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(saltBytes, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// Отправка. Возвращает { ok, status, gone } — gone: подписка больше не действует (404/410).
export async function sendPush(subscription, payload, vapid, { ttl = 900, urgency = "high", fetchImpl = fetch } = {}) {
  const body = await encryptPayload(subscription, JSON.stringify(payload));
  const headers = {
    ...(await vapidHeaders(subscription.endpoint, vapid)),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(ttl),
    Urgency: urgency,
  };
  let response;
  try {
    response = await fetchImpl(subscription.endpoint, { method: "POST", headers, body });
  } catch (error) {
    return { ok: false, status: 0, gone: false, error: String(error?.message || error) };
  }
  const status = response.status;
  let text = "";
  if (status >= 300) {
    try {
      text = (await response.text()).slice(0, 200);
    } catch {
      text = "";
    }
  }
  return { ok: status >= 200 && status < 300, status, gone: status === 404 || status === 410, error: text };
}
