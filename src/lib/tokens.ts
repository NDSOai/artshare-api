import { randomBytes } from "node:crypto";

export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

export function newId(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}
