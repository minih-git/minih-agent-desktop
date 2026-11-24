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
 *
 * Every read goes through the store at the moment it happens, never through a
 * copy captured when the hook mounted: the sync awaits the gateway, and a
 * settings record is replaced wholesale when it is written.
 */
import { useEffect, useRef } from "react";
import { syncRouterModelProfiles } from "../../components/settings/router-model-profile-sync";
import { fetchMinihRouterCatalog } from "../../components/settings/useMinihRouter";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";

export function useRouterModelProfileSync(): void {
  const ready = useAppStore(
    (state) => state.settings != null && state.providers.length > 0,
  );
  const refreshProviders = useAppStore((state) => state.refreshProviders);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current || !ready) return;
    startedRef.current = true;
    void syncRouterModelProfiles({
      readProviders: () => useAppStore.getState().providers,
      readSettings: () => useAppStore.getState().settings,
      fetchCatalog: (providerId) => fetchMinihRouterCatalog(providerId),
      updateProvider: (input) => api.updateProvider(input),
      setSettings: async (settings) => {
        await api.setSettings(settings);
        useAppStore.setState({ settings });
      },
    }).then(
      (result) => {
        if (result.providersChanged) void refreshProviders();
      },
      () => {
        // A sync that failed is not a startup failure: every row keeps the
        // configuration it launched with, and no error is shown for it.
      },
    );
  }, [ready, refreshProviders]);
}