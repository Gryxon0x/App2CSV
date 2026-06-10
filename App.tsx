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

  const [status, setStatus] = useState('IDLE');
  const [deviceName, setDeviceName] = useState<string>('-');
  const [log, setLog] = useState<string[]>([]);

  const [csvReady, setCsvReady] = useState(false);
  const [sampleCount, setSampleCount] = useState(0);
  const [csvText, setCsvText] = useState('');

  const deviceRef = useRef<Device | null>(null);
  const textBufferRef = useRef('');

  const csvLinesRef = useRef<string[]>([]);
  const expectedSamplesRef = useRef(0);
  const receivingBinaryRef = useRef(false);

  function addLog(message: string) {
    setLog(prev => [`${new Date().toLocaleTimeString()}  ${message}`, ...prev]);
  }

  function handleLine(line: string) {
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
  }

  function handleReceivedTextChunk(chunk: string) {
    textBufferRef.current += chunk;

    const parts = textBufferRef.current.split(/\r?\n/);
    textBufferRef.current = parts.pop() ?? '';

    for (const rawLine of parts) {
      handleLine(rawLine.trim());
    }
  }

  function handleBleNotification(bytes: Uint8Array) {
    if (bytes.length === 0) {
      return;
    }
  
    const handledAsBinary = handleBinaryPacket(bytes);
  
    if (handledAsBinary) {
      return;
    }
  
    const text = bytesToText(bytes);
  
    if (text.length > 0) {
      handleReceivedTextChunk(text);
    }
  }

  async function connectAndSetupNotify(device: Device) {
    setStatus('CONNECTING');
    addLog(`Connecting to ${device.name ?? device.id}`);

    const connectedDevice = await device.connect();
    deviceRef.current = connectedDevice;

    setStatus('DISCOVERING');
    addLog('Discovering services and characteristics');

    await connectedDevice.discoverAllServicesAndCharacteristics();

    setStatus('ENABLING_NOTIFY');
    addLog('Enabling notifications');

    connectedDevice.monitorCharacteristicForService(
      BMA400_SERVICE_UUID,
      BMA400_DATA_UUID,
      (error, characteristic: Characteristic | null) => {
        if (error) {
          addLog(`Notify error: ${error.message}`);
          setStatus('NOTIFY_ERROR');
          return;
        }

        const bytes = base64ToBytes(characteristic?.value ?? null);

        if (bytes.length > 0) {
          handleBleNotification(bytes);
        }
      },
    );

    setStatus('CONNECTED');
    setDeviceName(device.name ?? device.id);
    addLog('Connected and notify enabled');
  }

  async function scanAndConnect() {
    const ok = await requestBlePermissions();

    if (!ok) {
      Alert.alert('Brak uprawnień BLE');
      return;
    }

    setStatus('SCANNING');
    addLog('Scanning for BMA400 service');

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

        addLog(`Found: ${device.name ?? 'unknown'} / ${device.id}`);

        manager.stopDeviceScan();

        try {
          await connectAndSetupNotify(device);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          addLog(`Connect/setup error: ${message}`);
          setStatus('CONNECT_ERROR');
        }
      },
    );
  }

  async function sendCommand(command: string) {
    const device = deviceRef.current;

    if (!device) {
      Alert.alert('Brak połączenia z urządzeniem');
      return;
    }

    try {
      addLog(`TX: ${command}`);

      await device.writeCharacteristicWithResponseForService(
        BMA400_SERVICE_UUID,
        BMA400_COMMAND_UUID,
        textToBase64(command),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      addLog(`Write error: ${message}`);
      setStatus('WRITE_ERROR');
    }
  }

  async function startMeasurement(durationMs: number) {
    textBufferRef.current = '';
    
    csvLinesRef.current = [];
    expectedSamplesRef.current = 0;
    receivingBinaryRef.current = false;

    setCsvReady(false);
    setCsvText('');
    setSampleCount(0);
    setStatus('STARTING');

    await sendCommand(`START,${durationMs}`);
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
    const device = deviceRef.current;

    if (device) {
      await device.cancelConnection();
      deviceRef.current = null;
    }

    setStatus('DISCONNECTED');
    setDeviceName('-');
    addLog('Disconnected');
  }

  function handleBinaryPacket(bytes: Uint8Array): boolean {
    if (bytes.length === 0) {
      return false;
    }
  
    const type = bytes[0];
  
    if (type === 0x10) {
      if (bytes.length !== 7) {
        addLog(`Invalid BEGIN packet length: ${bytes.length}`);
        setStatus('BINARY_BEGIN_ERROR');
        return true;
      }
  
      const expectedSamples = readU32LE(bytes, 1);
      const samplePeriodMs = readU16LE(bytes, 5);
  
      csvLinesRef.current = [
        'sample_id,t_ms,ax_raw,ay_raw,az_raw,ax_mg,ay_mg,az_mg',
      ];
      expectedSamplesRef.current = expectedSamples;
      receivingBinaryRef.current = true;
  
      setCsvReady(false);
      setCsvText('');
      setSampleCount(0);
      setStatus('RECEIVING_BINARY');
  
      addLog(`BIN BEGIN: samples=${expectedSamples}, period=${samplePeriodMs} ms`);
      return true;
    }
  
    if (type === 0x01) {
      if (bytes.length !== 15) {
        addLog(`Invalid SAMPLE packet length: ${bytes.length}`);
        setStatus('BINARY_SAMPLE_ERROR');
        return true;
      }
  
      if (!receivingBinaryRef.current) {
        addLog('SAMPLE packet received outside BEGIN/END');
        setStatus('BINARY_SEQUENCE_ERROR');
        return true;
      }
  

      const sampleId = readU32LE(bytes, 1);
      const tMs = readU32LE(bytes, 5);
      const ax = readI16LE(bytes, 9);
      const ay = readI16LE(bytes, 11);
      const az = readI16LE(bytes, 13);
  
      const axMg = ax * 1000.0 / 1024.0;
      const ayMg = ay * 1000.0 / 1024.0;
      const azMg = az * 1000.0 / 1024.0;
      
      csvLinesRef.current.push(
        [
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
  
      const samples = csvLinesRef.current.length - 1;

      if (samples % 20 === 0) {
        setSampleCount(samples);
      }
  

      if (samples <= 3) {
        addLog(`BIN SAMPLE: ${sampleId},${tMs},${ax},${ay},${az}`);
      } else if (samples % 100 === 0) {
        addLog(`Receiving binary: ${samples}/${expectedSamplesRef.current}`);
      }
  
      return true;
    }
  
    if (type === 0x11) {
      if (bytes.length !== 5) {
        addLog(`Invalid END packet length: ${bytes.length}`);
        setStatus('BINARY_END_ERROR');
        return true;
      }
  
      const endCount = readU32LE(bytes, 1);
      const received = Math.max(csvLinesRef.current.length -1, 0);
  
      receivingBinaryRef.current = false;
  
      const csv = csvLinesRef.current.join('\n') + '\n';
  
      setCsvText(csv);
      setSampleCount(received);
      setCsvReady(received === endCount);
      setStatus(received === endCount ? 'CSV_READY' : 'CSV_INCOMPLETE');
  
      addLog(`BIN END: endCount=${endCount}, received=${received}`);
  
      if (received !== endCount) {
        addLog('WARNING: binary sample count mismatch');
      } else {
        addLog(`CSV ready: ${received} samples`);
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
        <Text>Device: {deviceName}</Text>
        <Text>Samples: {sampleCount}</Text>
        <Text>CSV ready: {csvReady ? 'YES' : 'NO'}</Text>
        <Text>CSV chars: {csvText.length}</Text>
      </View>

      <View style={styles.buttons}>
        <Button title="Połącz BLE" onPress={scanAndConnect} />
        <Button title="PING" onPress={() => sendCommand('PING')} />
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