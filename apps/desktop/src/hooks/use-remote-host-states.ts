/**
 * Live state of the computers this desktop can reach (rollout R8 package E,
 * layer 3).
 *
 * The sidebar groups remote projects by computer, and a group has to say whether
 * that computer is reachable and current. The session catalog only carries the
 * label it last saw, so the state comes from the host list instead.
 *
 * The read is keyed by the computers the visible sessions mention: a new
 * sibling appearing, or one disappearing, re-reads the list; a transcript
 * change does not, so ordinary chat activity costs no host traffic. A failed
 * read keeps the previous answer — an empty list would draw every remote project
 * as offline, which is a worse lie than slightly stale state.
 */
import { useEffect, useState } from "react";
import type { RemoteHostSummary } from "@minih-agent/shared";

import { api } from "../lib/api";

export function useRemoteHostStates(hostKeys: readonly string[]): RemoteHostSummary[] {
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([]);
  // The key set, not the array identity: a re-render must not re-read.
  const scope = [...new Set(hostKeys)].sort().join("\u0000");

  useEffect(() => {
    if (!scope) {
      setHosts([]);
      return;
    }
    let live = true;
    void api.listRemoteHosts().then((result) => {
      if (live) setHosts(result.hosts);
    }).catch(() => {
      // Keep the previous answer; see the module comment.
    });
    return () => { live = false; };
  }, [scope]);

  return hosts;
}
