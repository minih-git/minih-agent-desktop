/**
 * Screen routing for the client (PR-4, PR-5, R7).
 *
 * The stack lives in React state and, at the same time, in the browser's
 * history: every level a user opens is one entry, so the browser's own Back and
 * Safari's edge gesture step up one level instead of leaving the site. A native
 * iOS build gets the same gesture from `useEdgeSwipe` rather than from the
 * WebView's history gesture, because that one only shows a snapshot and would
 * fight the live session underneath it.
 *
 * `previousScreen` is the single rule every back path uses: the header button,
 * the Android hardware back button, the browser's `popstate`, and the iOS swipe.
 */
import type { RacpSession } from "@minih-agent/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { AccountScreen } from "./screens/AccountScreen.js";
import { ConnectScreen } from "./screens/ConnectScreen.js";
import { HostsScreen } from "./screens/HostsScreen.js";
import { PairScreen } from "./screens/PairScreen.js";
import { SessionScreen } from "./screens/SessionScreen.js";
import { SessionsScreen } from "./screens/SessionsScreen.js";
import { useEdgeSwipe } from "./hooks/useEdgeSwipe.js";
import { usePushRegistration } from "./hooks/usePushRegistration.js";
import { useHostRegistry } from "./hooks/useHostRegistry.js";
import { setBackHandler } from "./lib/navigation.js";
import { credentialPort, isNativeApp, nativePlatform } from "./lib/runtime.js";
import { setNotificationBadge } from "./lib/native-notify.js";
import { createScreenHistory, sameScreen } from "./lib/screen-history.js";
import { previousScreen, type Screen } from "./lib/screen-stack.js";

/** The history port the app drives; kept out of the component for testability. */
const screenHistory = createScreenHistory({
  push: (screen) => window.history.pushState({ screen }, ""),
  replace: (screen) => window.history.replaceState({ screen }, ""),
  state: () => window.history.state,
});

export default function App() {
  const hosts = useHostRegistry();
  const [screen, setScreen] = useState<Screen>({ kind: "hosts" });
  /**
   * Whether this build should draw its own edge gesture. Only a native iOS shell
   * needs one: a browser already gets the gesture from its history, and running
   * both would make one swipe pop twice.
   */
  const nativeGesture = nativePlatform === "ios";

  /**
   * The one navigation used by every forward step and every back step, so the
   * history entry and the screen can never disagree.
   *
   * `fromHistory` marks a screen that came out of a `popstate`: the browser has
   * already moved, so this must not push a second entry.
   */
  const navigate = useCallback((next: Screen, fromHistory = false) => {
    setScreen((current) => {
      if (sameScreen(current, next)) return current;
      if (fromHistory) screenHistory.adopt(next);
      else screenHistory.sync(next);
      return next;
    });
  }, []);

  const screenRef = useRef(screen);
  screenRef.current = screen;

  const goBack = useCallback(() => {
    if (!previousScreen(screenRef.current)) return;
    // A back step pops the entry this screen pushed, which is what makes the
    // browser's own Back, the header button, and the edge swipe agree: the pop
    // arrives as `popstate` and is applied there, exactly once.
    window.history.back();
  }, []);

  /**
   * Opening the app clears the badge: it counts what happened while the user was
   * away, and they are looking now (§17.6.2). The Gateway sets it per push from
   * the count the Host reports.
   */
  useEffect(() => {
    void setNotificationBadge(0);
  }, []);

  // The first screen replaces whatever the browser loaded, so the entry the user
  // arrived on is not an extra level to go back to.
  useEffect(() => {
    screenHistory.sync(screen);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first mount only
  }, []);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const state = event.state as unknown;
      const restored = state && typeof state === "object" ? (state as { screen?: Screen }).screen : undefined;
      if (restored) {
        navigate(restored, true);
        return;
      }
      // No screen in the entry (the first entry, or one written by an older
      // build): fall back to the same rule the back button uses.
      setScreen((current) => {
        const previous = previousScreen(current);
        if (!previous) return current;
        screenHistory.adopt(previous);
        return previous;
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [navigate]);

  // Push (protocol §11.6): a tap opens the Host and session the ids name. It is
  // a no-op in the browser, where this client ships no push at all. The stack
  // beneath is rebuilt (§8.8), and the history gets one entry for the pair so a
  // back swipe from the pushed session lands on that computer's list.
  usePushRegistration(hosts, (destination) => {
    if (destination.kind === "hosts") {
      navigate({ kind: "hosts" });
      return;
    }
    const entry = hosts.find((host) => host.hostId === destination.hostId);
    if (!entry) {
      // The notification names a Host this device no longer holds: the Host
      // list is the honest destination, not an error screen.
      navigate({ kind: "hosts" });
      return;
    }
    screenHistory.sync({ kind: "sessions", hostId: entry.hostId });
    navigate({
      kind: "session",
      hostId: entry.hostId,
      sessionId: destination.sessionId,
      // The computer's name has its own place in the bar, so the title starts
      // empty and the loaded session supplies it; using the label here printed
      // the computer as the conversation's name.
      title: "",
    });
  });

  useEffect(() => {
    if (!isNativeApp) return undefined;
    // Android's hardware back goes through the same call as the header button and
    // the edge swipe, so it pops history rather than stepping the state sideways.
    setBackHandler(previousScreen(screen) ? goBack : null);
    return () => setBackHandler(null);
  }, [screen, goBack]);

  // The iOS edge swipe. It shares `previousScreen` with every other back path.
  const swipe = useEdgeSwipe({
    enabled: nativeGesture,
    canGoBack: previousScreen(screen) !== null,
    onBack: goBack,
  });

  const hostList =
    hosts.length === 0 ? (
      <ConnectScreen
        onAddHost={() => navigate({ kind: "pair" })}
        onAddAccount={() => navigate({ kind: "account" })}
      />
    ) : (
      <HostsScreen
        hosts={hosts}
        onOpenHost={(entry) => navigate({ kind: "sessions", hostId: entry.hostId })}
        onAddHost={() => navigate({ kind: "pair" })}
        onAddAccount={() => navigate({ kind: "account" })}
      />
    );

  const body = (() => {
    if (screen.kind === "account") {
      return (
        <AccountScreen
          onAdopted={() => navigate({ kind: "hosts" })}
          onUseTicket={() => navigate({ kind: "pair" })}
          onBack={goBack}
        />
      );
    }

    if (screen.kind === "pair") {
      return (
        <PairScreen
          onPaired={(entry) => navigate({ kind: "sessions", hostId: entry.hostId })}
          onBack={goBack}
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
            navigate({ kind: "session", hostId: host.hostId, sessionId: session.id, title: session.title })
          }
          onBack={goBack}
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
          hostLabel={host.label}
          onBack={goBack}
        />
      );
    }

    return hostList;
  })();

  return (
    <div
      className="relative h-dvh overflow-hidden"
      data-gesture={swipe.state}
      style={
        swipe.offset > 0
          ? { transform: `translate3d(${swipe.offset}px, 0, 0)`, transition: "none" }
          : undefined
      }
    >
      {body}
    </div>
  );
}
