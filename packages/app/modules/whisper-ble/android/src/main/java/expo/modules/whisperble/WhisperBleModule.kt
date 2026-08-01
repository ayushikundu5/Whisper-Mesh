package expo.modules.whisperble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.ParcelUuid
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

/**
 * Bridge for the BLE peripheral role.
 *
 * Everything here is mechanism. Policy — when to advertise, how hard to scan,
 * which peers to dial — lives in `@whisper/core` where it can be tested without
 * a radio. This module does what it is told and reports what happened.
 */
/** Reserved by the SIG for internal use: assigned to no company, so it collides with none. */
private const val MANUFACTURER_ID = 0xFFFF

@SuppressLint("MissingPermission")
class WhisperBleModule : Module(), WhisperGattServer.Listener {

    private var advertiser: BluetoothLeAdvertiser? = null
    private var gattServer: WhisperGattServer? = null
    private var advertiseCallback: AdvertiseCallback? = null

    override fun definition() = ModuleDefinition {
        Name("WhisperBle")

        Events(
            "onPeerConnected",
            "onPeerDisconnected",
            "onChunk",
            "onMtuChanged",
            "onRadioError",
        )

        AsyncFunction("capabilities") {
            val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            val adapter = manager?.adapter
            mapOf(
                "canAdvertise" to (adapter?.isMultipleAdvertisementSupported == true),
                "canRunGattServer" to (adapter != null),
                // Android keeps both alive behind a foreground service. This is
                // the platform the mesh actually works on; see the Swift side
                // for what iOS gives up.
                "canAdvertiseInBackground" to true,
                "canAdvertiseServiceData" to true,
            )
        }

        AsyncFunction("startAdvertising") { payload: Map<String, Any> ->
            startAdvertising(
                serviceUuid = UUID.fromString(payload["serviceUuid"] as String),
                serviceData = Base64.decode(payload["serviceData"] as String, Base64.NO_WRAP),
                intervalMs = (payload["intervalMs"] as? Number)?.toInt() ?: 1000,
            )
        }

        AsyncFunction("stopAdvertising") { stopAdvertising() }

        AsyncFunction("startGattServer") { config: Map<String, String> ->
            gattServer?.stop()
            gattServer = WhisperGattServer(
                context = context,
                serviceUuid = UUID.fromString(config["serviceUuid"]),
                inboxUuid = UUID.fromString(config["inboxCharacteristicUuid"]),
                outboxUuid = UUID.fromString(config["outboxCharacteristicUuid"]),
                listener = this@WhisperBleModule,
            ).apply { start() }
        }

        AsyncFunction("stopGattServer") {
            gattServer?.stop()
            gattServer = null
        }

        AsyncFunction("notify") { peerId: String, data: String ->
            val bytes = Base64.decode(data, Base64.NO_WRAP)
            val sent = gattServer?.notify(peerId, bytes) ?: false
            if (!sent) throw IllegalStateException("peer unreachable: $peerId")
        }

        AsyncFunction("mtuFor") { peerId: String ->
            gattServer?.mtuFor(peerId) ?: WhisperGattServer.DEFAULT_MTU
        }

        AsyncFunction("startForegroundService") { title: String, body: String ->
            WhisperForegroundService.start(context, title, body)
        }

        AsyncFunction("stopForegroundService") {
            WhisperForegroundService.stop(context)
        }

        OnDestroy {
            stopAdvertising()
            gattServer?.stop()
            gattServer = null
        }
    }

    private val context: Context
        get() = requireNotNull(appContext.reactContext) { "no react context" }

    private fun startAdvertising(serviceUuid: UUID, serviceData: ByteArray, intervalMs: Int) {
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val adapter = manager.adapter ?: throw IllegalStateException("no bluetooth adapter")
        if (!adapter.isEnabled) throw IllegalStateException("bluetooth is off")

        // Restarting an advertisement that has not changed costs a radio reset
        // for nothing, and the duty-cycle controller calls this every second.
        stopAdvertising()

        val le = adapter.bluetoothLeAdvertiser
            ?: throw IllegalStateException("this device cannot advertise")

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(advertiseModeFor(intervalMs))
            // Low power is not a nicety here: transmit power is the second
            // largest radio cost after scanning, and a mesh gains far more from
            // many short hops than from a few long ones.
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0)
            .build()

        // The peer id goes in service *data*, not the service UUID, so the UUID
        // stays a constant everyone can scan-filter on while the id underneath
        // it rotates.
        //
        // The two cannot share one packet. A legacy advertisement is 31 bytes:
        // flags take 3, and a 128-bit UUID costs 18 in the service-uuid field
        // and another 18 before a single data byte in the service-data field —
        // 46 in total, which the adapter rejects outright with
        // ADVERTISE_FAILED_DATA_TOO_LARGE and no advertisement at all.
        //
        // So they are split across the two packets a scan already collects. The
        // UUID stays in the advertisement, because ScanFilter matches on the
        // service-uuid field and nothing else; the id rides in the scan
        // response, which an active scan requests as a matter of course and
        // Android merges into the same ScanRecord. The scanner sees both.
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false) // a device name is a stable identifier
            .setIncludeTxPowerLevel(false)
            .addServiceUuid(ParcelUuid(serviceUuid))
            .build()

        // Manufacturer data, not service data. Keyed by a 128-bit UUID, service
        // data spends 18 of the scan response's 31 bytes restating a UUID the
        // advertisement already carries, and adapters reject the result far
        // more readily than 25-of-31 suggests. The same payload under a company
        // id costs 11. 0xFFFF is reserved by the SIG for internal use, so it
        // belongs to nobody and collides with nobody.
        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addManufacturerData(MANUFACTURER_ID, serviceData)
            .build()

        val callback = object : AdvertiseCallback() {
            override fun onStartFailure(errorCode: Int) {
                sendEvent(
                    "onRadioError",
                    mapOf("scope" to "advertise", "message" to advertiseError(errorCode)),
                )
            }
        }

        le.startAdvertising(settings, data, scanResponse, callback)
        advertiser = le
        advertiseCallback = callback
    }

    private fun stopAdvertising() {
        val callback = advertiseCallback ?: return
        runCatching { advertiser?.stopAdvertising(callback) }
        advertiseCallback = null
    }

    /**
     * Android exposes three coarse advertising modes rather than an interval.
     * Map the requested interval onto the nearest: roughly 100ms, 250ms and 1s.
     */
    private fun advertiseModeFor(intervalMs: Int): Int = when {
        intervalMs <= 300 -> AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY
        intervalMs <= 1200 -> AdvertiseSettings.ADVERTISE_MODE_BALANCED
        else -> AdvertiseSettings.ADVERTISE_MODE_LOW_POWER
    }

    private fun advertiseError(code: Int): String = when (code) {
        AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE ->
            "advertisement payload exceeds 31 bytes"
        AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS ->
            "too many advertisers on this device"
        AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED -> "already advertising"
        AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR -> "internal bluetooth stack error"
        AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED ->
            "this device does not support advertising"
        else -> "advertising failed with code $code"
    }

    // --------------------------------------------------- GATT server events

    override fun onPeerConnected(peerId: String, mtu: Int) {
        sendEvent("onPeerConnected", mapOf("peerId" to peerId, "mtu" to mtu))
    }

    override fun onPeerDisconnected(peerId: String) {
        sendEvent("onPeerDisconnected", mapOf("peerId" to peerId))
    }

    override fun onChunk(peerId: String, data: ByteArray) {
        sendEvent(
            "onChunk",
            mapOf("peerId" to peerId, "data" to Base64.encodeToString(data, Base64.NO_WRAP)),
        )
    }

    override fun onMtuChanged(peerId: String, mtu: Int) {
        sendEvent("onMtuChanged", mapOf("peerId" to peerId, "mtu" to mtu))
    }

    override fun onError(scope: String, message: String) {
        sendEvent("onRadioError", mapOf("scope" to scope, "message" to message))
    }
}
