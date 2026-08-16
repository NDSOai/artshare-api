import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../env.js";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/aac",
  "audio/x-m4a",
]);

const LIMITS = {
  image: 3 * 1024 * 1024,
  music: 20 * 1024 * 1024,
};

export function isStorageReady() {
  return Boolean(env.bucketEndpoint && env.bucketName && env.bucketAccessKey && env.bucketSecretKey);
}

function client() {
  if (!isStorageReady()) return null;
  const region = !env.bucketRegion || env.bucketRegion === "auto" ? "us-east-1" : env.bucketRegion;
  return new S3Client({
    region,
    endpoint: env.bucketEndpoint,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: env.bucketAccessKey,
      secretAccessKey: env.bucketSecretKey,
    },
  });
}

function guessType(name: string, kind?: string) {
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  if (/\.mp3$/i.test(name)) return "audio/mpeg";
  if (/\.(m4a|aac)$/i.test(name)) return "audio/mp4";
  return kind === "music" ? "audio/mpeg" : kind === "image" ? "image/jpeg" : "application/octet-stream";
}

export function publicMediaUrl(key: string | null | undefined) {
  if (!key) return undefined;
  if (key.startsWith("http://") || key.startsWith("https://")) return key;
  const base = env.apiPublicUrl.replace(/\/$/, "");
  return base ? `${base}/media/${key}` : `/media/${key}`;
}

export function isSafeMediaKey(key: string) {
  return /^(works|avatars|banners)\/[a-zA-Z0-9._/-]+$/.test(key) && !key.includes("..");
}

export function parseDataUrl(dataUrl: string) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  const type = match[1];
  const bytes = Buffer.from(match[2], "base64");
  if (!type.startsWith("image/") || bytes.length === 0 || bytes.length > 800_000) return null;
  return { type, bytes };
}

export async function putAvatarFile(userId: string, file: { type: string; bytes: Buffer }) {
  const s3 = client();
  if (!s3) throw new Error("File storage is not ready yet.");
  const ext = file.type.includes("png") ? "png" : file.type.includes("webp") ? "webp" : "jpg";
  const key = `avatars/${userId}.${ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: env.bucketName,
      Key: key,
      Body: file.bytes,
      ContentType: file.type || "image/jpeg",
    }),
  );
  return key;
}

export async function putBannerFile(userId: string, file: { type: string; bytes: Buffer }) {
  const s3 = client();
  if (!s3) throw new Error("File storage is not ready yet.");
  const ext = file.type.includes("png") ? "png" : file.type.includes("webp") ? "webp" : "jpg";
  const key = `banners/${userId}.${ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: env.bucketName,
      Key: key,
      Body: file.bytes,
      ContentType: file.type || "image/jpeg",
    }),
  );
  return key;
}

function extFor(type: string, kind: string) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type.startsWith("audio/")) {
    if (type.includes("aac") || type.includes("mp4") || type.includes("m4a")) return "m4a";
    return "mp3";
  }
  return kind === "music" ? "mp3" : "jpg";
}

export function assertUpload(file: File, kind: string) {
  const type = file.type || guessType(file.name, kind);
  if (kind === "image") {
    if (!IMAGE_TYPES.has(type) && type !== "image/jpg") return "Use JPEG, PNG, or WebP, under 3MB.";
    if (file.size > LIMITS.image) return "Photos must be under 3MB.";
    return null;
  }
  if (kind === "music") {
    if (!AUDIO_TYPES.has(type) && type !== "application/octet-stream") return "Use MP3 or AAC, under 20MB.";
    if (file.size > LIMITS.music) return "Songs must be under 20MB.";
    return null;
  }
  return "This type cannot be uploaded yet.";
}

export async function putWorkFile(userId: string, workId: string, file: File, kind: string) {
  const s3 = client();
  if (!s3) throw new Error("File storage is not ready yet.");
  const type = file.type || guessType(file.name, kind);
  const key = `works/${userId}/${workId}.${extFor(type, kind)}`;
  const body = Buffer.from(await file.arrayBuffer());
  await s3.send(
    new PutObjectCommand({
      Bucket: env.bucketName,
      Key: key,
      Body: body,
      ContentType: type || (kind === "music" ? "audio/mpeg" : "image/jpeg"),
    }),
  );
  return key;
}

export async function getWorkFile(key: string) {
  const s3 = client();
  if (!s3) return null;
  const obj = await s3.send(
    new GetObjectCommand({
      Bucket: env.bucketName,
      Key: key,
    }),
  );
  return obj;
}
