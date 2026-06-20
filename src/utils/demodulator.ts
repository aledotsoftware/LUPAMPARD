import { deserializeFrame, getFECSize, getFrequencies } from "./protocol";
import type { DeserializationResult } from "./protocol";

export interface DemodulationOptions {
  baudRate: number;   // 1200 or 9600
  sampleRate: number; // e.g. 44100
  useNRZI: boolean;   // Decode using NRZI + unstuffing or Direct FSK
}

export interface DemodulatedPacket {
  result: DeserializationResult | null;
  rawBytes: Uint8Array;
  timestamp: number;
  rsFailed?: boolean;
}

/**
 * Demodulates FSK audio samples into a difference signal (Mark power - Space power).
 * Uses sliding correlation (matched filters) for optimal noise immunity.
 */
export function demodulateFSK(samples: Float32Array, options: DemodulationOptions): Float32Array {
  const sampleRate = options.sampleRate;
  const baudRate = options.baudRate;
  
  const { mark: freqMark, space: freqSpace } = getFrequencies(baudRate);

  const samplesPerBit = Math.round(sampleRate / baudRate);
  const diff = new Float32Array(samples.length);

  // Precompute sine and cosine references for speed
  const markCos = new Float32Array(samplesPerBit);
  const markSin = new Float32Array(samplesPerBit);
  const spaceCos = new Float32Array(samplesPerBit);
  const spaceSin = new Float32Array(samplesPerBit);

  for (let i = 0; i < samplesPerBit; i++) {
    const t = i / sampleRate;
    markCos[i] = Math.cos(2 * Math.PI * freqMark * t);
    markSin[i] = Math.sin(2 * Math.PI * freqMark * t);
    spaceCos[i] = Math.cos(2 * Math.PI * freqSpace * t);
    spaceSin[i] = Math.sin(2 * Math.PI * freqSpace * t);
  }

  // Sliding correlation window
  let markI = 0, markQ = 0;
  let spaceI = 0, spaceQ = 0;

  // Initialize first window
  for (let i = 0; i < samplesPerBit && i < samples.length; i++) {
    const s = samples[i];
    markI += s * markCos[i];
    markQ += s * markSin[i];
    spaceI += s * spaceCos[i];
    spaceQ += s * spaceSin[i];
  }

  diff[samplesPerBit - 1] = (markI * markI + markQ * markQ) - (spaceI * spaceI + spaceQ * spaceQ);

  // Slide window over the rest of samples
  for (let i = samplesPerBit; i < samples.length; i++) {

    // Subtract contribution of leaving sample and add arriving sample
    // Since references repeat every samplesPerBit, we can just multiply directly
    // (Wait, this is true if frequencies are integer multiples of baud rate, but for general frequencies, 
    // we should compute correlation on the sliding history. For speed and accuracy, we do a direct multiply of the window)
    markI = 0; markQ = 0;
    spaceI = 0; spaceQ = 0;
    for (let w = 0; w < samplesPerBit; w++) {
      const s = samples[i - samplesPerBit + 1 + w];
      markI += s * markCos[w];
      markQ += s * markSin[w];
      spaceI += s * spaceCos[w];
      spaceQ += s * spaceSin[w];
    }

    diff[i] = (markI * markI + markQ * markQ) - (spaceI * spaceI + spaceQ * spaceQ);
  }

  return diff;
}

/**
 * Extracts binary packets from the FSK difference signal.
 * Uses a multi-phase clock search to find the optimal symbol-sampling phase,
 * avoiding the fragility of blind PLL transition tracking.
 */
export function extractPackets(
  diff: Float32Array,
  options: DemodulationOptions
): DemodulatedPacket[] {
  const sampleRate = options.sampleRate;
  const baudRate = options.baudRate;
  const samplesPerBit = sampleRate / baudRate;
  
  const packetsMap = new Map<string, DemodulatedPacket>();
  const syncPattern = [0, 1, 1, 1, 1, 1, 1, 0];
  
  // Try 8 different clock phases to cover the entire symbol duration
  const numPhases = 8;
  for (let phaseIdx = 0; phaseIdx < numPhases; phaseIdx++) {
    const phaseOffset = phaseIdx / numPhases;
    
    // Extract bits for this phase
    const bits: number[] = [];
    let clock = samplesPerBit * phaseOffset;
    if (clock < samplesPerBit * 0.1) {
      clock = samplesPerBit * 0.1; // Avoid starting exactly at 0
    }
    
    while (clock < diff.length) {
      const idx = Math.floor(clock);
      const val = diff[idx] || 0;
      bits.push(val > 0 ? 1 : 0);
      clock += samplesPerBit;
    }
    
    // Decode NRZI if specified
    let decodedBits = bits;
    if (options.useNRZI) {
      decodedBits = [];
      let prevBit = 1; // Start state assumption
      for (let i = 0; i < bits.length; i++) {
        const bit = bits[i];
        if (bit === prevBit) {
          decodedBits.push(1); // No change => 1
        } else {
          decodedBits.push(0); // Change => 0
        }
        prevBit = bit;
      }
    }
    
    // Scan bitstream for Sync delimiter (0x7E LSB-first = 0, 1, 1, 1, 1, 1, 1, 0)
    let bitIdx = 0;
    while (bitIdx < decodedBits.length - 30 * 8) { // Minimum frame size is 32 bytes
      let isSync = true;
      for (let p = 0; p < 8; p++) {
        if (decodedBits[bitIdx + p] !== syncPattern[p]) {
          isSync = false;
          break;
        }
      }
      
      if (isSync) {
        // Preamble flag continuation filtering
        let nextByteIsSync = false;
        if (bitIdx + 16 <= decodedBits.length) {
          nextByteIsSync = true;
          for (let p = 0; p < 8; p++) {
            if (decodedBits[bitIdx + 8 + p] !== syncPattern[p]) {
              nextByteIsSync = false;
              break;
            }
          }
        }

        if (nextByteIsSync) {
          // Preamble flag, skip it
          bitIdx += 8;
          continue;
        }

        // Found actual frame start boundary
        const rawPacketBits: number[] = [];
        for (let p = 0; p < 8; p++) {
          rawPacketBits.push(syncPattern[p]);
        }
        
        let dataBitIdx = bitIdx + 8;
        let consecutiveOnes = 0;
        let expectedTotalBytes: number | null = null;
        
        while (dataBitIdx < decodedBits.length) {
          if (options.useNRZI) {
            let matchesSync = true;
            for (let p = 0; p < 8; p++) {
              if (decodedBits[dataBitIdx + p] !== syncPattern[p]) {
                matchesSync = false;
                break;
              }
            }
            if (matchesSync && rawPacketBits.length >= 26 * 8) {
              break; // Found postamble/next frame sync
            }
          }

          const bit = decodedBits[dataBitIdx++];
          if (options.useNRZI) {
            if (bit === 1) {
              consecutiveOnes++;
              rawPacketBits.push(bit);
              if (consecutiveOnes === 6) {
                break;
              }
            } else {
              if (consecutiveOnes === 5) {
                consecutiveOnes = 0;
                continue; // Skip stuffed bit
              }
              consecutiveOnes = 0;
              rawPacketBits.push(bit);
            }
          } else {
            rawPacketBits.push(bit);
            
            const parsedBytes = Math.floor(rawPacketBits.length / 8);
            // Once we have read the full 24-byte header (indices 0 to 23),
            // we can parse the LONGITUD byte (which is at index 23)
            if (expectedTotalBytes === null && parsedBytes >= 24) {
              let lenByte = 0;
              const startBit = 23 * 8; // LONGITUD byte is at index 23
              for (let b = 0; b < 8; b++) {
                lenByte |= (rawPacketBits[startBit + b] << b);
              }
              expectedTotalBytes = 26 + lenByte + getFECSize(26 + lenByte);
            }
            if (expectedTotalBytes !== null && rawPacketBits.length >= expectedTotalBytes * 8) {
              while (rawPacketBits.length > expectedTotalBytes * 8) {
                rawPacketBits.pop();
              }
              break;
            }
          }
        }

        // Convert the collected bits to bytes
        const numBytes = Math.floor(rawPacketBits.length / 8);
        if (numBytes >= 32) {
          const rawBytes = new Uint8Array(numBytes);
          for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
            let byteVal = 0;
            for (let b = 0; b < 8; b++) {
              byteVal |= (rawPacketBits[byteIdx * 8 + b] << b);
            }
            rawBytes[byteIdx] = byteVal;
          }
          
          // Attempt to deserialize (performs Reed-Solomon decoding and CRC16 verification)
          const deserialized = deserializeFrame(rawBytes);
          if (deserialized) {
            // Deduplicate by licensing callsign + archivoId + secuenciaId
            const key = `${deserialized.frame.origenLicencia}_${deserialized.frame.archivoId}_${deserialized.frame.secuenciaId}`;
            if (!packetsMap.has(key)) {
              packetsMap.set(key, {
                result: deserialized,
                rawBytes,
                timestamp: Date.now()
              });
            }
            // Skip past the decoded packet bits in our bit scan
            bitIdx += dataBitIdx - bitIdx - 8;
          } else {
            // RS decoding failed, but Sync was valid. Return it as a corrupted raw packet.
            const key = `corrupt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            packetsMap.set(key, {
              result: null,
              rawBytes,
              timestamp: Date.now(),
              rsFailed: true
            });
            // Skip past the packet bits in our bit scan
            bitIdx += dataBitIdx - bitIdx - 8;
          }
        }
      }
      bitIdx++;
    }
  }
  
  return Array.from(packetsMap.values());
}
