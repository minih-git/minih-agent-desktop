//
//  MinihBackgroundPlugin.swift
//  App
//
//  Extra background time while a direct reply is streaming (ADR
//  mobile-direct-gateway-chat §6).
//
//  Backgrounding no longer cancels a reply, but iOS suspends a WebView within
//  seconds of leaving the foreground. `beginBackgroundTask` asks for a short
//  window (typically ~30 s) in which the stream can finish or at least reach its
//  next checkpoint. The grant is not a guarantee: whatever it does not cover
//  still ends as interrupted.
//
//  The plugin holds one task at a time and the JS side owns the lifecycle: it
//  calls `begin` when the first reply starts and `end` when the last one ends.
//  Calling either twice is harmless, and the expiry handler ends the task
//  itself, because a task that expires while still held is a crash.
//

import Capacitor
import UIKit

@objc(MinihBackgroundPlugin)
public class MinihBackgroundPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MinihBackgroundPlugin"
    public let jsName = "MinihBackground"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "begin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]

    private var task: UIBackgroundTaskIdentifier = .invalid

    /// Ask the system for more time; answering twice without `end` keeps one task.
    @objc func begin(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.task != .invalid {
                call.resolve(["active": true])
                return
            }
            self.task = UIApplication.shared.beginBackgroundTask(withName: "minih.direct-chat") { [weak self] in
                // The window is over: release it here, since a task that expires
                // while still held makes the system terminate the app.
                self?.endTask()
            }
            call.resolve(["active": self.task != .invalid])
        }
    }

    /// Give the time back as soon as the last reply ended.
    @objc func end(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.endTask()
            call.resolve(["active": false])
        }
    }

    private func endTask() {
        guard task != .invalid else { return }
        UIApplication.shared.endBackgroundTask(task)
        task = .invalid
    }
}
