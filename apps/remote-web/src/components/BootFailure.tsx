/**
 * The last-resort screen when the client cannot start at all (PR-5).
 *
 * A native build refuses to start without a valid baked Gateway origin, and the
 * platform secure store can fail to open; both would otherwise leave a blank
 * webview with no explanation.
 */
import { useTranslation } from "react-i18next";

export function BootFailure({ reason }: { reason: string }) {
  const { t } = useTranslation();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-2 px-6 text-sm">
      <h1 className="text-base font-semibold">{t("boot.failedTitle")}</h1>
      <p className="text-slate-600 dark:text-slate-300">{t("boot.failed", { reason })}</p>
    </main>
  );
}
