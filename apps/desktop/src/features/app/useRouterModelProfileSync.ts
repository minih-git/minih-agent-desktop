/**
 * The Minih Router model profile, applied once per application start.
 *
 * The settings page applies the same profile when it opens
 * (`router-model-profile-sync.ts`); this hook is the startup half, so a profile
 * the gateway operator changed reaches an installed app without the user
 * opening Settings first.
 *
 * It runs at most once per renderer lifetime: the sync writes through the
 * provider channel and refreshes the provider list, which would otherwise look
 * exactly like the state change that starts it again.
 */
import { useEffect, useRef } from "react";
import { syncRouterModelProfiles } from "../../components/settings/router-model-profile-sync";
import { useAppStore } from "../../stores/app-store";

export function useRouterModelProfileSync(): void {
  const providers = useAppStore((state) => state.providers);
  const settings = useAppStore((state) => state.settings);
  const refreshProviders = useAppStore((state) => state.refreshProviders);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current || !settings || providers.length === 0) return;
    startedRef.current = true;
    void syncRouterModelProfiles({ providers, settings }).then(
      (result) => {
        if (result.settings) useAppStore.setState({ settings: result.settings });
        if (result.providersChanged) void refreshProviders();
      },
      () => {
        // A sync that failed is not a startup failure: every row keeps the
        // configuration it launched with, and no error is shown for it.
      },
    );
  }, [providers, settings, refreshProviders]);
}