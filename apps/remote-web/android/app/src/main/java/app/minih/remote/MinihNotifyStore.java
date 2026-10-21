package app.minih.remote;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Where the notification service reads what it needs to name a session
 * (spec §17.6.2).
 *
 * Android has no service extension: the app builds the notification itself from a
 * data-only message, so the same process both writes these facts and reads them.
 * They still live in their own store rather than in the Capacitor secure storage,
 * because that plugin's API is only reachable from the web layer, and the FCM
 * service runs without a bridge.
 *
 * What is stored: the Gateway origin, the user's "show the session title" answer,
 * and one device token per paired Host. The token is the same secret the app keeps
 * in the plugin's Keystore-backed store; this copy is in the app's private
 * directory, which `android:allowBackup="false"` keeps out of backups.
 */
final class MinihNotifyStore {

    private static final String PREFS = "minih_notify";
    private static final String ORIGIN = "gateway.origin";
    private static final String TITLE_ENRICHMENT = "notify.showSessionTitle";
    private static final String TOKEN_PREFIX = "notify-device-token.";
    /** The tap that has not been handled yet, written by {@link MainActivity}. */
    private static final String PENDING_TAP = "pending.tap";

    private static final int CONNECT_TIMEOUT_MS = 4000;
    private static final int READ_TIMEOUT_MS = 4000;

    private MinihNotifyStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void saveOrigin(Context context, String origin) {
        if (origin == null || origin.isEmpty()) return;
        prefs(context).edit().putString(ORIGIN, origin).apply();
    }

    static String origin(Context context) {
        String value = prefs(context).getString(ORIGIN, null);
        if (value == null || value.isEmpty()) return null;
        return value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
    }

    /** Absent means on: a fresh install should name the session (§17.6.2). */
    static boolean titleEnrichmentEnabled(Context context) {
        return prefs(context).getBoolean(TITLE_ENRICHMENT, true);
    }

    static void setTitleEnrichment(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(TITLE_ENRICHMENT, enabled).apply();
    }

    static void saveToken(Context context, String hostId, String token) {
        if (hostId == null || hostId.isEmpty() || token == null || token.isEmpty()) return;
        prefs(context).edit().putString(TOKEN_PREFIX + hostId, token).apply();
    }

    static void removeToken(Context context, String hostId) {
        if (hostId == null || hostId.isEmpty()) return;
        prefs(context).edit().remove(TOKEN_PREFIX + hostId).apply();
    }

    static String token(Context context, String hostId) {
        if (hostId == null || hostId.isEmpty()) return null;
        String value = prefs(context).getString(TOKEN_PREFIX + hostId, null);
        return value == null || value.isEmpty() ? null : value;
    }

    static void setPendingTap(Context context, String value) {
        prefs(context).edit().putString(PENDING_TAP, value).apply();
    }

    /** Read the pending tap and clear it: one tap is handled once. */
    static String takePendingTap(Context context) {
        String value = prefs(context).getString(PENDING_TAP, null);
        if (value != null) prefs(context).edit().remove(PENDING_TAP).apply();
        return value;
    }

    /**
     * The session title, from the user's own Gateway. Blocking, because the caller
     * is the FCM service worker, which may run for only a few seconds after the
     * message arrives; the timeouts are short for the same reason.
     *
     * Returns null on anything unexpected — a refused request, a missing
     * credential, a body without a title — and the caller then shows the fixed
     * sentence the message already carries.
     */
    static String fetchTitle(Context context, String hostId, String sessionId) {
        if (!titleEnrichmentEnabled(context)) return null;
        String origin = origin(context);
        String token = token(context, hostId);
        if (origin == null || token == null || sessionId == null || sessionId.isEmpty()) return null;

        HttpURLConnection connection = null;
        try {
            URL url = new URL(origin + "/v1/sessions/" + sessionId);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("accept", "application/json");
            connection.setRequestProperty("authorization", "Bearer " + token);
            if (connection.getResponseCode() < 200 || connection.getResponseCode() >= 300) return null;

            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), "UTF-8"))) {
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
            }
            JSONObject session = new JSONObject(body.toString()).optJSONObject("session");
            if (session == null) return null;
            String title = session.optString("title", "");
            return title.isEmpty() ? null : title;
        } catch (Exception error) {
            // A timeout, a refused connection, malformed JSON: the fixed sentence is
            // the answer. Nothing is logged — a title is the user's content.
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
