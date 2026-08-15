import { sign, verify } from "hono/jwt";
import { env } from "../env.js";

export type TokenPayload = {
  sub: string;
  handle: string;
  exp: number;
};

export async function signToken(userId: string, handle: string) {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  return sign({ sub: userId, handle, exp } satisfies TokenPayload, env.jwtSecret, "HS256");
}

export async function readToken(token: string) {
  return (await verify(token, env.jwtSecret, "HS256")) as TokenPayload;
}
