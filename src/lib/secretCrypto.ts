import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";

const SECRET_PREFIX = "enc:v1:";

const asBase64 = (value: Buffer): string => value.toString("base64");
const fromBase64 = (value: string): Buffer => Buffer.from(value, "base64");

export const canEncryptSecrets = (): boolean => Boolean(config.contentEncryptionKey);

export const encryptSecret = (plaintext: string): string | null => {
  const key = config.contentEncryptionKey;
  if (!key) return null;
  const normalized = String(plaintext ?? "");
  if (normalized.length < 1) return "";

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${asBase64(iv)}.${asBase64(tag)}.${asBase64(encrypted)}`;
};

export const decryptSecret = (value: string): string | null => {
  const raw = String(value ?? "");
  if (raw.length < 1) return "";

  if (!raw.startsWith(SECRET_PREFIX)) {
    // Legacy plaintext format.
    return raw;
  }

  const key = config.contentEncryptionKey;
  if (!key) return null;

  const payload = raw.slice(SECRET_PREFIX.length);
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) return null;

  try {
    const iv = fromBase64(ivB64);
    const tag = fromBase64(tagB64);
    const data = fromBase64(dataB64);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
};
