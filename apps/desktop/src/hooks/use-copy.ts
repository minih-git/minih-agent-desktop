import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy-to-clipboard with a short-lived acknowledgement.
 *
 * Lives outside `Markdown.tsx` so the blocks it renders can acknowledge a copy
 * without importing the module that renders them.
 */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }, []);
  return { copied, copy };
}