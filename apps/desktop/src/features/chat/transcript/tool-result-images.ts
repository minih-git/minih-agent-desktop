import type { UiMessage } from "@minih-agent/shared";

export type ToolImageRef = {
  index: number;
  path?: string;
  dataUrl?: string;
  mimeType?: string;
};

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_BASE64_LENGTH = Math.ceil(16 * 1024 * 1024 / 3) * 4;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function localImagePath(value: unknown, mimeType?: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const path = value.trim();
  // Drive letters are paths, not URL schemes. Host containment remains authoritative.
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return undefined;
  return IMAGE_MIME.has(mimeType ?? "") || /\.(?:png|jpe?g|webp|gif)$/i.test(path) ? path : undefined;
}

/** Project only structured image results; never parse arbitrary tool text as paths/HTML. */
export function toolResultImages(message: Pick<UiMessage, "toolName" | "toolResult">): ToolImageRef[] {
  const raw = message.toolResult;
  const envelope = record(raw);
  const details = record(envelope?.details);
  const payload = details ?? record(envelope?.content) ?? envelope;
  if (message.toolName === "GenerateImages" && payload?.kind === "generated-images" && Array.isArray(payload.results)) {
    return payload.results.flatMap((value, index) => {
      const item = record(value);
      const mimeType = typeof item?.mimeType === "string" ? item.mimeType : undefined;
      const path = item?.status === "succeeded" ? localImagePath(item.path, mimeType) : undefined;
      return path ? [{ index, path, mimeType }] : [];
    });
  }

  const images: ToolImageRef[] = [];
  const seen = new Set<string>();
  const append = (value: unknown) => {
    const item = record(value);
    if (!item) return;
    const resource = item.type === "resource" ? record(item.resource) : null;
    const image = resource ?? item;
    const mimeType = typeof image.mimeType === "string" ? image.mimeType : undefined;
    const data = resource ? resource.blob : image.data;
    if (mimeType && IMAGE_MIME.has(mimeType) && typeof data === "string" && data.length > 0 &&
        data.length <= MAX_BASE64_LENGTH && !/[^A-Za-z\d+/=]/.test(data)) {
      const dataUrl = `data:${mimeType};base64,${data}`;
      if (!seen.has(dataUrl)) {
        seen.add(dataUrl);
        images.push({ index: images.length, dataUrl, mimeType });
      }
      return;
    }
    const path = localImagePath(image.path ?? image.ref, mimeType);
    if (path && !seen.has(path)) {
      seen.add(path);
      images.push({ index: images.length, path, mimeType });
    }
  };
  const appendResult = (result: unknown) => {
    if (Array.isArray(result)) {
      for (const block of result) {
        const item = record(block);
        if (item?.type === "image" || item?.type === "resource") append(item);
      }
      return;
    }
    const item = record(result);
    if (!item) return;
    if (Array.isArray(item.images)) item.images.forEach(append);
    if (Array.isArray(item.content)) {
      for (const block of item.content) {
        const content = record(block);
        if (content?.type === "image" || content?.type === "resource") append(content);
      }
    }
    // Read's path is a fallback, not a second copy of its inline image.
    if (!images.length) append(item);
  };
  appendResult(raw);
  appendResult(envelope?.content);
  appendResult(details);
  return images;
}
