import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "../db.js";
import { env } from "../env.js";

type Payload = { a: number; b: number; exp: number; n: string };

function sign(data: string) {
  return createHmac("sha256", env.jwtSecret).update(data).digest("base64url");
}

export function issueCaptcha() {
  const a = 2 + Math.floor(Math.random() * 11);
  const b = 2 + Math.floor(Math.random() * 11);
  const exp = Date.now() + 10 * 60 * 1000;
  const n = randomBytes(8).toString("hex");
  const payload = Buffer.from(JSON.stringify({ a, b, exp, n })).toString("base64url");
  return {
    token: `${payload}.${sign(payload)}`,
    question: `What is ${a} + ${b}?`,
  };
}

export function readCaptcha(token: string, answer: string) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return { error: "Solve the little puzzle to continue." };
  const expected = sign(payload);
  const left = Buffer.from(expected);
  const right = Buffer.from(sig);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { error: "Solve the little puzzle to continue." };
  }
  let data: Payload;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Payload;
  } catch {
    return { error: "Solve the little puzzle to continue." };
  }
  if (!data.exp || Date.now() > data.exp) return { error: "That puzzle expired. Try a new one." };
  const n = Number(String(answer).trim());
  if (!Number.isInteger(n) || n !== data.a + data.b) {
    return { error: "That answer is not quite right." };
  }
  return { nonce: data.n };
}

export async function consumeCaptcha(token: string, answer: string) {
  const solved = readCaptcha(token, answer);
  if ("error" in solved) return solved.error;
  const [used] = await sql<{ key: string }[]>`
    select key from rate_hits where key = ${`captcha:${solved.nonce}`} limit 1
  `;
  if (used) return "That puzzle already got used. Try a new one.";
  await sql`insert into rate_hits (key) values (${`captcha:${solved.nonce}`})`;
  return null;
}
