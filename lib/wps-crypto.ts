import { WpsError } from "./wps-upstream.ts";

export type Sealed = { cipher: string; iv: string };
const encoder = new TextEncoder();

function bytesToBase64(value: Uint8Array): string {
  let out = "";
  for (const byte of value) out += String.fromCharCode(byte);
  return btoa(out);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export function keyReady(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d]{64}$/i.test(value);
}

async function importKey(keyHex: string) {
  if (!keyReady(keyHex)) throw new WpsError("SERVICE_NOT_READY", "连接服务的加密配置尚未就绪。", 503);
  const key = Uint8Array.from(keyHex.match(/../g)!, (part) => parseInt(part, 16));
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function context(userId: string, purpose: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(["wps-cloud-bridge", 1, userId, purpose]));
}

export async function seal(value: string, keyHex: string, userId: string, purpose: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: context(userId, purpose) },
    await importKey(keyHex), encoder.encode(value),
  );
  return { cipher: bytesToBase64(new Uint8Array(cipher)), iv: bytesToBase64(iv) };
}

export async function unseal(value: Sealed, keyHex: string, userId: string, purpose: string): Promise<string> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(value.iv), additionalData: context(userId, purpose) },
      await importKey(keyHex), base64ToBytes(value.cipher),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new WpsError("CREDENTIAL_UNAVAILABLE", "保存的连接无法使用，请在连接页面重新授权。", 409);
  }
}
