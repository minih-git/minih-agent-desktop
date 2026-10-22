//
//  MinihBridgeViewController.swift
//  App
//
//  The one place the app's local plugins are registered. Capacitor discovers
//  plugins from a package, but this client ships two small plugins of its own —
//  the bridge to the notification service extension (§17.6.2) and the extra
//  background time a streaming reply asks for (ADR §6) — and a local plugin has
//  to be handed to the bridge by the view controller that owns it.
//

import Capacitor
import UIKit

class MinihBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(MinihNotifyPlugin())
        bridge?.registerPluginInstance(MinihBackgroundPlugin())
    }
}
