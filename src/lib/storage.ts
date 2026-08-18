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

function region() {
  return !env.bucketRegion || env.bucketRegion === "auto" ? "us-east-1" : env.bucketRegion;
}

function client(forcePathStyle = true) {
  if (!isStorageReady()) return null;
  return new S3Client({
    region: region(),
    endpoint: env.bucketEndpoint,
    forcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: env.bucketAccessKey,
      secretAccessKey: env.bucketSecretKey,
    },
  });
}

async function putObject(key: string, body: Buffer, contentType: string) {
  let last: unknown;
  for (const forcePathStyle of [true, false]) {
    const s3 = client(forcePathStyle);
    if (!s3) throw new Error("File storage is not ready yet.");
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: env.bucketName,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      return;
    } catch (err) {
      last = err;
      console.error("[storage.put]", { key, forcePathStyle, err });
    }
  }
  throw last instanceof Error ? last : new Error("Could not store that file.");
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
  const own = ownMediaKey(key);
  if (own) {
    const base = env.apiPublicUrl.replace(/\/$/, "");
    return base ? `${base}/media/${own}` : `/media/${own}`;
  }
  return undefined;
}

export function isSafeMediaKey(key: string) {
  return /^(works|avatars|banners)\/[a-zA-Z0-9._/-]+$/.test(key) && !key.includes("..");
}

export function ownMediaKey(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (isSafeMediaKey(trimmed)) return trimmed;
  if (trimmed.startsWith("/media/")) {
    const key = trimmed.slice("/media/".length);
    return isSafeMediaKey(key) ? key : null;
  }
  const base = env.apiPublicUrl.replace(/\/$/, "");
  if (base && trimmed.startsWith(`${base}/media/`)) {
    const key = trimmed.slice(`${base}/media/`.length);
    return isSafeMediaKey(key) ? key : null;
  }
  return null;
}

function sniffImage(buf: Buffer) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function sniffAudio(buf: Buffer) {
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "ID3") return "audio/mpeg";
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (buf.length >= 8 && buf.toString("ascii", 4, 8) === "ftyp") return "audio/mp4";
  return null;
}

async function packImage(buf: Buffer, type: string, maxEdge: number) {
  try {
    const { default: sharp } = await import("sharp");
    const image = sharp(buf, { failOn: "none" }).rotate();
    const meta = await image.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width > maxEdge || height > maxEdge) {
      image.resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true });
    }
    const bytes = await image.webp({ quality: 88, effort: 4 }).toBuffer();
    if (bytes.length > 0 && bytes.length < buf.length) {
      return { bytes, type: "image/webp" };
    }
  } catch {
    // Keep the original file if compression fails or isn't smaller.
  }
  return { bytes: buf, type };
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
  if (!isStorageReady()) throw new Error("File storage is not ready yet.");
  const sniffed = sniffImage(file.bytes);
  if (!sniffed) throw new Error("That photo could not be used.");
  const packed = await packImage(file.bytes, sniffed, 800);
  const key = `avatars/${userId}.${extFor(packed.type, "image")}`;
  await putObject(key, packed.bytes, packed.type);
  return key;
}

export async function putBannerFile(userId: string, file: { type: string; bytes: Buffer }) {
  if (!isStorageReady()) throw new Error("File storage is not ready yet.");
  const sniffed = sniffImage(file.bytes);
  if (!sniffed) throw new Error("That photo could not be used.");
  const packed = await packImage(file.bytes, sniffed, 1920);
  const key = `banners/${userId}.${extFor(packed.type, "image")}`;
  await putObject(key, packed.bytes, packed.type);
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

export type UploadBlob = {
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export function assertUpload(file: UploadBlob, kind: string) {
  const type = file.type || guessType(file.name, kind);
  if (kind === "image") {
    if (!IMAGE_TYPES.has(type) && type !== "image/jpg") return "Use JPEG, PNG, or WebP, under 3MB.";
    if (file.size > LIMITS.image) return "Photos must be under 3MB.";
    return null;
  }
  if (kind === "music") {
    if (!AUDIO_TYPES.has(type)) return "Use MP3 or AAC, under 20MB.";
    if (file.size > LIMITS.music) return "Songs must be under 20MB.";
    return null;
  }
  return "This type cannot be uploaded yet.";
}

export async function putWorkFile(userId: string, workId: string, file: UploadBlob, kind: string) {
  if (!isStorageReady()) throw new Error("File storage is not ready yet.");
  const body = Buffer.from(await file.arrayBuffer());
  const sniffed = kind === "music" ? sniffAudio(body) : sniffImage(body);
  if (!sniffed) {
    throw new Error(kind === "music" ? "Use MP3 or AAC, under 20MB." : "Use JPEG, PNG, or WebP, under 3MB.");
  }
  if (kind === "music") {
    const key = `works/${userId}/${workId}.${extFor(sniffed, kind)}`;
    await putObject(key, body, sniffed);
    return key;
  }
  const packed = await packImage(body, sniffed, 2400);
  const key = `works/${userId}/${workId}.${extFor(packed.type, kind)}`;
  await putObject(key, packed.bytes, packed.type);
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
