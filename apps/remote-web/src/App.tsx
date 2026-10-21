/**
 * Screen routing for the client (PR-4, PR-5, R7, spec §17.3).
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
 * §17 added the two layers between a computer and its sessions, so the stack is
 * now `hosts ▸ projects ▸ projectSessions ▸ session`. ADR
 * mobile-direct-gateway-chat adds the Chats root with a root-only tab bar: the
 * frame below is one column, so the screen area and the bar share the viewport
 * and a screen can never cover the bar.
 */
import type { RacpSession } from "@minih-agent/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { ForegroundNoticeBar, type ForegroundNotice } from "./components/ForegroundNotice.js";
import { AccountScreen } from "./screens/AccountScreen.js";
import { ChatsScreen } from "./screens/ChatsScreen.js";
import { ConnectGatewayScreen } from "./screens/ConnectGatewayScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { ConnectScreen } from "./screens/ConnectScreen.js";
import { HostsScreen } from "./screens/HostsScreen.js";
import { PairScreen } from "./screens/PairScreen.js";
import { ProjectSessionsScreen } from "./screens/ProjectSessionsScreen.js";
import { ProjectsScreen } from "./screens/ProjectsScreen.js";
import { SessionScreen } from "./screens/SessionScreen.js";
import { ModelSheet } from "./components/ModelSheet.js";
import { TabBar } from "./components/TabBar.js";
import { useEdgeSwipe } from "./hooks/useEdgeSwipe.js";
import { usePushRegistration } from "./hooks/usePushRegistration.js";
import { useHostRegistry } from "./hooks/useHostRegistry.js";
import { registryHasHosts } from "./lib/host-registry.js";
import { resolveLaunchRoot, storeLastRoot } from "./lib/launch-root.js";
import { setBackHandler } from "./lib/navigation.js";
import type { DirectChatConnection } from "./lib/direct-chat/connection.js";
import { credentialPort, directChatService, isNativeApp, modelGatewayOrigin, nativePlatform } from "./lib/runtime.js";
import { consumeNotificationTap, setNotificationBadge } from "./lib/native-notify.js";
import { createScreenHistory, sameScreen, screenFromHistoryState } from "./lib/screen-history.js";
import { previousScreen, type RootKind, type Screen } from "./lib/screen-stack.js";
import { tabBarVisible } from "./lib/tab-bar.js";
import { createSessionViews } from "./lib/session-state.js";

/** The history port the app drives; kept out of the component for testability. */
const screenHistory = createScreenHistory({
  push: (screen) => window.history.pushState({ screen }, ""),
  replace: (screen) => window.history.replaceState({ screen }, ""),
  state: () => window.history.state,
});

/** What this device has opened, which is half of the "needs you" vocabulary (§17.4). */
const sessionViews = createSessionViews(window.localStorage);

/**
 * The store the launch decision reads and writes; `null` when the platform
 * blocks `localStorage`. Read once, so both the decision and the memory of it
 * use the same store.
 */
const launchStorage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

/**
 * The root this device opens on (§4, ADR mobile-direct-gateway-chat): the
 * remembered root, or the launch decision for the first run. The browser build
 * has one root and never sees Chats.
 */
const initialRoot = resolveLaunchRoot({
  isNativeApp,
  hasHosts: launchStorage !== null && registryHasHosts(launchStorage),
  storage: launchStorage,
});

export default function App() {
  const hosts = useHostRegistry();
  const [screen, setScreen] = useState<Screen>({ kind: initialRoot });
  /**
   * The model connection this device holds, or null. Read once at mount and
   * refreshed after connecting or unlinking, because every direct-chat screen
   * decides what to show from it.
   */
  const [connection, setConnection] = useState<DirectChatConnection | null>(() =>
    isNativeApp ? directChatService().connection() : null,
  );
  /** The model sheet, opened from D1 today and from D3's chip later. */
  const [modelsOpen, setModelsOpen] = useState(false);
  /** A notification that arrived while the app was open (§17.6.4). */
  const [notice, setNotice] = useState<ForegroundNotice | null>(null);
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

  /**
   * Switching tabs replaces the root instead of stacking it (§4): the entry the
   * previous root occupied is reused, so Back never alternates between tabs and
   * Android Back on either root still exits. The choice is remembered so the
   * next launch reopens this root.
   */
  const switchRoot = useCallback(
    (root: RootKind) => {
      storeLastRoot(root, window.localStorage);
      navigate({ kind: root });
    },
    [navigate],
  );

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

  /**
   * A tap on a notification the app drew itself (Android, §17.6.6): the ids come
   * from the intent, and the session opens exactly as it would from a push.
   */
  useEffect(() => {
    let cancelled = false;
    void consumeNotificationTap().then((tap) => {
      if (cancelled) return;
      if (!tap.hostId || !tap.sessionId) return;
      const host = hosts.find((entry) => entry.hostId === tap.hostId);
      if (!host) return;
      // A computer notification owns its path (ADR): the root becomes Computers.
      // `sync` moves sideways, so the entry the Chats root occupied is reused
      // for `hosts`, and a push carries no project id, so the stack is the
      // honest shallow one (§17.3): the computer's projects, then the session.
      screenHistory.sync({ kind: "projects", hostId: host.hostId });
      navigate({ kind: "session", hostId: host.hostId, sessionId: tap.sessionId, title: "" });
    });
    return () => {
      cancelled = true;
    };
    // Runs once on start; a later tap arrives through the same store and is read
    // when the app is next opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The first screen replaces whatever the browser loaded, so the entry the user
  // arrived on is not an extra level to go back to.
  useEffect(() => {
    screenHistory.sync(screen);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first mount only
  }, []);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      // A history entry is untrusted input: only a screen that parses is adopted.
      const restored = screenFromHistoryState(event.state as unknown);
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

  /**
   * Opening a session is what makes it "looked at" (§17.4), so the list stops
   * calling it new. Recorded on the way in rather than on the way out, because a
   * user who is interrupted still saw the session.
   */
  useEffect(() => {
    if (screen.kind !== "session") return;
    sessionViews.markViewed(screen.hostId, screen.sessionId);
  }, [screen]);

  // Push (protocol §11.6): a tap opens the Host and session the ids name. It is
  // a no-op in the browser, where this client ships no push at all. The stack
  // beneath is rebuilt (§8.8, §17.3): the computer's project list and the
  // session's own project are written as history entries, so a back step lands
  // on the project's session list. A payload carries no project id, so the first
  // back step lands on the project list until the session list has been read.
  usePushRegistration(
    hosts,
    (destination) => {
      setNotice(null);
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
      if (destination.notifyKind === "input.requested") {
        // The Host leaves the session `running` while it waits for an answer
        // (§17.4.1); a delivered push is the only place this device learns it.
        sessionViews.markInputPending(entry.hostId, destination.sessionId);
      }
      screenHistory.sync({ kind: "projects", hostId: entry.hostId });
      navigate({
        kind: "session",
        hostId: entry.hostId,
        sessionId: destination.sessionId,
        // The computer's name has its own place in the bar, so the title starts
        // empty and the loaded session supplies it; using the label here printed
        // the computer as the conversation's name.
        title: "",
      });
    },
    (destination) => {
      if (destination.kind !== "session") return;
      if (destination.notifyKind === "input.requested") {
        sessionViews.markInputPending(destination.hostId, destination.sessionId);
      }
      setNotice({
        kind: destination.notifyKind ?? "approval.requested",
        hostId: destination.hostId,
        sessionId: destination.sessionId,
      });
    },
  );

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
      // S1 Connect is the empty state of the Computers root (§17.3): a missing
      // computer never gates the rest of the app, because Chats lives beside it.
      <ConnectScreen
        onAddHost={() => navigate({ kind: "pair" })}
        onAddAccount={() => navigate({ kind: "account" })}
        onOpenSettings={() => navigate({ kind: "settings", from: "hosts" })}
      />
    ) : (
      <HostsScreen
        hosts={hosts}
        onOpenHost={(entry) => navigate({ kind: "projects", hostId: entry.hostId })}
        onAddHost={() => navigate({ kind: "pair" })}
        onAddAccount={() => navigate({ kind: "account" })}
        onOpenSettings={() => navigate({ kind: "settings", from: "hosts" })}
      />
    );

  const openSession = (hostId: string, session: RacpSession, project: { id: string; label: string }) =>
    navigate({
      kind: "session",
      hostId,
      sessionId: session.id,
      title: session.title,
      projectId: project.id,
      projectLabel: project.label,
    });

  /** The connection record is what every direct-chat screen reads. */
  const reloadConnection = useCallback(() => setConnection(directChatService().connection()), []);

  const body = (() => {
    if (screen.kind === "chats") {
      return (
        <ChatsScreen
          connection={connection}
          gatewayConfigured={modelGatewayOrigin !== null}
          onConnect={() => navigate({ kind: "modelGateway", from: "chats" })}
          onOpenSettings={() => navigate({ kind: "settings", from: "chats" })}
          onOpenModels={() => setModelsOpen(true)}
        />
      );
    }

    if (screen.kind === "modelGateway") {
      return (
        <ConnectGatewayScreen
          gatewayOrigin={modelGatewayOrigin}
          onBack={goBack}
          onConnected={() => {
            reloadConnection();
            // The verification is async: a user who already left this page must
            // not be moved again when it finishes.
            if (screenRef.current.kind === "modelGateway") goBack();
          }}
          onConnect={async (key) => {
            const outcome = await directChatService().connect(key);
            if (!outcome.ok) return { failure: outcome.failure, restricted: false };
            reloadConnection();
            return { failure: null, restricted: outcome.restricted };
          }}
        />
      );
    }

    if (screen.kind === "settings") {
      return (
        <SettingsScreen
          connection={connection}
          gatewayConfigured={modelGatewayOrigin !== null}
          onBack={goBack}
          onConnect={() =>
            navigate({ kind: "modelGateway", from: screen.from, viaSettings: true })
          }
          onDisconnect={async () => {
            await directChatService().disconnect();
            reloadConnection();
          }}
        />
      );
    }

    if (screen.kind === "chat" || screen.kind === "chatArchive") {
      // D3 and D4 arrive with the history stage: sending cannot precede saved
      // history (§6), so these kinds render the Chats root until then.
      return (
        <ChatsScreen
          connection={connection}
          gatewayConfigured={modelGatewayOrigin !== null}
          onConnect={() => navigate({ kind: "modelGateway", from: "chats" })}
          onOpenSettings={() => navigate({ kind: "settings", from: "chats" })}
          onOpenModels={() => setModelsOpen(true)}
        />
      );
    }
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
          onPaired={(entry) => navigate({ kind: "projects", hostId: entry.hostId })}
          onBack={goBack}
        />
      );
    }

    if (screen.kind === "projects") {
      const host = hosts.find((entry) => entry.hostId === screen.hostId);
      const credential = host ? credentialPort.credentialFor(host.hostId) : null;
      // A forgotten host (or a registry that no longer holds it) falls back to
      // the list rather than opening a screen without a credential.
      if (!host || !credential) return hostList;
      return (
        <ProjectsScreen
          hostId={host.hostId}
          hostLabel={host.label}
          credential={credential}
          {...(host.roles ? { roles: host.roles } : {})}
          onOpenProject={(project) =>
            navigate({
              kind: "projectSessions",
              hostId: host.hostId,
              projectId: project.id,
              projectLabel: project.label,
            })
          }
          onSoleProject={(project) =>
            navigate({
              kind: "projectSessions",
              hostId: host.hostId,
              projectId: project.id,
              projectLabel: project.label,
              viaProjects: false,
            })
          }
          onBack={goBack}
        />
      );
    }

    if (screen.kind === "projectSessions") {
      const host = hosts.find((entry) => entry.hostId === screen.hostId);
      const credential = host ? credentialPort.credentialFor(host.hostId) : null;
      if (!host || !credential) return hostList;
      const project = { id: screen.projectId, label: screen.projectLabel };
      return (
        <ProjectSessionsScreen
          hostId={host.hostId}
          hostLabel={host.label}
          projectId={screen.projectId}
          projectLabel={screen.projectLabel}
          credential={credential}
          {...(host.roles ? { roles: host.roles } : {})}
          onOpenSession={(session) => openSession(host.hostId, session, project)}
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

  // The bar on the two roots of a native build only (§4); every pushed page and
  // the whole browser build go without it. The rule is its own module because
  // the visibility and the root's name have to agree.
  const showTabBar = tabBarVisible(screen, { isNativeApp });
  const tabs = showTabBar ? <TabBar root={screen.kind} onSwitch={switchRoot} /> : null;

  return (
    <div
      className={`relative flex h-dvh flex-col overflow-hidden${showTabBar ? " rm-has-tabbar" : ""}`}
      data-gesture={swipe.state}
      style={
        swipe.offset > 0
          ? { transform: `translate3d(${swipe.offset}px, 0, 0)`, transition: "none" }
          : undefined
      }
    >
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
      {tabs}
      <ModelSheet
        open={modelsOpen}
        models={connection?.models ?? []}
        selectedId={connection?.lastModelId ?? null}
        onClose={() => setModelsOpen(false)}
        onSelect={(model) => {
          directChatService().rememberModel(model.id);
          reloadConnection();
        }}
      />
      {notice ? (
        <ForegroundNoticeBar
          notice={notice}
          onDismiss={() => setNotice(null)}
          onOpen={() => {
            const target = notice;
            setNotice(null);
            const host = hosts.find((entry) => entry.hostId === target.hostId);
            if (!host) {
              navigate({ kind: "hosts" });
              return;
            }
            // The same restored stack a tap builds, so the two paths cannot
            // diverge (§17.6.4).
            screenHistory.sync({ kind: "projects", hostId: target.hostId });
            navigate({ kind: "session", hostId: target.hostId, sessionId: target.sessionId, title: "" });
          }}
        />
      ) : null}
    </div>
  );
}
