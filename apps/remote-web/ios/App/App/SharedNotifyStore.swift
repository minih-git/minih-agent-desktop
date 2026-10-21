//
//  SharedNotifyStore.swift
//  App
//
//  The one place both targets agree on where a notification's facts live
//  (spec §17.6.2). Compiled into the app *and* the notification service
//  extension, so the extension reads exactly what the app wrote.
//
//  Two stores, because the two facts have different lifetimes:
//
//  - the Gateway origin and the "show the session title" switch are ordinary
//    defaults in the App Group, readable by either process;
//  - the device token is a secret and stays in a shared Keychain access group,
//    under an account name derived from the host id. The app's own credential
//    store (the Capacitor secure-storage plugin) cannot be read from another
//    process, which is why this mirror exists at all.
//
//  The access group is read from this target's own entitlements rather than
//  hard-coded: the group is `$(AppIdentifierPrefix)group.app.minih.remote`, and
//  the prefix differs per team.
//

import Foundation
import Security

enum SharedNotifyStore {
    /// The App Group both targets carry in their entitlements.
    static let appGroup = "group.app.minih.remote"

    /// Defaults key for the Gateway origin the app is built against.
    static let originKey = "gateway.origin"
    /// Defaults key for the user's "show the session title" answer.
    static let titleEnrichmentKey = "notify.showSessionTitle"
    /// Keychain account prefix; the host id completes it.
    static let tokenAccountPrefix = "notify-device-token."

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroup)
    }

    static var gatewayOrigin: String? {
        guard let value = defaults?.string(forKey: originKey), !value.isEmpty else { return nil }
        return value.hasSuffix("/") ? String(value.dropLast()) : value
    }

    /// Absent means "on": a fresh install should show a title it can fetch, and
    /// the switch exists to turn it off (§17.6.2).
    static var titleEnrichmentEnabled: Bool {
        guard let value = defaults?.object(forKey: titleEnrichmentKey) as? Bool else { return true }
        return value
    }

    /// The shared keychain group this build was signed with.
    ///
    /// Read from `Info.plist`, where the value is `$(AppIdentifierPrefix)` plus the
    /// group id — the prefix differs per team, so it cannot be a constant here, and
    /// reading the entitlement at runtime would need a private API. A nil answer
    /// means the capability is missing, which costs the title and nothing else.
    private static func accessGroup() -> String? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "MinihKeychainAccessGroup") as? String,
              !group.isEmpty
        else { return nil }
        return group
    }

    private static func query(hostId: String) -> [String: Any]? {
        guard let group = accessGroup() else { return nil }
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: appGroup,
            kSecAttrAccount as String: tokenAccountPrefix + hostId,
            kSecAttrAccessGroup as String: group,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
    }

    /// Write (or replace) the device token this Host's notifications need.
    @discardableResult
    static func saveToken(_ token: String, hostId: String) -> Bool {
        guard let group = accessGroup(), let data = token.data(using: .utf8) else { return false }
        // Upsert: delete first so an older item with a different protection class
        // cannot survive beside the new one.
        removeToken(hostId: hostId)
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: appGroup,
            kSecAttrAccount as String: tokenAccountPrefix + hostId,
            kSecAttrAccessGroup as String: group,
            kSecValueData as String: data,
            // The same protection class the app's own store uses: readable after
            // the first unlock, and never migrated to another device.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    static func removeToken(hostId: String) -> Bool {
        guard let query = query(hostId: hostId) else { return false }
        var delete = query
        delete.removeValue(forKey: kSecReturnData as String)
        delete.removeValue(forKey: kSecMatchLimit as String)
        let status = SecItemDelete(delete as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    static func token(hostId: String) -> String? {
        guard let query = query(hostId: hostId) else { return nil }
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty
        else { return nil }
        return token
    }
}
