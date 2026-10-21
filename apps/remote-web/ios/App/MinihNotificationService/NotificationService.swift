//
//  NotificationService.swift
//  MinihRemoteNotificationService
//
//  Rewrites a notification's body with the session title, after the push has
//  arrived (spec §17.6.2). The title never travels through Apple: the payload
//  carries only a kind and ids, and this extension asks the user's own Gateway
//  for the one record it needs.
//
//  The budget is the whole design: iOS gives an extension about 30 seconds and
//  then calls `serviceExtensionTimeWillExpire`, so this one imposes a shorter
//  deadline (8 s) and delivers either way — the title if it arrived in time, the
//  fixed sentence from the payload's own localization key if not. A handler that
//  is never called is a notification that never appears, which is worse than a
//  notification without a title.
//

import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    /// The extension's own deadline, well inside the system's ~30 s.
    private static let deadline: TimeInterval = 8
    /// One request, shorter than the deadline so the answer still has time to
    /// reach the screen.
    private static let requestTimeout: TimeInterval = 1.5

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var delivered = false
    private var original: UNNotificationContent?
    private var task: Task<Void, Never>?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        self.original = request.content
        guard let mutable = request.content.mutableCopy() as? UNMutableNotificationContent else {
            deliver(request.content)
            return
        }
        task = Task { [weak self] in
            await self?.enrich(mutable, userInfo: request.content.userInfo)
            self?.deliver(mutable)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        // Whatever the task has or has not managed: give the system something.
        task?.cancel()
        deliverNothingHappened()
    }

    // MARK: - Enrichment

    private func enrich(_ content: UNMutableNotificationContent, userInfo: [AnyHashable: Any]) async {
        // Off means off: no request leaves the phone, and the lock screen shows
        // the payload's own sentence.
        guard SharedNotifyStore.titleEnrichmentEnabled else { return }
        guard let origin = SharedNotifyStore.gatewayOrigin,
              let hostId = userInfo["hostId"] as? String, !hostId.isEmpty,
              let sessionId = userInfo["sessionId"] as? String, !sessionId.isEmpty
        else { return }
        guard let token = SharedNotifyStore.token(hostId: hostId) else { return }
        guard let url = URL(string: "\(origin)/hosts/\(hostId)/v1/sessions") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        request.timeoutInterval = Self.requestTimeout

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return }
            guard let title = Self.sessionTitle(from: data, sessionId: sessionId), !title.isEmpty else { return }
            // The title is the body; the alert's title stays the kind's own label,
            // so "Needs your approval" is followed by what it is about.
            content.body = title
            content.userInfo = userInfo
        } catch {
            // A refused request, a missing credential, a timeout: the fixed
            // sentence is the answer (§17.6.2). Nothing is logged: the title is
            // the user's content and this process has no business recording it.
            return
        }
    }

    /// `{ "session": { "title": "…" } }` — one field, and nothing else is kept.
    private static func sessionTitle(from data: Data, sessionId: String) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let session = root["session"] as? [String: Any],
           let title = session["title"] as? String {
            return title
        }
        let container = (root["result"] as? [String: Any]) ?? root
        if let sessions = container["sessions"] as? [[String: Any]],
           let matched = sessions.first(where: { ($0["id"] as? String) == sessionId }),
           let title = matched["title"] as? String {
            return title
        }
        return nil
    }

    // MARK: - Delivery

    private func deliver(_ content: UNNotificationContent) {
        guard !delivered else { return }
        delivered = true
        contentHandler?(content)
        contentHandler = nil
    }

    /// Called when the system's deadline fires before the task finished: the
    /// notification is delivered exactly as it arrived, which is the fixed
    /// sentence the payload's localization key already provides.
    private func deliverNothingHappened() {
        guard !delivered else { return }
        guard let original else {
            // Nothing was handed in, so there is nothing to hand back. The system
            // then shows the notification it already has.
            contentHandler = nil
            return
        }
        deliver(original)
    }
}
