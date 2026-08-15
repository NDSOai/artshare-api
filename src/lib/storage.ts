import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../env.js";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
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
  return new S3Client({
    region: env.bucketRegion || "auto",
    endpoint: env.bucketEndpoint,
    credentials: {
      accessKeyId: env.bucketAccessKey,
      secretAccessKey: env.bucketSecretKey,
    },
  });
}

export function publicMediaUrl(key: string | null | undefined) {
  if (!key) return undefined;
  if (key.startsWith("http://") || key.startsWith("https://")) return key;
  const base = env.apiPublicUrl.replace(/\/$/, "");
  return base ? `${base}/media/${key}` : `/media/${key}`;
}

export function isSafeMediaKey(key: string) {
  return /^works\/[a-zA-Z0-9._/-]+$/.test(key) && !key.includes("..");
}

function extFor(type: string, kind: string) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  if (type.startsWith("audio/")) {
    if (type.includes("wav")) return "wav";
    if (type.includes("ogg")) return "ogg";
    if (type.includes("webm")) return "webm";
    if (type.includes("aac") || type.includes("mp4")) return "m4a";
    if (type.includes("flac")) return "flac";
    return "mp3";
  }
  return kind === "music" ? "mp3" : "jpg";
}

export function assertUpload(file: File, kind: string) {
  if (kind === "image") {
    if (!IMAGE_TYPES.has(file.type) && !file.type.startsWith("image/")) {
      return "That photo type is not supported.";
    }
    if (file.size > LIMITS.image) return "Photos must be under 3MB.";
    return null;
  }
  if (kind === "music") {
    if (!AUDIO_TYPES.has(file.type) && !file.type.startsWith("audio/")) {
      return "That audio type is not supported.";
    }
    if (file.size > LIMITS.music) return "Songs must be under 20MB.";
    return null;
  }
  return "This type cannot be uploaded yet.";
}

export async function putWorkFile(userId: string, workId: string, file: File, kind: string) {
  const s3 = client();
  if (!s3) throw new Error("File storage is not ready yet.");
  const key = `works/${userId}/${workId}.${extFor(file.type, kind)}`;
  const body = Buffer.from(await file.arrayBuffer());
  await s3.send(
    new PutObjectCommand({
      Bucket: env.bucketName,
      Key: key,
      Body: body,
      ContentType: file.type || (kind === "music" ? "audio/mpeg" : "image/jpeg"),
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
