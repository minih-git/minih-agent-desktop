package app.minih.remote;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Builds the notification the user sees, from a data-only message (§17.6.6).
 *
 * The Gateway sends no `notification` block on purpose: a message that carries one
 * is drawn by the system while the app is in the background, and the app is never
 * called — so it could never put the session's name on the lock screen.
 *
 * Extends the Capacitor plugin's service so `super.onMessageReceived` still hands
 * the message to the web layer: the in-app notice of §17.6.4 listens there while
 * the app is open.
 */
public class MinihMessagingService extends MessagingService {

    private static final String CHANNEL_ID = "minih-remote";

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        String kind = data.get("kind");
        String hostId = data.get("hostId");
        String sessionId = data.get("sessionId");
        if (kind == null || hostId == null || sessionId == null) {
            // Not one of ours: let the plugin do whatever it does with it.
            super.onMessageReceived(message);
            return;
        }

        String title = text(data.get("titleKey"), "Minih Remote");
        String sessionTitle = MinihNotifyStore.fetchTitle(getApplicationContext(), hostId, sessionId);
        // The kind is the alert's title; the session's own name is the body, and the
        // message's fixed sentence is the body when the title could not be read.
        String body = sessionTitle != null ? sessionTitle : text(data.get("bodyKey"), "");

        show(title, body, data);
        // Still notify the web layer, so an open app shows its own notice instead of
        // a system banner (§17.6.4).
        super.onMessageReceived(message);
    }

    /** Resolve a localization key the way APNs does, from the app's own resources. */
    private String text(String key, String fallback) {
        if (key == null || key.isEmpty()) return fallback;
        String name = key.replace('.', '_').replace('-', '_');
        int id = getResources().getIdentifier(name, "string", getPackageName());
        return id == 0 ? fallback : getString(id);
    }

    private void show(String title, String body, Map<String, String> data) {
        Context context = getApplicationContext();
        ensureChannel(context);

        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra("minihHostId", data.get("hostId"));
        open.putExtra("minihSessionId", data.get("sessionId"));
        if (data.get("approvalId") != null) open.putExtra("minihApprovalId", data.get("approvalId"));
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(context, 0, open, flags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(notificationIcon(context))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pending);

        // Group one session's events together, exactly like APNs' thread-id.
        String sessionId = data.get("sessionId");
        if (sessionId != null) builder.setGroup(sessionId);
        // The launcher dot count, from the count the Host reported (§17.6.2).
        String attention = data.get("attentionCount");
        if (attention != null) {
            try {
                builder.setNumber(Integer.parseInt(attention));
            } catch (NumberFormatException ignored) {
                // A malformed count is not worth failing a notification over.
            }
        }

        try {
            NotificationManagerCompat.from(context).notify(notificationId(data), builder.build());
        } catch (SecurityException denied) {
            // The user has not granted POST_NOTIFICATIONS: nothing to show, and
            // nothing to retry. The in-app notice still appears when the app opens.
        }
    }

    /** One id per event, so two events about one session do not overwrite each other. */
    private int notificationId(Map<String, String> data) {
        String notifyId = data.get("notifyId");
        return notifyId == null ? 0 : notifyId.hashCode();
    }

    private void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Minih Remote", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Approvals, questions, and finished runs");
        manager.createNotificationChannel(channel);
    }

    /**
     * Android requires a small icon the app actually ships. Capacitor's default is
     * used when nothing better exists, because a notification with an unknown icon
     * resource is not drawn at all.
     */
    private int notificationIcon(Context context) {
        int id = getResources().getIdentifier("ic_stat_icon_config_sample", "drawable", getPackageName());
        if (id != 0) return id;
        id = getResources().getIdentifier("ic_launcher", "mipmap", getPackageName());
        return id != 0 ? id : android.R.drawable.ic_dialog_info;
    }
}
