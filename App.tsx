/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import React, {useMemo, useRef, useState} from 'react';
import {
  Alert,
  Button,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {BleManager, Device, Characteristic} from 'react-native-ble-plx';
import {Buffer} from 'buffer';

import RNFS from 'react-native-fs';
import Share from 'react-native-share';

const BMA400_SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
const BMA400_COMMAND_UUID = '12345678-1234-5678-1234-56789abcdef1';
const BMA400_DATA_UUID = '12345678-1234-5678-1234-56789abcdef2';

const DEVICE_NAMES: Record<number, string> = {
  1: 'BMA400_WRIST',
  2: 'BMA400_ANKLE_L',
  3: 'BMA400_ANKLE_R',
};

type DeviceDataset = {
  deviceId: number;
  deviceName: string;
  expectedSamples: number;
  receivedSamples: number;
  samplePeriodMs: number;
  readyToSend: boolean;
  receivingBinary: boolean;
  done: boolean;
  lines: string[];
};

const TARGET_DEVICE_IDS = [1, 2, 3] as const;

function getDeviceIdFromName(name?: string | null): number | null {
  if (name === 'BMA400_WRIST') {
    return 1;
  }

  if (name === 'BMA400_ANKLE_L') {
    return 2;
  }

  if (name === 'BMA400_ANKLE_R') {
    return 3;
  }

  return null;
}

function getDeviceName(deviceId: number): string {
  return DEVICE_NAMES[deviceId] ?? `UNKNOWN_${deviceId}`;
}

function base64ToBytes(value: string | null): Uint8Array {
  if (!value) {
    return new Uint8Array();
  }

  return Uint8Array.from(Buffer.from(value, 'base64'));
}

function bytesToText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

function textToBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readI16LE(bytes: Uint8Array, offset: number): number {
  const value = readU16LE(bytes, offset);
  return value >= 0x8000 ? value - 0x10000 : value;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }

  if (Platform.Version >= 31) {
    const scan = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    );

    const connect = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    );

    return (
      scan === PermissionsAndroid.RESULTS.GRANTED &&
      connect === PermissionsAndroid.RESULTS.GRANTED
    );
  }

  const location = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  );

  return location === PermissionsAndroid.RESULTS.GRANTED;
}

export default function App() {
  const manager = useMemo(() => new BleManager(), []);

  const [connectedCount, setConnectedCount] = useState(0);

  const datasetsRef = useRef<Record<number, DeviceDataset>>({});
  const connectedDevicesRef = useRef<Record<number, Device>>({});
  const textBuffersRef = useRef<Record<number, string>>({});
  const currentSessionIdRef = useRef('');
  const sendTriggeredRef = useRef(false);

  const [status, setStatus] = useState('IDLE');
  const [log, setLog] = useState<string[]>([]);

  const [csvReady, setCsvReady] = useState(false);
  const [sampleCount, setSampleCount] = useState(0);
  const [csvText, setCsvText] = useState('');

  const connectingDevicesRef = useRef<Record<number, boolean>>({});

  function addLog(message: string) {
    setLog(prev => [`${new Date().toLocaleTimeString()}  ${message}`, ...prev]);
  }

  function handleLine(deviceId: number, line: string) {
    if (!line) {
      return;
    }

    addLog(`RX: ${line}`);

    if (line === 'START_ACCEPTED') {
      setStatus('START_ACCEPTED');
    } else if (line === 'COLLECTING') {
      setStatus('COLLECTING');
    } else if (line === 'COLLECTION_DONE') {
      setStatus('COLLECTION_DONE');
    } else if (line.startsWith('ERROR,')) {
      setStatus(line);
    } else if (line.startsWith('STATUS,')) {
      setStatus(line);
    }
    if (line === 'READY_TO_SEND') {
      const previous = datasetsRef.current[deviceId];
    
      datasetsRef.current[deviceId] = {
        deviceId,
        deviceName: getDeviceName(deviceId),
        expectedSamples: previous?.expectedSamples ?? 0,
        receivedSamples: previous?.receivedSamples ?? 0,
        samplePeriodMs: previous?.samplePeriodMs ?? 0,
        readyToSend: true,
        receivingBinary: previous?.receivingBinary ?? false,
        done: previous?.done ?? false,
        lines: previous?.lines ?? [],
      };
    
      addLog(`${getDeviceName(deviceId)} ready to send`);
    
      const allReady = TARGET_DEVICE_IDS.every(
        id => datasetsRef.current[id]?.readyToSend,
      );
    
      if (allReady && !sendTriggeredRef.current) {
        sendTriggeredRef.current = true;
        setStatus('ALL_READY_TO_SEND');
        sendCommandToAll('SEND');
      }
    
      return;
  }
}

  function handleReceivedTextChunk(deviceId: number, chunk: string) {
    textBuffersRef.current[deviceId] = (textBuffersRef.current[deviceId] ?? '') + chunk;

    const parts = textBuffersRef.current[deviceId].split(/\r?\n/);
    textBuffersRef.current = parts.pop() ?? '';

    for (const rawLine of parts) {
      handleLine(deviceId, rawLine.trim());
    }
  }

  function handleBleNotification(deviceId: number, bytes: Uint8Array) {
    if (bytes.length === 0) {
      return;
    }
  
    const handledAsBinary = handleBinaryPacket(bytes);
  
    if (handledAsBinary) {
      return;
    }
  
    const text = bytesToText(bytes);
  
    if (text.length > 0) {
      handleReceivedTextChunk(deviceId, text);
    }
  }

  async function connectAndSetupNotify(deviceId: number, device: Device) {
    const deviceName = getDeviceName(deviceId);

    setStatus(`CONNECTING_${deviceName}`);
    addLog(`Connecting to ${deviceName}`);
  
    const connectedDevice = await device.connect();
  
    connectedDevicesRef.current[deviceId] = connectedDevice;
  
    await connectedDevice.discoverAllServicesAndCharacteristics();
  
    connectedDevice.monitorCharacteristicForService(
      BMA400_SERVICE_UUID,
      BMA400_DATA_UUID,
      (error, characteristic: Characteristic | null) => {
        if (error) {
          addLog(`Notify error ${deviceName}: ${error.message}`);
          setStatus('NOTIFY_ERROR');
          return;
        }
  
        const bytes = base64ToBytes(characteristic?.value ?? null);
  
        if (bytes.length > 0) {
          handleBleNotification(deviceId, bytes);
        }
      },
    );
  
    addLog(`Connected and notify enabled: ${deviceName}`);
  }

  async function scanAndConnect() {
    const ok = await requestBlePermissions();

  if (!ok) {
    Alert.alert('Brak uprawnień BLE');
    return;
  }

  setStatus('SCANNING');
  addLog('Scanning for BMA400 devices');

  manager.startDeviceScan(
    [BMA400_SERVICE_UUID],
    null,
    async (error, device) => {
      if (error) {
        addLog(`Scan error: ${error.message}`);
        setStatus('SCAN_ERROR');
        return;
      }

      if (!device) {
        return;
      }

      const name = device.name ?? device.localName ?? null;
      const deviceId = getDeviceIdFromName(name);

      if (!deviceId) {
        return;
      }

      if (
        connectedDevicesRef.current[deviceId] ||
        connectingDevicesRef.current[deviceId]
      ) {
        return;
      }

      connectingDevicesRef.current[deviceId] = true;

      addLog(`Found target: ${getDeviceName(deviceId)} / ${device.id}`);

      try {
        await connectAndSetupNotify(deviceId, device);

        const count = Object.keys(connectedDevicesRef.current).length;
        setConnectedCount(count);

        if (TARGET_DEVICE_IDS.every(id => connectedDevicesRef.current[id])) {
          manager.stopDeviceScan();
          setStatus('ALL_CONNECTED');
          addLog('All BMA400 devices connected');
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        addLog(`Connect/setup error ${getDeviceName(deviceId)}: ${message}`);
        setStatus('CONNECT_ERROR');
      } finally {
        connectingDevicesRef.current[deviceId] = false;
      }
    },
  );
  }

  async function sendCommandToDevice(deviceId: number, command: string) {
    const device = connectedDevicesRef.current[deviceId];
  
    if (!device) {
      addLog(`Device ${deviceId} not connected`);
      return;
    }
  
    await device.writeCharacteristicWithResponseForService(
      BMA400_SERVICE_UUID,
      BMA400_COMMAND_UUID,
      textToBase64(command),
    );
  
    addLog(`TX ${getDeviceName(deviceId)}: ${command}`);
  }

  async function sendCommandToAll(command: string) {
    for (const id of [1, 2, 3]) {
      await sendCommandToDevice(id, command);
    }
  }

  async function startMeasurement(durationMs: number) {
    const allConnected = TARGET_DEVICE_IDS.every(
      id => connectedDevicesRef.current[id],
    );
  
    if (!allConnected) {
      Alert.alert('Nie wszystkie urządzenia są połączone');
      return;
    }

    currentSessionIdRef.current = new Date()
  .toISOString()
  .replace(/[:.]/g, '-');
    
  datasetsRef.current = {};
  textBuffersRef.current = {};

  setCsvReady(false);
  setCsvText('');
  setSampleCount(0);
  setStatus('STARTING');

  await sendCommandToAll(`START,${durationMs}`);
  }

  function buildCombinedCsv() {
    const header =
      'session_id,device_id,device_name,sample_id,t_ms,ax_raw,ay_raw,az_raw,ax_mg,ay_mg,az_mg';
  
    const lines = [
      header,
      ...[1, 2, 3].flatMap(id => datasetsRef.current[id]?.lines ?? []),
    ];
  
    const csv = lines.join('\n') + '\n';
  
    const totalSamples = [1, 2, 3].reduce(
      (sum, id) => sum + (datasetsRef.current[id]?.receivedSamples ?? 0),
      0,
    );
  
    setCsvText(csv);
    setSampleCount(totalSamples);
    setCsvReady(true);
    setStatus('CSV_READY');
  
    addLog(`Combined CSV ready: ${totalSamples} samples`);
  }

  async function exportCsv() {
    if (!csvReady || csvText.length === 0) {
      Alert.alert('Brak gotowego CSV', 'Najpierw wykonaj pomiar.');
      return;
    }
  
    try {
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-');
  
      const fileName = `bma400_${timestamp}.csv`;
      const filePath = `${RNFS.CachesDirectoryPath}/${fileName}`;
  
      await RNFS.writeFile(filePath, csvText, 'utf8');
  
      addLog(`CSV saved to cache: ${fileName}`);
  
      await Share.open({
        title: 'Eksport CSV',
        url: `file://${filePath}`,
        type: 'text/csv',
        filename: fileName,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
  
      if (message.includes('User did not share')) {
        addLog('CSV export cancelled');
        return;
      }
  
      addLog(`CSV export error: ${message}`);
      Alert.alert('Błąd eksportu CSV', message);
    }
  }

  async function disconnect() {
    for (const [idText, device] of Object.entries(connectedDevicesRef.current)) {
      try {
        await device.cancelConnection();
        addLog(`Disconnected ${getDeviceName(Number(idText))}`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        addLog(`Disconnect error ${idText}: ${message}`);
      }
    }
  
    connectedDevicesRef.current = {};
    textBuffersRef.current = {};
  
    setStatus('DISCONNECTED');
    setConnectedCount(0);
  }

  function handleBinaryPacket(bytes: Uint8Array): boolean {
    if (bytes.length === 0) {
      return false;
    }
  
    const type = bytes[0];
  
    if (type === 0x10) {
      if (bytes.length !== 8) {
        addLog(`Invalid BEGIN packet length: ${bytes.length}`);
        setStatus('BINARY_BEGIN_ERROR');
        return true;
      }
      
      const deviceId = bytes[1];
      const expectedSamples = readU32LE(bytes, 2);
      const samplePeriodMs = readU16LE(bytes, 6);
      const deviceName = getDeviceName(deviceId);
  
      const previous = datasetsRef.current[deviceId];

      datasetsRef.current[deviceId] = {
        deviceId,
        deviceName,
        expectedSamples,
        receivedSamples: 0,
        samplePeriodMs,
        readyToSend: previous?.readyToSend ?? false,
        receivingBinary: true,
        done: false,
        lines: [],
      };
  
      setStatus('RECEIVING_BINARY');
  
      addLog(`BIN BEGIN: samples=${expectedSamples}, period=${samplePeriodMs} ms`);
      return true;
    }
  
    if (type === 0x01) {
      if (bytes.length !== 16) {
        addLog(`Invalid SAMPLE packet length: ${bytes.length}`);
        setStatus('BINARY_SAMPLE_ERROR');
        return true;
      }

      const deviceId = bytes[1];
      const dataset = datasetsRef.current[deviceId];
  
      if (!dataset || !dataset.receivingBinary) {
        addLog(`SAMPLE outside BEGIN/END, device=${deviceId}`);
        setStatus('BINARY_SEQUENCE_ERROR');
        return true;
      }
  

      const sampleId = readU32LE(bytes, 2);
      const tMs = readU32LE(bytes, 6);
      const ax = readI16LE(bytes, 10);
      const ay = readI16LE(bytes, 12);
      const az = readI16LE(bytes, 14);
  
      const axMg = ax * 1000.0 / 1024.0;
      const ayMg = ay * 1000.0 / 1024.0;
      const azMg = az * 1000.0 / 1024.0;
      
      dataset.lines.push(
        [
          currentSessionIdRef.current,
          deviceId,
          dataset.deviceName,
          sampleId,
          tMs,
          ax,
          ay,
          az,
          axMg.toFixed(3),
          ayMg.toFixed(3),
          azMg.toFixed(3),
        ].join(','),
      );
  
      dataset.receivedSamples = dataset.lines.length;

  const totalReceived = Object.values(datasetsRef.current).reduce(
    (sum, d) => sum + d.receivedSamples,
    0,
  );

  if (totalReceived % 20 === 0) {
    setSampleCount(totalReceived);
  }

  if (dataset.receivedSamples <= 3) {
    addLog(
      `BIN SAMPLE ${dataset.deviceName}: ${sampleId},${tMs},${ax},${ay},${az}`,
    );
  } else if (dataset.receivedSamples % 100 === 0) {
    addLog(
      `Receiving ${dataset.deviceName}: ${dataset.receivedSamples}/${dataset.expectedSamples}`,
    );
  }

  return true;
    }
  
    if (type === 0x11) {
      if (bytes.length !== 6) {
        addLog(`Invalid END packet length: ${bytes.length}`);
        setStatus('BINARY_END_ERROR');
        return true;
      }
  
      const deviceId = bytes[1];
      const dataset = datasetsRef.current[deviceId];

      const endCount = readU32LE(bytes, 2);
  
      if (!dataset) {
        addLog(`END for unknown device=${deviceId}`);
        setStatus('BINARY_SEQUENCE_ERROR');
        return true;
      }
    
      dataset.receivingBinary = false;
      dataset.done = dataset.receivedSamples === endCount;
    
      addLog(
        `BIN END ${dataset.deviceName}: endCount=${endCount}, received=${dataset.receivedSamples}`,
      );
    
      const allDone = [1, 2, 3].every(id => datasetsRef.current[id]?.done);
    
      if (allDone) {
        buildCombinedCsv();
      }
    
      return true;
    }
  
    return false;
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>BMA400 Logger</Text>
        <Text>Status: {status}</Text>
        <Text>Connected: {connectedCount}/3</Text>
        <Text>Samples: {sampleCount}</Text>
        <Text>CSV ready: {csvReady ? 'YES' : 'NO'}</Text>
        <Text>CSV chars: {csvText.length}</Text>
      </View>

      <View style={styles.buttons}>
        <Button title="Połącz BLE" onPress={scanAndConnect} />
        <Button title="PING all" onPress={() => sendCommandToAll('PING')} />
        <Button title="START 5s" onPress={() => startMeasurement(5000)} />
        <Button title="Eksportuj CSV" onPress={exportCsv} disabled={!csvReady} />
        <Button title="Rozłącz" onPress={disconnect} />
      </View>

      <ScrollView style={styles.log}>
        {log.map((line, index) => (
          <Text key={`${line}-${index}`} style={styles.logLine}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    padding: 16,
  },
  header: {
    marginBottom: 16,
    gap: 4,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
  },
  buttons: {
    gap: 8,
    marginBottom: 16,
  },
  log: {
    flex: 1,
    borderWidth: 1,
    padding: 8,
  },
  logLine: {
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo',
    fontSize: 12,
    marginBottom: 4,
  },
});