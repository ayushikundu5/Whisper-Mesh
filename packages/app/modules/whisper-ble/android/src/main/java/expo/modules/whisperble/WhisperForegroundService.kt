package expo.modules.whisperble

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps the radio alive when the app is not on screen.
 *
 * This is not a nicety. Without a foreground service Android suspends the app's
 * process within minutes of backgrounding: the GATT server stops answering, the
 * advertiser goes quiet, and the phone silently drops out of the mesh while the
 * user believes it is still relaying. For a messenger whose whole premise is
 * working during an outage, silently stopping is the worst possible failure.
 *
 * The type is `connectedDevice`, which is the honest declaration — the app is
 * maintaining Bluetooth links to nearby devices — and it is what Android 14+
 * requires be declared for exactly this case.
 *
 * The notification is not overhead to be minimised away either. It is the only
 * signal a user has that the mesh is running and drawing power, and an offline
 * messenger that hides its battery cost is one people uninstall after a bad
 * afternoon.
 */
class WhisperForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Whisper Mesh"
        val body = intent?.getStringExtra(EXTRA_BODY) ?: "Relaying messages nearby"

        createChannel()

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        // START_STICKY: if the OS kills us under memory pressure, come back.
        // A relay that quietly stays dead is worse than one that restarts.
        return START_STICKY
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            "Mesh relay",
            // LOW, not MIN: the notification must stay visible so the battery
            // cost is never a surprise, but it should never make a sound.
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shown while this phone is carrying messages for nearby devices."
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    companion object {
        private const val CHANNEL_ID = "whisper-mesh-relay"
        // Any non-zero constant; it only has to be stable across restarts.
        private const val NOTIFICATION_ID = 8151
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_BODY = "body"

        fun start(context: Context, title: String, body: String) {
            val intent = Intent(context, WhisperForegroundService::class.java)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_BODY, body)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, WhisperForegroundService::class.java))
        }
    }
}
