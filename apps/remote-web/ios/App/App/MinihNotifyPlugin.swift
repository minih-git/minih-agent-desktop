//
//  MinihNotifyPlugin.swift
//  App
//
//  What the web layer needs from the native side to make notifications work
//  (spec §17.6.2): mirror a device credential where the notification service
//  extension can read it, set the app badge, and record the "show the session
//  title" answer.
//
//  The plugin holds no state of its own. `SharedNotifyStore` owns the two
//  stores, and the JS side decides when they change (pairing, account adoption,
//  forgetting a computer, the settings switch).
//

import Capacitor
import UIKit
import UserNotifications

@objc(MinihNotifyPlugin)
public class MinihNotifyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MinihNotifyPlugin"
    public let jsName = "MinihNotify"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBadge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTitleEnrichment", returnType: CAPPluginReturnPromise),
    ]

    /// Mirror the facts the extension needs for one Host.
    @objc func sync(_ call: CAPPluginCall) {
        guard let hostId = call.getString("hostId"), !hostId.isEmpty else {
            call.reject("hostId is required")
            return
        }
        guard let token = call.getString("token"), !token.isEmpty else {
            call.reject("token is required")
            return
        }
        let origin = call.getString("origin") ?? ""
        if !origin.isEmpty {
            UserDefaults(suiteName: SharedNotifyStore.appGroup)?.set(origin, forKey: SharedNotifyStore.originKey)
        }
        let saved = SharedNotifyStore.saveToken(token, hostId: hostId)
        // A failed write is not fatal: the only consequence is that this Host's
        // notifications show the fixed sentence, and the app keeps working.
        call.resolve(["saved": saved])
    }

    /// Drop one Host's mirrored token, when the user forgets that computer.
    @objc func forget(_ call: CAPPluginCall) {
        guard let hostId = call.getString("hostId"), !hostId.isEmpty else {
            call.reject("hostId is required")
            return
        }
        call.resolve(["removed": SharedNotifyStore.removeToken(hostId: hostId)])
    }

    /// Set the launcher badge to the count of decisions still waiting.
    @objc func setBadge(_ call: CAPPluginCall) {
        let count = max(0, call.getInt("count") ?? 0)
        // `setBadgeCount` arrived in iOS 16; the deployment target is 15, where the
        // older property still does the same job.
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(count) { error in
                if let error {
                    call.reject("could not set the badge: \(error.localizedDescription)")
                    return
                }
                call.resolve(["count": count])
            }
        } else {
            DispatchQueue.main.async {
                UIApplication.shared.applicationIconBadgeNumber = count
                call.resolve(["count": count])
            }
        }
    }

    /// Record the user's answer to "show the session title".
    @objc func setTitleEnrichment(_ call: CAPPluginCall) {
        guard let enabled = call.getBool("enabled") else {
            call.reject("enabled is required")
            return
        }
        UserDefaults(suiteName: SharedNotifyStore.appGroup)?.set(enabled, forKey: SharedNotifyStore.titleEnrichmentKey)
        call.resolve(["enabled": enabled])
    }
}
