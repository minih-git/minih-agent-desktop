//
//  MinihBridgeViewController.swift
//  App
//
//  The one place the app's local plugins are registered. Capacitor discovers
//  plugins from a package, but this client ships one small plugin of its own —
//  the bridge to the notification service extension (§17.6.2) — and a local
//  plugin has to be handed to the bridge by the view controller that owns it.
//

import Capacitor
import UIKit

class MinihBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(MinihNotifyPlugin())
    }
}
