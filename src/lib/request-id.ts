import { newId } from "./tokens.js";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

export const REQUEST_ID = /^req_[a-f0-9]{16}$/i;

export function parseRequestId(value: unknown) {
  const text = String(value ?? "").trim();
  return REQUEST_ID.test(text) ? text.toLowerCase() : "";
}

export function mintRequestId(incoming?: string | null) {
  return parseRequestId(incoming) || newId("req");
}

export function parseHttpStatus(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 100 || n > 599) return null;
  return n;
}

export function parseRoute(value: unknown) {
  const text = String(value ?? "").trim();
  const match = text.match(/^([A-Z]{3,7})\s+(\/\S*)$/i);
  if (!match) return "";
  const path = match[2].split("?")[0].slice(0, 120);
  if (!path.startsWith("/")) return "";
  return `${match[1].toUpperCase()} ${path}`;
}
