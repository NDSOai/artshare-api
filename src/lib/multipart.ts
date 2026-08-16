export type FormFile = {
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type ParsedForm = {
  fields: Record<string, string>;
  files: Record<string, FormFile>;
};

function headerValue(headers: string, key: string) {
  const match = new RegExp(`(?:^|[\\r\\n])${key}\\s*:\\s*([^\\r\\n]+)`, "i").exec(headers);
  return match?.[1]?.trim() ?? "";
}

function dispositionParam(value: string, key: string) {
  const match = new RegExp(`${key}\\s*=\\s*(?:"((?:\\\\.|[^"])*)"|([^;\\s]+))`, "i").exec(value);
  return (match?.[1] ?? match?.[2] ?? "").replace(/\\"/g, '"');
}

function asFile(name: string, type: string, bytes: Buffer): FormFile {
  const copy = Buffer.from(bytes);
  return {
    name,
    type: type || "application/octet-stream",
    size: copy.length,
    arrayBuffer: async () =>
      copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer,
  };
}

export function parseMultipart(buf: Buffer, contentType: string): ParsedForm {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] || match?.[2] || "").trim();
  if (!boundary) throw new Error("Could not read that upload.");

  const delim = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  const files: Record<string, FormFile> = {};
  let start = buf.indexOf(delim);
  if (start < 0) throw new Error("Could not read that upload.");
  start += delim.length;

  while (start < buf.length) {
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else if (buf[start] === 0x0a) start += 1;

    const next = buf.indexOf(delim, start);
    if (next < 0) break;

    let end = next;
    if (end >= 2 && buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
    else if (end >= 1 && buf[end - 1] === 0x0a) end -= 1;

    const part = buf.subarray(start, end);
    const split = part.indexOf(Buffer.from("\r\n\r\n"));
    const splitN = split < 0 ? part.indexOf(Buffer.from("\n\n")) : -1;
    const headerEnd = split >= 0 ? split : splitN;
    const headerSkip = split >= 0 ? 4 : splitN >= 0 ? 2 : -1;
    if (headerEnd < 0 || headerSkip < 0) {
      start = next + delim.length;
      continue;
    }

    const headers = part.subarray(0, headerEnd).toString("utf8");
    const body = part.subarray(headerEnd + headerSkip);
    const disposition = headerValue(headers, "content-disposition");
    const name = dispositionParam(disposition, "name");
    const filename = dispositionParam(disposition, "filename");
    if (!name) {
      start = next + delim.length;
      continue;
    }
    if (filename) {
      files[name] = asFile(filename, headerValue(headers, "content-type"), body);
    } else {
      fields[name] = body.toString("utf8");
    }
    start = next + delim.length;
  }

  return { fields, files };
}
