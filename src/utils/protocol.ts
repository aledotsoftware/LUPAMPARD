// LU-PAMPA V8 Protocol Serialization, Deserialization, CRC16, and Base85 utilities.
import { rs_encode, rs_decode } from "./reedsolomon";

// Protocol constants
export const SYNC_BYTE = 0x7E;

export const FrameType = {
  TEXTO: 0x01,
  FRAGMENTO: 0x02,
  TOKEN: 0x03,
  ACK: 0x04,
  BALIZA: 0x05
} as const;

export type FrameType = typeof FrameType[keyof typeof FrameType];

export interface LU_PAMPA_Frame {
  origenLicencia: string; // 7 bytes padded
  origenNodo: number;     // 2 bytes (0-65535)
  destinoLicencia: string;// 7 bytes padded
  destinoNodo: number;    // 2 bytes (0-65535)
  archivoId: number;      // 1 byte (0-255)
  secuenciaId: number;    // 2 bytes (0-65535)
  tipo: FrameType;        // 1 byte
  payload: Uint8Array;    // Variable length
}

/**
 * Calculates standard CRC-16 CCITT (polynomial 0x1021, initial value 0xFFFF, no reflection).
 */
export function crc16(data: Uint8Array): number {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= (data[i] << 8);
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc;
}

/**
 * Calculates dynamic Reed-Solomon symbol size based on the message length before FEC.
 * Uses ~25% FEC with a minimum of 6 parity symbols (corrects up to 3 errors).
 */
export function getFECSize(dataLength: number): number {
  return Math.max(6, Math.ceil(dataLength * 0.25));
}

function padCallsign(callsign: string): Uint8Array {
  const arr = new Uint8Array(7);
  arr.fill(32); // Fill with ASCII spaces
  const clean = callsign.trim().toUpperCase().slice(0, 7);
  for (let i = 0; i < clean.length; i++) {
    arr[i] = clean.charCodeAt(i);
  }
  return arr;
}

function parseCallsign(arr: Uint8Array): string {
  let str = "";
  for (let i = 0; i < arr.length; i++) {
    str += String.fromCharCode(arr[i]);
  }
  return str.trim();
}

/**
 * Serializes a frame into its raw binary format including SYNC, headers, payload, CRC16, and Reed-Solomon FEC.
 */
export function serializeFrame(frame: LU_PAMPA_Frame): Uint8Array {
  const payloadLen = frame.payload.length;
  if (payloadLen > 255) {
    throw new Error("Payload size exceeds maximum of 255 bytes");
  }

  // Pre-FEC size: SYNC(1) + ORIGEN_LIC(7) + ORIGEN_NODO(2) + DESTINO_LIC(7) + DESTINO_NODO(2) +
  // ARCHIVO_ID(1) + SECUENCIA_ID(2) + TIPO(1) + LONGITUD(1) + PAYLOAD(L) + CRC16(2)
  const preFecSize = 26 + payloadLen;
  const buffer = new Uint8Array(preFecSize);

  let offset = 0;

  // 1. SYNC
  buffer[offset++] = SYNC_BYTE;

  // 2. ORIGEN_LICENCIA (7 bytes)
  buffer.set(padCallsign(frame.origenLicencia), offset);
  offset += 7;

  // 3. ORIGEN_NODO (2 bytes, Big-Endian)
  buffer[offset++] = (frame.origenNodo >> 8) & 0xFF;
  buffer[offset++] = frame.origenNodo & 0xFF;

  // 4. DESTINO_LICENCIA (7 bytes)
  buffer.set(padCallsign(frame.destinoLicencia), offset);
  offset += 7;

  // 5. DESTINO_NODO (2 bytes, Big-Endian)
  buffer[offset++] = (frame.destinoNodo >> 8) & 0xFF;
  buffer[offset++] = frame.destinoNodo & 0xFF;

  // 6. ARCHIVO_ID (1 byte)
  buffer[offset++] = frame.archivoId & 0xFF;

  // 7. SECUENCIA_ID (2 bytes, Big-Endian)
  buffer[offset++] = (frame.secuenciaId >> 8) & 0xFF;
  buffer[offset++] = frame.secuenciaId & 0xFF;

  // 8. TIPO (1 byte)
  buffer[offset++] = frame.tipo & 0xFF;

  // 9. LONGITUD (1 byte)
  buffer[offset++] = payloadLen & 0xFF;

  // 10. PAYLOAD (L bytes)
  buffer.set(frame.payload, offset);
  offset += payloadLen;

  // 11. CRC16 (2 bytes, Big-Endian)
  // Calculated over the buffer up to this point (SYNC to end of PAYLOAD)
  const calculatedCrc = crc16(buffer.slice(0, offset));
  buffer[offset++] = (calculatedCrc >> 8) & 0xFF;
  buffer[offset++] = calculatedCrc & 0xFF;

  // 12. FEC Reed-Solomon (~25% of preFecSize)
  const nsym = getFECSize(preFecSize);
  const encoded = rs_encode(buffer, nsym);

  return encoded;
}

export interface DeserializationResult {
  frame: LU_PAMPA_Frame;
  fecCorrected: boolean;
  errorsCorrected: number;
  crcValid: boolean;
}

/**
 * Deserializes raw binary data into a LU-PAMPA frame.
 * Operates error correction (Reed-Solomon) and validates CRC16.
 */
export function deserializeFrame(raw: Uint8Array): DeserializationResult | null {
  // A minimum valid frame size must have at least the pre-FEC header fields (26 bytes) + FEC parity symbols.
  // The smallest pre-FEC frame is 26 bytes (0 payload).
  // The minimum FEC size for 26 bytes is getFECSize(26) = 6.
  // So the minimum raw packet size is 26 + 6 = 32 bytes.
  if (raw.length < 32) {
    return null;
  }

  // 1. Verify and extract sync byte
  if (raw[0] !== SYNC_BYTE) {
    // If the sync byte is corrupt, Reed-Solomon might still fix it if we assume raw starts at the sync byte.
    // We let Reed-Solomon decode it.
  }

  // To run Reed-Solomon decode, we need to know the length of the codeword (N).
  // In our protocol, the layout depends on LONGITUD (at offset 23).
  // However, if there are errors, how do we know the payload length and therefore the FEC size?
  // We can look at the raw buffer length!
  // The raw buffer length IS the total codeword length (N = preFecSize + nsym).
  // Since nsym = Math.max(6, Math.ceil(preFecSize * 0.25)):
  // We can solve for preFecSize:
  // Let N = raw.length.
  // If preFecSize * 0.25 <= 6, then nsym = 6, and preFecSize = N - 6.
  // Else, nsym = Math.ceil(preFecSize * 0.25) => N = preFecSize + Math.ceil(preFecSize * 0.25).
  // In either case, we can easily find preFecSize and nsym from N:
  let preFecSize = 0;
  let nsym = 0;
  
  for (let testPreFec = 26; testPreFec <= raw.length; testPreFec++) {
    const testNsym = getFECSize(testPreFec);
    if (testPreFec + testNsym === raw.length) {
      preFecSize = testPreFec;
      nsym = testNsym;
      break;
    }
  }

  if (preFecSize === 0 || nsym === 0) {
    // Length mismatch (packet was truncated or padded incorrectly)
    return null;
  }

  // 2. Perform Reed-Solomon Error Correction
  const rsResult = rs_decode(raw, nsym);
  if (!rsResult) {
    // Errors are uncorrectable
    return null;
  }

  const decodedBuffer = rsResult.data; // Size is preFecSize

  // 3. Extract and validate CRC16
  // CRC16 is at the last 2 bytes of the decodedBuffer
  const extractedCrc = (decodedBuffer[preFecSize - 2] << 8) | decodedBuffer[preFecSize - 1];
  
  // Calculate CRC16 over the data before the CRC16 field
  const dataToCrc = decodedBuffer.slice(0, preFecSize - 2);
  const calculatedCrc = crc16(dataToCrc);
  const crcValid = (extractedCrc === calculatedCrc);

  // 4. Parse header fields from decodedBuffer
  let offset = 0;

  const sync = decodedBuffer[offset++];
  if (sync !== SYNC_BYTE) {
    // Sync byte is wrong even after RS. Packet invalid.
    return null;
  }

  const origenLicenciaBytes = decodedBuffer.slice(offset, offset + 7);
  offset += 7;
  const origenLicencia = parseCallsign(origenLicenciaBytes);

  const origenNodo = (decodedBuffer[offset++] << 8) | decodedBuffer[offset++];
  
  const destinoLicenciaBytes = decodedBuffer.slice(offset, offset + 7);
  offset += 7;
  const destinoLicencia = parseCallsign(destinoLicenciaBytes);

  const destinoNodo = (decodedBuffer[offset++] << 8) | decodedBuffer[offset++];

  const archivoId = decodedBuffer[offset++];
  
  const secuenciaId = (decodedBuffer[offset++] << 8) | decodedBuffer[offset++];

  const tipo = decodedBuffer[offset++] as FrameType;

  const payloadLen = decodedBuffer[offset++];
  
  // Check payload length matches the remaining buffer space before CRC16
  if (payloadLen !== (preFecSize - 26)) {
    return null; // Size mismatch
  }

  const payload = decodedBuffer.slice(offset, offset + payloadLen);

  return {
    frame: {
      origenLicencia,
      origenNodo,
      destinoLicencia,
      destinoNodo,
      archivoId,
      secuenciaId,
      tipo,
      payload
    },
    fecCorrected: rsResult.corrected,
    errorsCorrected: rsResult.errors,
    crcValid
  };
}

/**
 * Base85 encoder (compatible with Adobe Ascii85).
 * Encodes 4 bytes into 5 characters.
 */
export function encodeBase85(data: Uint8Array): string {
  let result = "";
  let i = 0;
  while (i < data.length) {
    const len = Math.min(4, data.length - i);
    let val = 0;
    for (let j = 0; j < 4; j++) {
      val = val * 256 + (j < len ? data[i + j] : 0);
    }
    const chars: string[] = [];
    let temp = val;
    for (let j = 0; j < 5; j++) {
      chars.push(String.fromCharCode(33 + (temp % 85)));
      temp = Math.floor(temp / 85);
    }
    chars.reverse();
    result += chars.slice(0, len + 1).join("");
    i += len;
  }
  return result;
}

/**
 * Base85 decoder.
 * Decodes 5 characters back into 4 bytes.
 */
export function decodeBase85(str: string): Uint8Array {
  // Remove all whitespace
  str = str.replace(/\s/g, "");
  const out: number[] = [];
  let i = 0;
  while (i < str.length) {
    const len = Math.min(5, str.length - i);
    let val = 0;
    for (let j = 0; j < 5; j++) {
      const charVal = j < len ? str.charCodeAt(i + j) - 33 : 84; // 84 corresponds to 'u'
      val = val * 85 + charVal;
    }
    const bytes: number[] = [];
    let temp = val;
    for (let j = 0; j < 4; j++) {
      bytes.push(temp & 0xFF);
      temp >>>= 8;
    }
    bytes.reverse();
    const numBytes = len - 1;
    for (let j = 0; j < numBytes; j++) {
      out.push(bytes[j]);
    }
    i += len;
  }
  return new Uint8Array(out);
}
