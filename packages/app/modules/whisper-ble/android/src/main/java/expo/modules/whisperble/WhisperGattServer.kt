package expo.modules.whisperble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * The GATT server: the half of a BLE mesh that lets a phone be *found* rather
 * than only go looking.
 *
 * Two characteristics, giving the layer above a symmetric duplex pipe over an
 * asymmetric link:
 *
 *   INBOX   write-without-response   central -> us
 *   OUTBOX  notify                   us -> central
 *
 * PEER IDENTITY, AND A DELIBERATE COMPROMISE. A central knows the peripheral's
 * ephemeral id because it read it from the advertisement. The reverse is not
 * true: all a GATT server sees is the central's (randomised) address. Rather
 * than add an in-band hello — which would put a non-fragment message into a
 * stream the reassembler is entitled to assume is all fragments — this reports
 * the address as the link handle.
 *
 * `PeerId` is explicitly an opaque, link-local handle in the core, so the two
 * ends of one link naming it differently is legal. The cost is that if both
 * sides dial each other anyway (possible once role arbitration's passive
 * timeout fires), one phone can hold two entries for one peer and send every
 * frame twice. The mesh dedups on message id, so this is wasted airtime rather
 * than duplicate delivery — a bandwidth bug, not a correctness one.
 */
@SuppressLint("MissingPermission")
class WhisperGattServer(
    private val context: Context,
    private val serviceUuid: UUID,
    private val inboxUuid: UUID,
    private val outboxUuid: UUID,
    private val listener: Listener,
) {
    interface Listener {
        fun onPeerConnected(peerId: String, mtu: Int)
        fun onPeerDisconnected(peerId: String)
        fun onChunk(peerId: String, data: ByteArray)
        fun onMtuChanged(peerId: String, mtu: Int)
        fun onError(scope: String, message: String)
    }

    private var server: BluetoothGattServer? = null
    private var outbox: BluetoothGattCharacteristic? = null

    private val peers = ConcurrentHashMap<String, BluetoothDevice>()
    private val mtus = ConcurrentHashMap<String, Int>()

    /** Centrals that enabled notifications. Pushing before this is silently dropped. */
    private val subscribed = ConcurrentHashMap<String, Boolean>()

    fun start() {
        if (server != null) return

        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val gattServer = manager.openGattServer(context, callback)
            ?: throw IllegalStateException("could not open GATT server; is Bluetooth on?")

        val inbox = BluetoothGattCharacteristic(
            inboxUuid,
            BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )

        val out = BluetoothGattCharacteristic(
            outboxUuid,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ,
        )
        // Without a CCCD the client has no way to turn notifications on, and the
        // whole peripheral-to-central direction is silently dead.
        out.addDescriptor(
            BluetoothGattDescriptor(
                CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
            )
        )

        val service = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(inbox)
        service.addCharacteristic(out)
        gattServer.addService(service)

        server = gattServer
        outbox = out
    }

    fun stop() {
        server?.close()
        server = null
        outbox = null
        peers.clear()
        mtus.clear()
        subscribed.clear()
    }

    fun mtuFor(peerId: String): Int = mtus[peerId] ?: DEFAULT_MTU

    /** Push one fragment. Returns false if the peer is gone or not subscribed. */
    fun notify(peerId: String, data: ByteArray): Boolean {
        val device = peers[peerId] ?: return false
        val characteristic = outbox ?: return false
        val gattServer = server ?: return false
        if (subscribed[peerId] != true) return false

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gattServer.notifyCharacteristicChanged(device, characteristic, false, data) ==
                BluetoothGatt.GATT_SUCCESS
        } else {
            @Suppress("DEPRECATION")
            characteristic.value = data
            @Suppress("DEPRECATION")
            gattServer.notifyCharacteristicChanged(device, characteristic, false)
        }
    }

    private val callback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            val peerId = device.address
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    peers[peerId] = device
                    listener.onPeerConnected(peerId, mtus[peerId] ?: DEFAULT_MTU)
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    peers.remove(peerId)
                    mtus.remove(peerId)
                    subscribed.remove(peerId)
                    listener.onPeerDisconnected(peerId)
                }
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            mtus[device.address] = mtu
            listener.onMtuChanged(device.address, mtu)
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (characteristic.uuid == inboxUuid) {
                // Fragments are self-describing and the mesh above tolerates
                // duplicates and reordering, so an offset write is not something
                // to reassemble here — it is a peer doing something we do not do.
                if (offset == 0) listener.onChunk(device.address, value)
            }
            if (responseNeeded) {
                server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (descriptor.uuid == CCCD_UUID) {
                subscribed[device.address] =
                    value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            }
            if (responseNeeded) {
                server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
            }
        }

        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                listener.onError("gatt", "service registration failed with status $status")
            }
        }
    }

    companion object {
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        const val DEFAULT_MTU = 23
    }
}
