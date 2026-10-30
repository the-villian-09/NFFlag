import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { createApp } from "../src/app.js";
import { MemoryEmailSender, setEmailSender } from "../src/lib/email.js";

export const ORIGIN = "http://localhost:3000";
export const app = createApp();
export const mail = new MemoryEmailSender();
setEmailSender(mail);

export type Agent = TestAgent;

export function agent(): Agent {
  return request.agent(app).set("Origin", ORIGIN) as unknown as Agent;
}

export function uniqueEmail(prefix = "user") {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
}

export const PASSWORD = "correct-horse-battery";

/** Signs up. No email confirmation step: the agent is signed in immediately. */
export async function signUp(a: Agent, email: string, name = "Test Parent") {
  const res = await a.post("/api/auth/sign-up/email").send({ email, password: PASSWORD, name });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${JSON.stringify(res.body)}`);
}

/** Opt in to emailed sign-in codes: confirm one code while signed in. */
export async function enrollEmailMfa(a: Agent, email: string) {
  const send = await a.post("/api/auth/two-factor/send-otp").send({});
  if (send.status !== 200) throw new Error(`send-otp failed: ${send.status} ${JSON.stringify(send.body)}`);
  const code = codeFromEmail(email);
  const verify = await a.post("/api/auth/two-factor/verify-otp").send({ code });
  if (verify.status !== 200) throw new Error(`verify-otp failed: ${verify.status} ${JSON.stringify(verify.body)}`);
}

export function codeFromEmail(email: string) {
  const msg = mail.last(email, "auth.login_code");
  if (!msg) throw new Error("no login code email");
  return msg.text.match(/\b(\d{6})\b/)![1]!;
}

/* ---- RFC 6238 TOTP, for tests acting as an authenticator app ---- */

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error("bad base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpFromUri(uri: string, at = Date.now()) {
  const secret = new URL(uri).searchParams.get("secret")!;
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return bin.toString().padStart(6, "0");
}

/** Opt in to an authenticator app (TOTP), confirmed with a live code. */
export async function enrollTotp(a: Agent) {
  const enable = await a.post("/api/auth/two-factor/enable").send({ password: PASSWORD });
  if (enable.status !== 200) throw new Error(`enable failed: ${enable.status} ${JSON.stringify(enable.body)}`);
  const uri: string = enable.body.totpURI;
  const backupCodes: string[] = enable.body.backupCodes;
  const verify = await a.post("/api/auth/two-factor/verify-totp").send({ code: totpFromUri(uri) });
  if (verify.status !== 200) throw new Error(`verify-totp failed: ${verify.status} ${JSON.stringify(verify.body)}`);
  return { uri, backupCodes };
}
