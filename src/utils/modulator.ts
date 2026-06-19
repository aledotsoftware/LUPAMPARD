// LU-PAMPA V8 AFSK Modulator
import { SYNC_BYTE } from "./protocol";
// @ts-expect-error - lamejs has no official typings
import lamejs from "./lame.min.js";

interface LameJS {
  Mp3Encoder: new (channels: number, samplerate: number, kbps: number) => {
    encodeBuffer: (buffer: Int16Array) => Int8Array;
    flush: () => Int8Array;
  };
}


export interface ModulationOptions {
  baudRate: number;       // 1200 or 9600
  sampleRate: number;     // e.g. 44100
  preambleBytes: number;  // number of SYNC bytes (0x7E) before data
  postambleBytes: number; // number of SYNC bytes (0x7E) after data
  useNRZI: boolean;       // Use NRZI + Bit stuffing (AX.25 style) or Direct Binary FSK
}

/**
 * Converts a byte array into a bit stream based on the modulation options.
 */
export function bytesToBits(bytes: Uint8Array, options: ModulationOptions): number[] {
  const bits: number[] = [];

  if (options.useNRZI) {
    // Standard AX.25 style:
    // Preamble/postamble are NOT bit-stuffed.
    // The data bytes (from byte 1 to N-1) are bit-stuffed.
    // Bit stuffing: insert a '0' after five consecutive '1's.
    
    // We'll write the bits for preamble
    for (let i = 0; i < options.preambleBytes; i++) {
      appendByteBits(SYNC_BYTE, bits);
    }

    // Data bits with stuffing
    let oneCount = 0;
    const dataBytes = bytes.slice(1); // Exclude the first SYNC byte because we write preambles
    for (let i = 0; i < dataBytes.length; i++) {
      const byte = dataBytes[i];
      for (let b = 0; b < 8; b++) {
        const bit = (byte >> b) & 1; // LSB first
        bits.push(bit);
        if (bit === 1) {
          oneCount++;
          if (oneCount === 5) {
            bits.push(0); // Insert stuffed bit
            oneCount = 0;
          }
        } else {
          oneCount = 0;
        }
      }
    }

    // Postamble
    for (let i = 0; i < options.postambleBytes; i++) {
      appendByteBits(SYNC_BYTE, bits);
    }

    // Convert bits to NRZI: a '0' causes transition, '1' causes no transition
    let currentTone = 1; // 1 = Mark, 0 = Space
    const nrziBits: number[] = [];
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] === 0) {
        currentTone = 1 - currentTone; // Toggle
      }
      nrziBits.push(currentTone);
    }
    return nrziBits;

  } else {
    // Direct Binary FSK (highly robust for acoustic channels, no frame slips):
    // Preamble + Data + Postamble all sent directly.
    // We send options.preambleBytes of SYNC_BYTE
    for (let i = 0; i < options.preambleBytes; i++) {
      appendByteBits(SYNC_BYTE, bits);
    }

    // Data
    const dataBytes = bytes.slice(1); // Exclude first SYNC
    for (let i = 0; i < dataBytes.length; i++) {
      appendByteBits(dataBytes[i], bits);
    }

    // Postamble
    for (let i = 0; i < options.postambleBytes; i++) {
      appendByteBits(SYNC_BYTE, bits);
    }

    return bits;
  }
}

function appendByteBits(byte: number, bits: number[]) {
  for (let b = 0; b < 8; b++) {
    bits.push((byte >> b) & 1); // LSB first
  }
}

/**
 * Modulates a bit stream into Float32Array audio samples using Continuous Phase FSK (CPFSK).
 */
export function modulateBits(bits: number[], options: ModulationOptions): Float32Array {
  const sampleRate = options.sampleRate;
  const baudRate = options.baudRate;
  
  // Set frequencies based on baud rate
  let freqMark = 1200; // Tone for bit 1
  let freqSpace = 2200; // Tone for bit 0
  
  if (baudRate === 9600) {
    freqMark = 4800;
    freqSpace = 9600;
  }

  const samplesPerBit = sampleRate / baudRate;
  const totalSamples = Math.ceil(bits.length * samplesPerBit);
  const samples = new Float32Array(totalSamples);

  let phase = 0;
  
  for (let i = 0; i < bits.length; i++) {
    const bit = bits[i];
    const freq = (bit === 1) ? freqMark : freqSpace;
    const omega = 2 * Math.PI * freq / sampleRate;

    // Start index and end index of this bit in the samples array
    const startIdx = Math.floor(i * samplesPerBit);
    const endIdx = Math.floor((i + 1) * samplesPerBit);

    for (let s = startIdx; s < endIdx && s < totalSamples; s++) {
      samples[s] = Math.sin(phase);
      phase += omega;
      if (phase > 2 * Math.PI) {
        phase -= 2 * Math.PI;
      }
    }
  }

  // Apply a smooth fade-in and fade-out (5ms) to prevent audio clicks
  const fadeLength = Math.min(samples.length / 2, Math.floor(sampleRate * 0.005));
  for (let i = 0; i < fadeLength; i++) {
    const volume = i / fadeLength;
    samples[i] *= volume;
    samples[samples.length - 1 - i] *= volume;
  }

  return samples;
}

/**
 * Packs Float32Array samples into a 16-bit PCM WAV file blob.
 */
export function createWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* file length */
  view.setUint32(4, 36 + samples.length * 2, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk identifier */
  writeString(view, 12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw PCM) */
  view.setUint16(20, 1, true);
  /* channel count (mono) */
  view.setUint16(22, 1, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * 2, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, 2, true);
  /* bits per sample */
  view.setUint16(34, 16, true);
  /* data chunk identifier */
  writeString(view, 36, 'data');
  /* data chunk length */
  view.setUint32(40, samples.length * 2, true);

  // Write PCM audio samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    // Clamp to [-1, 1]
    const s = Math.max(-1, Math.min(1, samples[i]));
    // Scale to 16-bit signed integer
    const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(offset, val, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Packs Float32Array samples into an MP3 file blob using the internal lamejs encoder.
 */
export function createMp3Blob(samples: Float32Array, sampleRate: number): Blob {
  // Convert Float32Array to 16-bit PCM Int16Array
  const samples16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    samples16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  // Create MP3 encoder: 1 channel (mono), sample rate, 128 kbps
  const mp3encoder = new (lamejs as unknown as LameJS).Mp3Encoder(1, sampleRate, 128);
  const mp3Data: Int8Array[] = [];

  // Encode buffer
  const mp3Tmp = mp3encoder.encodeBuffer(samples16);
  if (mp3Tmp.length > 0) {
    mp3Data.push(mp3Tmp);
  }

  // Flush buffer
  const mp3Flush = mp3encoder.flush();
  if (mp3Flush.length > 0) {
    mp3Data.push(mp3Flush);
  }

  return new Blob(mp3Data as unknown as BlobPart[], { type: 'audio/mp3' });
}

