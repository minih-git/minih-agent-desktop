/**
 * Screen routing for the client (PR-4, PR-5).
 *
 * Four screens in a stack held in component state: the host list, pairing, the
 * sessions of one host, and one session's timeline. No router dependency, and
 * every screen receives the credential the port hands out for its host.
 *
 * In a native shell the Android hardware back button pops the same stack
 * (Session → Sessions → Hosts) and only exits the app from the Host list.
 */
import type { RacpSession } from "@minih-agent/shared";
import { useEffect, useState } from "react";

import { AccountScreen } from "./screens/AccountScreen.js";
import { HostsScreen } from "./screens/HostsScreen.js";
import { PairScreen } from "./screens/PairScreen.js";
import { SessionScreen } from "./screens/SessionScreen.js";
import { SessionsScreen } from "./screens/SessionsScreen.js";
import { usePushRegistration } from "./hooks/usePushRegistration.js";
import { useHostRegistry } from "./hooks/useHostRegistry.js";
import { setBackHandler } from "./lib/navigation.js";
import { credentialPort, isNativeApp } from "./lib/runtime.js";
import { previousScreen, type Screen } from "./lib/screen-stack.js";

export default function App() {
  const hosts = useHostRegistry();
  const [screen, setScreen] = useState<Screen>({ kind: "hosts" });

  // Push (protocol §11.6): a tap opens the Host and session the ids name. It is
  // a no-op in the browser, where this client ships no push at all.
  usePushRegistration(hosts, (destination) => {
    if (destination.kind === "hosts") {
      setScreen({ kind: "hosts" });
      return;
    }
    const entry = hosts.find((host) => host.hostId === destination.hostId);
    if (!entry) {
      // The notification names a Host this device no longer holds: the Host
      // list is the honest destination, not an error screen.
      setScreen({ kind: "hosts" });
      return;
    }
    setScreen({ kind: "session", hostId: entry.hostId, sessionId: destination.sessionId, title: entry.label });
  });

  useEffect(() => {
    if (!isNativeApp) return undefined;
    const previous = previousScreen(screen);
    setBackHandler(previous ? () => setScreen(previous) : null);
    return () => setBackHandler(null);
  }, [screen]);

  const hostList = (
    <HostsScreen
      hosts={hosts}
      onOpenHost={(entry) => setScreen({ kind: "sessions", hostId: entry.hostId })}
      onAddHost={() => setScreen({ kind: "pair" })}
      onAddAccount={() => setScreen({ kind: "account" })}
    />
  );

  if (screen.kind === "account") {
    return (
      <AccountScreen
        onAdopted={() => setScreen({ kind: "hosts" })}
        onUseTicket={() => setScreen({ kind: "pair" })}
        onBack={() => setScreen({ kind: "hosts" })}
      />
    );
  }

  if (screen.kind === "pair") {
    return (
      <PairScreen
        onPaired={(entry) => setScreen({ kind: "sessions", hostId: entry.hostId })}
        onBack={() => setScreen({ kind: "hosts" })}
      />
    );
  }

  if (screen.kind === "sessions") {
    const host = hosts.find((entry) => entry.hostId === screen.hostId);
    const credential = host ? credentialPort.credentialFor(host.hostId) : null;
    // A forgotten host (or a registry that no longer holds it) falls back to
    // the list rather than opening a screen without a credential.
    if (!host || !credential) return hostList;
    return (
      <SessionsScreen
        hostId={host.hostId}
        hostLabel={host.label}
        credential={credential}
        {...(host.roles ? { roles: host.roles } : {})}
        onOpenSession={(session: RacpSession) =>
          setScreen({ kind: "session", hostId: host.hostId, sessionId: session.id, title: session.title })
        }
        onBack={() => setScreen({ kind: "hosts" })}
      />
    );
  }

  if (screen.kind === "session") {
    const host = hosts.find((entry) => entry.hostId === screen.hostId);
    const credential = host ? credentialPort.credentialFor(host.hostId) : null;
    if (!host || !credential) return hostList;
    return (
      <SessionScreen
        hostId={host.hostId}
        sessionId={screen.sessionId}
        title={screen.title}
        credential={credential}
        onBack={() => setScreen({ kind: "sessions", hostId: host.hostId })}
      />
    );
  }

  return hostList;
}
