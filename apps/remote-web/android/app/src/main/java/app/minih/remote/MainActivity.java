package app.minih.remote;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before the bridge starts, so the web layer can call it on the
        // first render: the app mirrors credentials for the messaging service and
        // reads the tap that opened it (spec §17.6.2).
        registerPlugin(MinihNotifyPlugin.class);
        super.onCreate(savedInstanceState);
        recordTap(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        recordTap(intent);
    }

    /**
     * Keep the ids of the notification that opened the app, for the web layer to
     * pick up. Written to the store rather than passed in memory, because the app
     * may be started cold by the tap and the bridge does not exist yet.
     */
    private void recordTap(Intent intent) {
        if (intent == null) return;
        String hostId = intent.getStringExtra("minihHostId");
        String sessionId = intent.getStringExtra("minihSessionId");
        if (hostId == null || sessionId == null) return;
        String approvalId = intent.getStringExtra("minihApprovalId");
        MinihNotifyStore.setPendingTap(this, hostId + "\u0000" + sessionId + "\u0000" + (approvalId == null ? "" : approvalId));
        // The extras are consumed once; a rotation must not resurrect them.
        intent.removeExtra("minihHostId");
        intent.removeExtra("minihSessionId");
        intent.removeExtra("minihApprovalId");
    }
}
