package app.minih.remote;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The web layer's half of the notification bridge (spec §17.6.2), the Android
 * counterpart of `MinihNotifyPlugin.swift` in the iOS app: the same plugin name and
 * the same method names, so `src/lib/native-notify.ts` serves both platforms.
 */
@CapacitorPlugin(name = "MinihNotify")
public class MinihNotifyPlugin extends Plugin {

    /** Mirror one Host's facts for the messaging service. */
    @PluginMethod
    public void sync(PluginCall call) {
        String hostId = call.getString("hostId");
        String token = call.getString("token");
        if (hostId == null || hostId.isEmpty() || token == null || token.isEmpty()) {
            call.reject("hostId and token are required");
            return;
        }
        MinihNotifyStore.saveOrigin(getContext(), call.getString("origin"));
        MinihNotifyStore.saveToken(getContext(), hostId, token);
        JSObject result = new JSObject();
        result.put("saved", true);
        call.resolve(result);
    }

    /** Drop one Host's mirror when the user forgets that computer. */
    @PluginMethod
    public void forget(PluginCall call) {
        String hostId = call.getString("hostId");
        if (hostId == null || hostId.isEmpty()) {
            call.reject("hostId is required");
            return;
        }
        MinihNotifyStore.removeToken(getContext(), hostId);
        JSObject result = new JSObject();
        result.put("removed", true);
        call.resolve(result);
    }

    /**
     * The badge is per-notification on Android (`setNumber`), so this only answers;
     * clearing it is the system's job once the notifications are dismissed.
     */
    @PluginMethod
    public void setBadge(PluginCall call) {
        JSObject result = new JSObject();
        result.put("count", call.getInt("count", 0));
        call.resolve(result);
    }

    /** Record the user's answer to "show the session title". */
    @PluginMethod
    public void setTitleEnrichment(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("enabled is required");
            return;
        }
        MinihNotifyStore.setTitleEnrichment(getContext(), enabled);
        JSObject result = new JSObject();
        result.put("enabled", enabled);
        call.resolve(result);
    }

    /**
     * The tap that opened this app, once. A notification the app drew itself cannot
     * go through Capacitor's `pushNotificationActionPerformed`, so the intent
     * carries the ids and this hands them over exactly once.
     */
    @PluginMethod
    public void consumeTap(PluginCall call) {
        String raw = MinihNotifyStore.takePendingTap(getContext());
        if (raw == null) {
            call.resolve(new JSObject());
            return;
        }
        JSObject result = new JSObject();
        String[] parts = raw.split("\\u0000", -1);
        if (parts.length > 0) result.put("hostId", parts[0]);
        if (parts.length > 1) result.put("sessionId", parts[1]);
        if (parts.length > 2 && !parts[2].isEmpty()) result.put("approvalId", parts[2]);
        call.resolve(result);
    }
}
