import { useEffect, useState } from "react";

import { hostRegistry } from "../lib/runtime.js";
import type { HostRegistryEntry } from "../lib/host-registry.js";

/** The paired hosts, re-rendered whenever the registry changes. */
export function useHostRegistry(): HostRegistryEntry[] {
  const [hosts, setHosts] = useState<HostRegistryEntry[]>(() => hostRegistry.list());
  useEffect(() => hostRegistry.subscribe(() => setHosts(hostRegistry.list())), []);
  return hosts;
}
