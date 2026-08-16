import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] == null) process.env[match[1]] = match[2];
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT || 3001),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  messageSecret: required("MESSAGE_SECRET"),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  resendApiKey: process.env.RESEND_API_KEY || "",
  resendFrom: process.env.RESEND_FROM || "onboarding@resend.dev",
  bucketEndpoint: process.env.BUCKET_ENDPOINT || process.env.ENDPOINT || "",
  bucketName: process.env.BUCKET_NAME || process.env.BUCKET || "",
  bucketAccessKey: process.env.BUCKET_ACCESS_KEY_ID || process.env.ACCESS_KEY_ID || "",
  bucketSecretKey: process.env.BUCKET_SECRET_ACCESS_KEY || process.env.SECRET_ACCESS_KEY || "",
  bucketRegion: process.env.BUCKET_REGION || process.env.REGION || "auto",
  apiPublicUrl:
    process.env.API_PUBLIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ""),
  adminEmails: (process.env.ADMIN_EMAILS || "neilsaldanaobrien@gmail.com")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
};
