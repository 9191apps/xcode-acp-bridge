export type AcpImageRef = {
  mimeType: string;
  data: string | null;
  url: string | null;
};

const SAFE_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
const BASE64_BODY = /^[A-Za-z0-9+/=\s]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(rec: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function normalizeImage(rec: Record<string, unknown>): AcpImageRef {
  const data = stringField(rec, "data");
  return {
    mimeType: stringField(rec, "mimeType", "mime_type") ?? "application/octet-stream",
    data,
    url: stringField(rec, "url", "uri"),
  };
}

export function extractAcpImages(value: unknown): AcpImageRef[] {
  const out: AcpImageRef[] = [];
  walk(value, out);
  return out;
}

function walk(value: unknown, out: AcpImageRef[]): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === "image") {
    out.push(normalizeImage(value));
    return;
  }
  for (const child of Object.values(value)) walk(child, out);
}

export function extractAcpImagesFromRaw(raw: string): AcpImageRef[] {
  if (raw.length === 0) return [];
  try {
    return extractAcpImages(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function countAcpImagesFromRaw(raw: string): number {
  return extractAcpImagesFromRaw(raw).length;
}

export function acpImageDataUrl(image: AcpImageRef): string | null {
  if (!SAFE_IMAGE_MIME.test(image.mimeType)) return null;
  if (image.data == null || image.data.length === 0) return null;
  if (!BASE64_BODY.test(image.data)) return null;
  const compact = image.data.replace(/\s+/g, "");
  return `data:${image.mimeType};base64,${compact}`;
}

export function acpImageCaption(image: AcpImageRef): string {
  if (image.url) {
    try {
      const path = image.url.split(/[?#]/, 1)[0] ?? image.url;
      const leaf = path.split("/").filter(Boolean).at(-1);
      if (leaf) return decodeURIComponent(leaf);
    } catch {
      // keep mime fallback
    }
  }
  return image.mimeType;
}

export function redactAcpImageData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAcpImageData);
  if (!isRecord(value)) return value;
  if (value.type === "image" && typeof value.data === "string") {
    return { ...value, data: `<base64 ${value.data.length} chars>` };
  }
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = redactAcpImageData(child);
  }
  return next;
}
