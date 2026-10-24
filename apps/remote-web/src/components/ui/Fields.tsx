import { Clipboard, Eye, EyeOff } from "lucide-react";
import { useEffect, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

export interface SecureFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  error?: string;
}

export function SecureField({ label, error, className = "", id, ...rest }: SecureFieldProps) {
  const [show, setShow] = useState(false);
  const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");

  return (
    <div className="w-full">
      {label ? (
        <label
          htmlFor={inputId}
          className="mb-2 ml-1 block text-[13px] font-semibold leading-[18px] text-[var(--rm-text-muted)]"
        >
          {label}
        </label>
      ) : null}
      <div className="flex min-h-[52px] w-full items-center gap-1.5 rounded-[var(--rm-radius-control,14px)] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] pl-3.5 pr-1.5 backdrop-blur-md transition-[border-color,box-shadow] duration-150 focus-within:border-[var(--rm-accent-1)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--rm-accent-1)_22%,transparent)]">
        <input
          id={inputId}
          type={show ? "text" : "password"}
          className={`min-w-0 flex-1 bg-transparent py-3 font-mono text-[16px] leading-[24px] text-[var(--rm-text-primary)] placeholder-[var(--rm-text-faint)] outline-none ${className}`}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "Hide password" : "Show password"}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] text-[var(--rm-text-muted)] transition-[transform,background-color] duration-150 active:scale-[0.9] active:bg-[var(--rm-bg-surface-2)]"
        >
          {show ? (
            <EyeOff className="h-5 w-5 stroke-[2]" aria-hidden="true" />
          ) : (
            <Eye className="h-5 w-5 stroke-[2]" aria-hidden="true" />
          )}
        </button>
      </div>
      {error ? (
        <p className="mt-1.5 ml-1 text-[13px] leading-[18px] text-[var(--rm-error)]">{error}</p>
      ) : null}
    </div>
  );
}

export interface TicketFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  onPasteText?: (text: string) => void;
  pasteLabel?: string;
}

export function TicketField({
  label,
  error,
  onPasteText,
  pasteLabel = "Paste",
  className = "",
  id,
  value,
  onChange,
  ...rest
}: TicketFieldProps) {
  const [canPaste, setCanPaste] = useState(false);
  const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");

  useEffect(() => {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.readText === "function"
    ) {
      setCanPaste(true);
    }
  }, []);

  const handlePasteClick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && onPasteText) {
        onPasteText(text);
      }
    } catch {
      // Clipboard access might be denied
    }
  };

  return (
    <div className="w-full">
      {label ? (
        <label
          htmlFor={inputId}
          className="mb-2 ml-1 block text-[13px] font-semibold leading-[18px] text-[var(--rm-text-muted)]"
        >
          {label}
        </label>
      ) : null}
      <div className="flex min-h-[52px] w-full flex-col rounded-[var(--rm-radius-control,14px)] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] p-3.5 backdrop-blur-md transition-[border-color,box-shadow] duration-150 focus-within:border-[var(--rm-accent-1)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--rm-accent-1)_22%,transparent)]">
        <textarea
          id={inputId}
          rows={3}
          value={value}
          onChange={onChange}
          className={`w-full resize-none bg-transparent font-mono text-[16px] leading-[22px] text-[var(--rm-text-primary)] placeholder-[var(--rm-text-faint)] outline-none ${className}`}
          {...rest}
        />
        {canPaste && onPasteText ? (
          <div className="mt-2.5 flex justify-start">
            <button
              type="button"
              onClick={handlePasteClick}
              className="inline-flex h-[32px] items-center gap-1.5 rounded-[10px] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface-2)] px-3 text-[13px] font-semibold text-[var(--rm-text-primary)] transition-transform duration-150 active:scale-[0.96]"
            >
              <Clipboard className="h-4 w-4 stroke-[2]" aria-hidden="true" />
              <span>{pasteLabel}</span>
            </button>
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="mt-1.5 ml-1 text-[13px] leading-[18px] text-[var(--rm-error)]">{error}</p>
      ) : null}
    </div>
  );
}
