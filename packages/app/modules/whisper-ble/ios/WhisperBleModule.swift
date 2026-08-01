import ExpoModulesCore
import CoreBluetooth

/**
 * The peripheral role on iOS.
 *
 * WHAT APPLE DOES NOT ALLOW, stated plainly because it changes what this app
 * can honestly claim on iOS:
 *
 *  1. A backgrounded app may advertise, but iOS strips the advertisement down
 *     to the 128-bit service UUID placed in the "overflow" area. Service *data*
 *     is dropped — and service data is where the ephemeral peer id lives. A
 *     backgrounded iPhone is therefore discoverable as "some Whisper device"
 *     with no id attached.
 *  2. The overflow area is only readable by another iOS device that is
 *     explicitly scanning for that exact UUID. Two backgrounded iPhones cannot
 *     discover each other. At all.
 *  3. Background scanning does not report service data either, and never
 *     reports duplicates, so RSSI-ranked connection policy degrades badly.
 *
 * The consequence is architectural, not a bug to be fixed: on iOS the mesh
 * works while the app is in the foreground, and an iPhone in someone's pocket
 * is at best a leaf node reachable by an Android peer, not a relay. That is
 * reported through `capabilities()` so the UI can say so rather than letting a
 * user believe they are carrying traffic when they are not.
 *
 * Android is the platform this mesh runs on. iOS is a client.
 */
public class WhisperBleModule: Module {

  private var manager: CBPeripheralManager?
  private var delegate: PeripheralDelegate?

  public func definition() -> ModuleDefinition {
    Name("WhisperBle")

    Events(
      "onPeerConnected",
      "onPeerDisconnected",
      "onChunk",
      "onMtuChanged",
      "onRadioError"
    )

    AsyncFunction("capabilities") { () -> [String: Bool] in
      return [
        "canAdvertise": true,
        "canRunGattServer": true,
        // Advertising continues in the background but without service data,
        // and only iOS-to-iOS in the overflow area. See the note above.
        "canAdvertiseInBackground": false,
        "canAdvertiseServiceData": true,
      ]
    }

    AsyncFunction("startAdvertising") { (payload: [String: Any]) in
      guard let uuidString = payload["serviceUuid"] as? String,
            let dataString = payload["serviceData"] as? String,
            let serviceData = Data(base64Encoded: dataString) else {
        throw Exception(name: "WhisperBle", description: "invalid advertise payload")
      }
      self.delegate?.startAdvertising(
        serviceUuid: CBUUID(string: uuidString),
        serviceData: serviceData
      )
    }

    AsyncFunction("stopAdvertising") {
      self.manager?.stopAdvertising()
    }

    AsyncFunction("startGattServer") { (config: [String: String]) in
      guard let serviceUuid = config["serviceUuid"],
            let inboxUuid = config["inboxCharacteristicUuid"],
            let outboxUuid = config["outboxCharacteristicUuid"] else {
        throw Exception(name: "WhisperBle", description: "invalid GATT config")
      }

      let delegate = PeripheralDelegate(
        serviceUuid: CBUUID(string: serviceUuid),
        inboxUuid: CBUUID(string: inboxUuid),
        outboxUuid: CBUUID(string: outboxUuid),
        emit: { [weak self] name, body in self?.sendEvent(name, body) }
      )
      self.delegate = delegate
      // `restoreIdentifier` lets iOS hand the peripheral session back after it
      // relaunches the app for a BLE event, which is the only reason a
      // backgrounded iPhone ever wakes up for the mesh at all.
      self.manager = CBPeripheralManager(
        delegate: delegate,
        queue: nil,
        options: [CBPeripheralManagerOptionRestoreIdentifierKey: "whisper-mesh"]
      )
      delegate.attach(manager: self.manager!)
    }

    AsyncFunction("stopGattServer") {
      self.manager?.stopAdvertising()
      self.manager?.removeAllServices()
      self.manager = nil
      self.delegate = nil
    }

    AsyncFunction("notify") { (peerId: String, data: String) in
      guard let bytes = Data(base64Encoded: data) else {
        throw Exception(name: "WhisperBle", description: "invalid base64")
      }
      guard self.delegate?.notify(peerId: peerId, data: bytes) == true else {
        throw Exception(name: "WhisperBle", description: "peer unreachable: \(peerId)")
      }
    }

    AsyncFunction("mtuFor") { (peerId: String) -> Int in
      return self.delegate?.mtu(for: peerId) ?? 23
    }

    // Android-only concepts. iOS has no equivalent: background execution is
    // granted by CoreBluetooth's background mode, not by a service we start.
    AsyncFunction("startForegroundService") { (_: String, _: String) in }
    AsyncFunction("stopForegroundService") { }
  }
}

private class PeripheralDelegate: NSObject, CBPeripheralManagerDelegate {
  private let serviceUuid: CBUUID
  private let inboxUuid: CBUUID
  private let outboxUuid: CBUUID
  private let emit: (String, [String: Any]) -> Void

  private weak var manager: CBPeripheralManager?
  private var outbox: CBMutableCharacteristic?
  private var subscribers: [String: CBCentral] = [:]
  private var pendingAdvertisement: [String: Any]?

  init(
    serviceUuid: CBUUID,
    inboxUuid: CBUUID,
    outboxUuid: CBUUID,
    emit: @escaping (String, [String: Any]) -> Void
  ) {
    self.serviceUuid = serviceUuid
    self.inboxUuid = inboxUuid
    self.outboxUuid = outboxUuid
    self.emit = emit
  }

  func attach(manager: CBPeripheralManager) {
    self.manager = manager
  }

  func startAdvertising(serviceUuid: CBUUID, serviceData: Data) {
    // CBAdvertisementDataServiceDataKey is accepted in the foreground only;
    // backgrounded, iOS silently drops everything but the UUID.
    let advertisement: [String: Any] = [
      CBAdvertisementDataServiceUUIDsKey: [serviceUuid],
      CBAdvertisementDataServiceDataKey: [serviceUuid: serviceData],
    ]

    guard let manager = manager, manager.state == .poweredOn else {
      pendingAdvertisement = advertisement
      return
    }
    manager.stopAdvertising()
    manager.startAdvertising(advertisement)
  }

  func notify(peerId: String, data: Data) -> Bool {
    guard let manager = manager,
          let outbox = outbox,
          let central = subscribers[peerId] else { return false }
    // Returns false when the transmit queue is full. The mesh above floods
    // redundantly, so dropping here is a lost fragment, not a lost message.
    return manager.updateValue(data, for: outbox, onSubscribedCentrals: [central])
  }

  func mtu(for peerId: String) -> Int {
    // iOS reports the usable payload directly; the transport subtracts the ATT
    // header, so add it back to keep one convention across platforms.
    guard let central = subscribers[peerId] else { return 23 }
    return central.maximumUpdateValueLength + 3
  }

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    guard peripheral.state == .poweredOn else {
      emit("onRadioError", ["scope": "adapter", "message": "bluetooth unavailable"])
      return
    }
    publishService(on: peripheral)
    if let advertisement = pendingAdvertisement {
      peripheral.startAdvertising(advertisement)
      pendingAdvertisement = nil
    }
  }

  private func publishService(on peripheral: CBPeripheralManager) {
    let inbox = CBMutableCharacteristic(
      type: inboxUuid,
      properties: [.writeWithoutResponse],
      value: nil,
      permissions: [.writeable]
    )
    let out = CBMutableCharacteristic(
      type: outboxUuid,
      properties: [.notify],
      value: nil,
      permissions: [.readable]
    )
    let service = CBMutableService(type: serviceUuid, primary: true)
    service.characteristics = [inbox, out]

    peripheral.removeAllServices()
    peripheral.add(service)
    outbox = out
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    let peerId = central.identifier.uuidString
    subscribers[peerId] = central
    emit("onPeerConnected", ["peerId": peerId, "mtu": central.maximumUpdateValueLength + 3])
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    let peerId = central.identifier.uuidString
    subscribers.removeValue(forKey: peerId)
    emit("onPeerDisconnected", ["peerId": peerId])
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    didReceiveWrite requests: [CBATTRequest]
  ) {
    for request in requests {
      guard request.characteristic.uuid == inboxUuid, let value = request.value else { continue }
      emit(
        "onChunk",
        [
          "peerId": request.central.identifier.uuidString,
          "data": value.base64EncodedString(),
        ]
      )
    }
    // Write-without-response still requires exactly one response for the batch.
    if let first = requests.first {
      peripheral.respond(to: first, withResult: .success)
    }
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    willRestoreState state: [String: Any]
  ) {
    // iOS relaunched us for a BLE event. Republishing here is what keeps a
    // restored session usable instead of silently inert.
    publishService(on: peripheral)
  }
}
