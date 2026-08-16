import { sign, verify } from "hono/jwt";
import { env } from "../env.js";

export type TokenPayload = {
  sub: string;
  handle: string;
  exp: number;
  ver: number;
};

export async function signToken(user: { id: string; handle: string; token_version?: number }) {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7;
  return sign(
    { sub: user.id, handle: user.handle, exp, ver: user.token_version ?? 0 } satisfies TokenPayload,
    env.jwtSecret,
    "HS256",
  );
}

export async function readToken(token: string) {
  return (await verify(token, env.jwtSecret, "HS256")) as TokenPayload;
}

export function tokenMatchesUser(payload: TokenPayload, user: { token_version?: number }) {
  return (payload.ver ?? 0) === (user.token_version ?? 0);
}
