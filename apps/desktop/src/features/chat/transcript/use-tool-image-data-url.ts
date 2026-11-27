import { useReferencedImageDataUrl } from "../../../lib/use-referenced-image-data-url";
import type { ToolImageRef } from "./tool-result-images";

export function useToolImageDataUrl(image: ToolImageRef | undefined): string | null {
  const referenced = useReferencedImageDataUrl(image?.path, image?.mimeType);
  return image?.dataUrl ?? referenced;
}
