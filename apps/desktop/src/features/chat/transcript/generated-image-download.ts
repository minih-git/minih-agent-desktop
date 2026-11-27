/** Build a safe filename only for image formats accepted by the host reader. */
export function generatedImageDownloadName(dataUrl: string | null, index: number): string | null {
  if (!dataUrl) return null;
  const extension = dataUrl.startsWith("data:image/png;base64,")
    ? "png"
    : dataUrl.startsWith("data:image/jpeg;base64,")
      ? "jpg"
      : dataUrl.startsWith("data:image/webp;base64,")
        ? "webp"
        : dataUrl.startsWith("data:image/gif;base64,")
          ? "gif"
          : null;
  return extension ? `generated-image-${index + 1}.${extension}` : null;
}
