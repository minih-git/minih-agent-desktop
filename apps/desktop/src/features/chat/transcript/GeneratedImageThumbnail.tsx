import { useTranslation } from "react-i18next";
import { TooltipButton } from "../../../components/ui";
import { useToolImageDataUrl } from "./use-tool-image-data-url";
import type { ToolImageRef } from "./tool-result-images";

export type GeneratedImageRef = ToolImageRef & { label?: string };

export function GeneratedImageThumbnail({ image, selected, onSelect, className }: {
  image: GeneratedImageRef;
  selected: boolean;
  onSelect: () => void;
  className: string;
}) {
  const { t } = useTranslation();
  const src = useToolImageDataUrl(image);
  return (
    <TooltipButton
      type="button"
      className={className}
      tooltip={image.label ?? t("settings.generatedImage", { index: image.index + 1 })}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      {src ? <img src={src} alt="" /> : <span aria-hidden="true">{image.index + 1}</span>}
    </TooltipButton>
  );
}
