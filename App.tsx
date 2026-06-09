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

const BMA400_SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
const BMA400_COMMAND_UUID = '12345678-1234-5678-1234-56789abcdef1';
const BMA400_DATA_UUID = '12345678-1234-5678-1234-56789abcdef2';

function base64ToText(value: string | null): string {
  if (!value) {
    return '';
  }

  return Buffer.from(value, 'base64').toString('utf8');
}

function textToBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
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
  const receivingCsvRef = useRef(false);

  function addLog(message: string) {
    setLog(prev => [`${new Date().toLocaleTimeString()}  ${message}`, ...prev]);
  }

  function handleLine(line: string) {
    if (!line) {
      return;
    }

    if (line === 'BEGIN_CSV') {
      receivingCsvRef.current = true;
      csvLinesRef.current = [];

      setCsvReady(false);
      setCsvText('');
      setSampleCount(0);
      setStatus('RECEIVING_CSV');

      addLog('RX: BEGIN_CSV');
      return;
    }

    if (line === 'END_CSV') {
      receivingCsvRef.current = false;

      const text = csvLinesRef.current.join('\n') + '\n';
      const samples = Math.max(csvLinesRef.current.length - 1, 0);

      setCsvText(text);
      setSampleCount(samples);
      setCsvReady(true);
      setStatus('CSV_READY');

      addLog('RX: END_CSV');
      addLog(`CSV ready: ${samples} samples`);
      return;
    }

    if (receivingCsvRef.current) {
      csvLinesRef.current.push(line);

      const lines = csvLinesRef.current.length;
      const samples = Math.max(lines - 1, 0);

      setSampleCount(samples);

      if (samples % 100 === 0 && samples > 0) {
        addLog(`Receiving CSV: ${samples} samples`);
      }

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

        const text = base64ToText(characteristic?.value ?? null);

        if (text.length > 0) {
          handleReceivedTextChunk(text);
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
    csvLinesRef.current = [];
    receivingCsvRef.current = false;
    textBufferRef.current = '';

    setCsvReady(false);
    setCsvText('');
    setSampleCount(0);
    setStatus('STARTING');

    await sendCommand(`START,${durationMs}`);
  }

  async function disconnect() {
    const device = deviceRef.current;

    if (device) {
      await device.cancelConnection();
      deviceRef.current = null;
    }

    receivingCsvRef.current = false;

    setStatus('DISCONNECTED');
    setDeviceName('-');
    addLog('Disconnected');
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