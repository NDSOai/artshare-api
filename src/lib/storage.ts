import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../env.js";

process.env.AWS_REQUEST_CHECKSUM_CALCULATION ??= "WHEN_REQUIRED";
process.env.AWS_RESPONSE_CHECKSUM_VALIDATION ??= "WHEN_REQUIRED";

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
  const value = (env.bucketRegion || "auto").trim();
  return value || "auto";
}

function endpoint() {
  return env.bucketEndpoint.replace(/\/$/, "");
}

function stripChecksumHeaders(s3: S3Client) {
  s3.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request as { headers?: Record<string, string> };
      if (request.headers) {
        for (const header of Object.keys(request.headers)) {
          const lower = header.toLowerCase();
          if (lower.includes("checksum") || lower === "content-md5") {
            delete request.headers[header];
          }
        }
      }
      return next(args);
    },
    { step: "finalizeRequest", name: "stripS3Checksums", priority: "low" },
  );
  return s3;
}

function client(forcePathStyle = false) {
  if (!isStorageReady()) return null;
  return stripChecksumHeaders(
    new S3Client({
      region: region(),
      endpoint: endpoint(),
      forcePathStyle,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: env.bucketAccessKey,
        secretAccessKey: env.bucketSecretKey,
      },
    }),
  );
}

async function putObject(key: string, body: Buffer, contentType: string) {
  const bytes = Uint8Array.from(body);
  let last: unknown;
  for (const forcePathStyle of [false, true]) {
    const s3 = client(forcePathStyle);
    if (!s3) throw new Error("File storage is not ready yet.");
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: env.bucketName,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          ContentLength: bytes.byteLength,
        }),
      );
      return;
    } catch (err) {
      last = err;
      console.error("[storage.put]", {
        key,
        forcePathStyle,
        name: err instanceof Error ? err.name : "",
        message: err instanceof Error ? err.message : String(err),
      });
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
  return /^(works|avatars|banners|collections)\/[a-zA-Z0-9._/-]+$/.test(key) && !key.includes("..");
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
    const pipeline = () => sharp(buf, { failOn: "none" }).rotate();
    const meta = await pipeline().metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const sized = () => {
      const image = pipeline();
      if (width > maxEdge || height > maxEdge) {
        return image.resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true });
      }
      return image;
    };
    try {
      const bytes = await sized().webp({ quality: 88, effort: 4 }).toBuffer();
      if (bytes.length > 0) return { bytes, type: "image/webp" };
    } catch {
      /* fall through to JPEG */
    }
    try {
      const bytes = await sized().jpeg({ quality: 88, mozjpeg: true }).toBuffer();
      if (bytes.length > 0) return { bytes, type: "image/jpeg" };
    } catch {
      /* keep the original bytes */
    }
  } catch (err) {
    console.error("[storage.pack]", err);
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

export async function putCollectionCoverFile(
  userId: string,
  collectionId: string,
  file: { type: string; bytes: Buffer },
) {
  if (!isStorageReady()) throw new Error("File storage is not ready yet.");
  const sniffed = sniffImage(file.bytes);
  if (!sniffed) throw new Error("That photo could not be used.");
  const packed = await packImage(file.bytes, sniffed, 1920);
  const key = `collections/${userId}/${collectionId}.${extFor(packed.type, "image")}`;
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
  try {
    const packed = await packImage(body, sniffed, 2400);
    const key = `works/${userId}/${workId}.${extFor(packed.type, kind)}`;
    await putObject(key, packed.bytes, packed.type);
    return key;
  } catch (err) {
    console.error("[storage.work]", err);
    const key = `works/${userId}/${workId}.${extFor(sniffed, kind)}`;
    await putObject(key, body, sniffed);
    return key;
  }
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
