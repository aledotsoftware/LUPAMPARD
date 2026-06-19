import React, { useState, useEffect, useRef } from "react";
import {
  Activity,
  Download,
  Radio,
  FileText,
  Trash2,
  Volume2,
  AlertTriangle,
  CheckCircle,
  FileCode,
  ArrowRight,
  ShieldCheck,
  RefreshCw,
  FolderOpen,
  Mic,
  MicOff,
  Sliders,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Folder
} from "lucide-react";
import {
  FrameType,
  encodeBase85,
  decodeBase85,
  serializeFrame
} from "./utils/protocol";
import type { LU_PAMPA_Frame } from "./utils/protocol";
import { modulateBits, bytesToBits, createWavBlob, createMp3Blob } from "./utils/modulator";
import type { ModulationOptions } from "./utils/modulator";

import { demodulateFSK, extractPackets } from "./utils/demodulator";
import type { DemodulatedPacket } from "./utils/demodulator";

interface FileChunk {
  secuenciaId: number;
  payloadText: string;
  payloadBytes: Uint8Array;
}

interface ChunkState {
  secuenciaId: number;
  size: number;
  received: boolean;
  fecCorrected?: boolean;
  errorsCorrected?: number;
}

interface ReassembledFile {
  archivoId: number;
  filename: string;
  totalSize: number;
  totalChunks: number;
  receivedChunks: Map<number, Uint8Array>;
  completed: boolean;
  origenLicencia: string;
  chunkStates: Map<number, ChunkState>;
}


export default function App() {
  // --- STATE VARIABLES ---
  
  // Theme state
  const [isDarkMode, setIsDarkMode] = useState<boolean>(true);

  // Callsign & Node Config
  const [origenLicencia, setOrigenLicencia] = useState<string>("LU1AAA");
  const [origenNodo, setOrigenNodo] = useState<number>(1);
  const [destinoLicencia, setDestinoLicencia] = useState<string>("LU2BBB");
  const [destinoNodo, setDestinoNodo] = useState<number>(1);
  const [archivoId, setArchivoId] = useState<number>(0);
  const [secuenciaId, setSecuenciaId] = useState<number>(0);
  
  // Frame payload type & data
  const [frameType, setFrameType] = useState<FrameType>(FrameType.TEXTO);
  const [textPayload, setTextPayload] = useState<string>("Hola Mundo!!");
  const [tokenPayload, setTokenPayload] = useState<number>(1234);
  const [telemetryPayload, setTelemetryPayload] = useState<string>("TEMP:24.5C,BATT:12.8V,RSSI:88");
  
  // File Transfer State (Transmitter)
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileChunks, setFileChunks] = useState<FileChunk[]>([]);
  const [isTransmittingFile, setIsTransmittingFile] = useState<boolean>(false);
  const [transmissionProgress, setTransmissionProgress] = useState<number>(0);
  const [burstDelay, setBurstDelay] = useState<number>(600); // ms between packets
  const [transmissionRedundancy, setTransmissionRedundancy] = useState<number>(1); // 1 = x1, 2 = x2, 3 = x3
  const isTransmittingRef = useRef<boolean>(false);

  // Physical layer options

  const [baudRate, setBaudRate] = useState<number>(1200);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const toggleFileExpansion = (key: string) => {
    setExpandedFiles(prev => ({
      ...prev,
      [key]: prev[key] === undefined ? false : !prev[key]
    }));
  };
  const [useNRZI, setUseNRZI] = useState<boolean>(false);
  const [preambleBytes, setPreambleBytes] = useState<number>(24);
  const [postambleBytes] = useState<number>(4);
  const [volume, setVolume] = useState<number>(0.8);

  // Receiver State
  const [isListeningMic, setIsListeningMic] = useState<boolean>(false);
  const [receivedPackets, setReceivedPackets] = useState<DemodulatedPacket[]>([]);
  const [reassembledFiles, setReassembledFiles] = useState<Map<string, ReassembledFile>>(new Map());
  const [squelch, setSquelch] = useState<number>(0.02); // Minimum signal amplitude
  const [micStatusText, setMicStatusText] = useState<string>("Micrófono inactivo");

  // Audio elements
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [generatedWavUrl, setGeneratedWavUrl] = useState<string | null>(null);
  const [generatedMp3Url, setGeneratedMp3Url] = useState<string | null>(null);
  const [generatedSamples, setGeneratedSamples] = useState<Float32Array | null>(null);
  const [generatedFileWavUrl, setGeneratedFileWavUrl] = useState<string | null>(null);
  const [generatedFileMp3Url, setGeneratedFileMp3Url] = useState<string | null>(null);
  const [isGeneratingFileAudio, setIsGeneratingFileAudio] = useState<boolean>(false);



  // Statistics
  const [stats, setStats] = useState({
    sent: 0,
    received: 0,
    fecCorrected: 0,
    crcFailed: 0
  });

  // --- REFS ---
  const txCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waterfallCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const playSourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const requestRef = useRef<number | null>(null);

  // --- THEME CONTROL ---
  useEffect(() => {
    const root = window.document.documentElement;
    if (isDarkMode) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [isDarkMode]);

  // --- FILE CHUNKING EFFECT ---
  useEffect(() => {
    if (generatedFileWavUrl) {
      URL.revokeObjectURL(generatedFileWavUrl);
      setGeneratedFileWavUrl(null);
    }
    if (generatedFileMp3Url) {
      URL.revokeObjectURL(generatedFileMp3Url);
      setGeneratedFileMp3Url(null);
    }

    if (!selectedFile) {
      setFileChunks([]);
      return;
    }

    const chunkSize = 48; // 48 bytes of raw file data encodes to 60 characters of Base85
    const reader = new FileReader();
    reader.onload = (e) => {
      if (!e.target || !e.target.result) return;
      const arrayBuffer = e.target.result as ArrayBuffer;
      const fileData = new Uint8Array(arrayBuffer);
      const totalBytes = fileData.length;
      
      const chunks: FileChunk[] = [];
      const totalChunks = Math.ceil(totalBytes / chunkSize);
      
      // Fragment 0: YMODEM-like metadata packet
      // METADATA:filename,sizeInBytes,totalChunks
      const metaText = `META:${selectedFile.name},${totalBytes},${totalChunks}`;
      const metaBytes = new TextEncoder().encode(metaText);
      chunks.push({
        secuenciaId: 0,
        payloadText: metaText,
        payloadBytes: metaBytes
      });

      // Subsequent fragments: actual Base85 file data
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, totalBytes);
        const fileSlice = fileData.slice(start, end) as any;
        const b85Text = encodeBase85(fileSlice);
        const payloadBytes = new TextEncoder().encode(b85Text);

        chunks.push({
          secuenciaId: i + 1,
          payloadText: b85Text,
          payloadBytes
        });
      }
      
      setFileChunks(chunks);
    };
    reader.readAsArrayBuffer(selectedFile);
  }, [selectedFile]);

  // --- DRAW WAVEFORM (TRANSMITTER) ---
  const drawTxWaveform = () => {
    const canvas = txCanvasRef.current;
    if (!canvas || !generatedSamples) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = isDarkMode ? "oklch(0.922 0 0)" : "oklch(0.205 0 0)"; // Primary
    ctx.beginPath();

    let x = 0;

    // We downsample for rendering if there are too many samples
    const step = Math.max(1, Math.floor(generatedSamples.length / 800));

    for (let i = 0; i < generatedSamples.length; i += step) {
      const v = generatedSamples[i];
      const y = (v * canvas.height * 0.4) + canvas.height / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x = (i / generatedSamples.length) * canvas.width;
    }

    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  };

  useEffect(() => {
    drawTxWaveform();
  }, [generatedSamples, isDarkMode]);

  // --- ACTIONS ---

  // Build a single frame object
  const buildFrame = (customSeqId?: number, customPayload?: Uint8Array): LU_PAMPA_Frame => {
    let payload: any = new Uint8Array();
    if (customPayload) {
      payload = customPayload;
    } else {
      switch (frameType) {
        case FrameType.TEXTO:
          payload = new TextEncoder().encode(textPayload);
          break;
        case FrameType.TOKEN:
          payload = new Uint8Array([
            (tokenPayload >> 8) & 0xFF,
            tokenPayload & 0xFF
          ]);
          break;
        case FrameType.ACK:
          payload = new Uint8Array([0x06]); // ACK byte
          break;
        case FrameType.BALIZA:
          payload = new TextEncoder().encode(telemetryPayload);
          break;
      }
    }

    return {
      origenLicencia,
      origenNodo,
      destinoLicencia,
      destinoNodo,
      archivoId,
      secuenciaId: customSeqId !== undefined ? customSeqId : secuenciaId,
      tipo: customPayload ? FrameType.FRAGMENTO : frameType,
      payload
    };
  };

  // Generate Audio for current parameters
  const handleGenerateAudio = (silent = false) => {
    try {
      const frame = buildFrame();
      const rawFrame = serializeFrame(frame);
      
      const options: ModulationOptions = {
        baudRate,
        sampleRate: 44100,
        preambleBytes,
        postambleBytes,
        useNRZI
      };

      const bits = bytesToBits(rawFrame, options);
      const samples = modulateBits(bits, options);

      setGeneratedSamples(samples);

      const blob = createWavBlob(samples as any, 44100);
      if (generatedWavUrl) {
        URL.revokeObjectURL(generatedWavUrl);
      }
      const url = URL.createObjectURL(blob);
      setGeneratedWavUrl(url);

      const mp3Blob = createMp3Blob(samples as any, 44100);
      if (generatedMp3Url) {
        URL.revokeObjectURL(generatedMp3Url);
      }
      const mp3Url = URL.createObjectURL(mp3Blob);
      setGeneratedMp3Url(mp3Url);


      if (!silent) {
        // Log to console
        console.log("Audio generado. Tamaño de trama:", rawFrame.length, "bytes. Bits modulated:", bits.length);
      }
      return samples;
    } catch (err: any) {
      alert("Error al generar audio: " + err.message);
      return null;
    }
  };

  // Generate continuous audio for the entire file transmission (all chunks + gaps)
  const handleGenerateEntireFileAudio = () => {
    if (fileChunks.length === 0) return;
    setIsGeneratingFileAudio(true);

    try {
      const options: ModulationOptions = {
        baudRate,
        sampleRate: 44100,
        preambleBytes,
        postambleBytes,
        useNRZI
      };

      // 1. Build the exact same frame queue as handleTransmitFile
      const queue: LU_PAMPA_Frame[] = [];
      const metaChunk = fileChunks.find(c => c.secuenciaId === 0);
      const dataChunks = fileChunks.filter(c => c.secuenciaId > 0);

      // Metadata chunk at the beginning
      if (metaChunk) {
        queue.push(buildFrame(metaChunk.secuenciaId, metaChunk.payloadBytes));
      }

      // Data chunks, repeating according to redundancy setting
      for (let r = 0; r < transmissionRedundancy; r++) {
        for (const chunk of dataChunks) {
          queue.push(buildFrame(chunk.secuenciaId, chunk.payloadBytes));
        }
      }

      // Metadata chunk again at the very end
      if (metaChunk) {
        queue.push(buildFrame(metaChunk.secuenciaId, metaChunk.payloadBytes));
      }

      // 2. Modulate each frame and compile into one master sample array
      const silenceLength = Math.floor((burstDelay / 1000) * 44100);
      const allFrameSamples: Float32Array[] = [];
      let totalSamplesCount = 0;

      for (let i = 0; i < queue.length; i++) {
        const frame = queue[i];
        const rawFrame = serializeFrame(frame);
        const bits = bytesToBits(rawFrame, options);
        const samples = modulateBits(bits, options);

        allFrameSamples.push(samples);
        totalSamplesCount += samples.length;

        // Add silence gap between packets
        if (i < queue.length - 1) {
          totalSamplesCount += silenceLength;
        }
      }

      // 3. Populate combined array
      const combinedSamples = new Float32Array(totalSamplesCount);
      let offset = 0;
      for (let i = 0; i < allFrameSamples.length; i++) {
        combinedSamples.set(allFrameSamples[i], offset);
        offset += allFrameSamples[i].length;

        if (i < allFrameSamples.length - 1) {
          // Leave zeros (silence)
          offset += silenceLength;
        }
      }

      // 4. Create URLs for download
      const wavBlob = createWavBlob(combinedSamples, 44100);
      if (generatedFileWavUrl) {
        URL.revokeObjectURL(generatedFileWavUrl);
      }
      const wavUrl = URL.createObjectURL(wavBlob);
      setGeneratedFileWavUrl(wavUrl);

      const mp3Blob = createMp3Blob(combinedSamples, 44100);
      if (generatedFileMp3Url) {
        URL.revokeObjectURL(generatedFileMp3Url);
      }
      const mp3Url = URL.createObjectURL(mp3Blob);
      setGeneratedFileMp3Url(mp3Url);

      console.log("Ráfaga de audio generada. Total muestras:", combinedSamples.length);
    } catch (err: any) {
      alert("Error al generar audio de la ráfaga: " + err.message);
    } finally {
      setIsGeneratingFileAudio(false);
    }
  };

  // Generate and download MP3 audio for a specific received frame
  const handleDownloadPacketMp3 = (pkt: DemodulatedPacket) => {
    try {
      const { frame } = pkt.result;
      const options: ModulationOptions = {
        baudRate, // uses current baudRate
        sampleRate: 44100,
        preambleBytes,
        postambleBytes,
        useNRZI
      };

      const rawFrame = serializeFrame(frame);
      const bits = bytesToBits(rawFrame, options);
      const samples = modulateBits(bits, options);

      const mp3Blob = createMp3Blob(samples, 44100);
      const mp3Url = URL.createObjectURL(mp3Blob);

      const a = document.createElement("a");
      a.href = mp3Url;
      a.download = `pampa_v8_rx_${frame.origenLicencia}_sec${frame.secuenciaId}.mp3`;
      a.click();
      
      // Clean up the URL in a bit
      setTimeout(() => URL.revokeObjectURL(mp3Url), 10000);
    } catch (err: any) {
      alert("Error al descargar MP3 de la trama: " + err.message);
    }
  };


  // Play generated audio
  const handlePlayAudio = (samplesToPlay?: Float32Array) => {
    const samples = samplesToPlay || generatedSamples || handleGenerateAudio(true);
    if (!samples) return;

    if (isPlaying) {
      handleStopAudio();
    }

    // Initialize AudioContext
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }

    const context = audioContextRef.current;
    if (context.state === "suspended") {
      context.resume();
    }

    const buffer = context.createBuffer(1, samples.length, 44100);
    buffer.copyToChannel(samples as any, 0);

    const source = context.createBufferSource();
    source.buffer = buffer;

    // Connect to volume control
    const gainNode = context.createGain();
    gainNode.gain.setValueAtTime(volume, context.currentTime);
    
    // Connect to visual analyzer if playing back
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    
    source.connect(gainNode);
    gainNode.connect(analyser);
    gainNode.connect(context.destination);

    playSourceNodeRef.current = source;
    setIsPlaying(true);

    source.onended = () => {
      setIsPlaying(false);
    };

    source.start(0);

    // Render TX live oscillator if active
    let drawVisual: number;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const canvas = txCanvasRef.current;
    const canvasCtx = canvas?.getContext("2d");

    const drawLive = () => {
      if (!canvas || !canvasCtx) return;
      drawVisual = requestAnimationFrame(drawLive);
      analyser.getByteTimeDomainData(dataArray);

      canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
      canvasCtx.lineWidth = 3;
      canvasCtx.strokeStyle = "oklch(0.708 0 0)"; // Ring color for accent
      canvasCtx.beginPath();

      const sliceWidth = canvas.width / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * canvas.height / 2;

        if (i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }
        x += sliceWidth;
      }

      canvasCtx.lineTo(canvas.width, canvas.height / 2);
      canvasCtx.stroke();
    };

    drawLive();

    // Store reference to cancel animation
    source.addEventListener("ended", () => {
      cancelAnimationFrame(drawVisual);
      drawTxWaveform(); // redraw static waveform
    });
  };

  const handleStopAudio = () => {
    if (playSourceNodeRef.current) {
      try {
        playSourceNodeRef.current.stop();
      } catch (e) {}
      playSourceNodeRef.current = null;
    }
    setIsPlaying(false);
  };

  // Broadcast entire file fragment queue
  const handleTransmitFile = async () => {
    if (fileChunks.length === 0) return;
    setIsTransmittingFile(true);
    isTransmittingRef.current = true;

    const options: ModulationOptions = {
      baudRate,
      sampleRate: 44100,
      preambleBytes,
      postambleBytes,
      useNRZI
    };

    // 1. Build a queue of all frames to transmit (including metadata redundancy)
    const queue: LU_PAMPA_Frame[] = [];
    const metaChunk = fileChunks.find(c => c.secuenciaId === 0);
    const dataChunks = fileChunks.filter(c => c.secuenciaId > 0);

    // Add metadata chunk at the very beginning
    if (metaChunk) {
      queue.push({
        origenLicencia,
        origenNodo,
        destinoLicencia,
        destinoNodo,
        archivoId,
        secuenciaId: metaChunk.secuenciaId,
        tipo: FrameType.FRAGMENTO,
        payload: metaChunk.payloadBytes
      });
    }

    // Add data chunks, repeating according to redundancy setting
    for (let r = 0; r < transmissionRedundancy; r++) {
      for (const chunk of dataChunks) {
        queue.push({
          origenLicencia,
          origenNodo,
          destinoLicencia,
          destinoNodo,
          archivoId,
          secuenciaId: chunk.secuenciaId,
          tipo: FrameType.FRAGMENTO,
          payload: chunk.payloadBytes
        });
      }
    }

    // Add metadata chunk again at the very end for extra safety
    if (metaChunk) {
      queue.push({
        origenLicencia,
        origenNodo,
        destinoLicencia,
        destinoNodo,
        archivoId,
        secuenciaId: metaChunk.secuenciaId,
        tipo: FrameType.FRAGMENTO,
        payload: metaChunk.payloadBytes
      });
    }

    // 2. Transmit the queue
    for (let i = 0; i < queue.length; i++) {
      setTransmissionProgress(Math.round(((i + 1) / queue.length) * 100));

      const frame = queue[i];
      const rawFrame = serializeFrame(frame);
      const bits = bytesToBits(rawFrame, options);
      const samples = modulateBits(bits, options);

      // Play the audio for this fragment
      handlePlayAudio(samples);
      setStats((s) => ({ ...s, sent: s.sent + 1 }));

      // Wait until chunk finishes playing + burst delay
      const playDurationMs = (samples.length / 44100) * 1000;
      await new Promise((resolve) => setTimeout(resolve, playDurationMs + burstDelay));
      
      // Stop checking if user cancelled (via ref)
      if (!isTransmittingRef.current) break;
    }

    setIsTransmittingFile(false);
    isTransmittingRef.current = false;
    setSelectedFile(null);
    setFileChunks([]);
  };

  const handleCancelTransmission = () => {
    setIsTransmittingFile(false);
    isTransmittingRef.current = false;
    handleStopAudio();
  };


  // --- RECEIVER PROCESSOR ---

  const handleToggleMic = async () => {
    if (isListeningMic) {
      handleStopListening();
      return;
    }

    try {
      setMicStatusText("Iniciando micrófono...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStreamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioCtx();
      const context = audioContextRef.current;

      const source = context.createMediaStreamSource(stream);
      
      // Analyser node for Spectrogram
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyzerRef.current = analyser;
      source.connect(analyser);

      // Process audio samples
      // 4096 buffer size, 1 input channel, 1 output channel
      const processor = context.createScriptProcessor(4096, 1, 1);
      scriptProcessorRef.current = processor;
      source.connect(processor);
      processor.connect(context.destination);

      let bufferPool = new Float32Array(0);

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Calculate RMS amplitude to check against Squelch
        let sumSquare = 0;
        for (let i = 0; i < inputData.length; i++) {
          sumSquare += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sumSquare / inputData.length);

        if (rms < squelch) {
          // Input is silent noise, flush buffer and skip processing
          bufferPool = new Float32Array(0);
          return;
        }

        // Append new samples to our processing pool
        const newPool = new Float32Array(bufferPool.length + inputData.length);
        newPool.set(bufferPool);
        newPool.set(inputData, bufferPool.length);
        bufferPool = newPool;

        // Keep buffer pool to max 2 seconds to prevent memory overflow
        const maxBufferLength = 44100 * 2;
        if (bufferPool.length > maxBufferLength) {
          bufferPool = bufferPool.slice(bufferPool.length - maxBufferLength);
        }

        // Run AFSK Demodulator on buffer pool
        const demodOptions = {
          baudRate,
          sampleRate: context.sampleRate,
          useNRZI
        };

        const diff = demodulateFSK(bufferPool, demodOptions);
        const packets = extractPackets(diff, demodOptions);

        if (packets.length > 0) {
          // Process newly found packets
          packets.forEach((packet) => {
            // Avoid duplicates (if packet CRC is correct and timestamp is close)
            setReceivedPackets((prev) => {
              const duplicate = prev.some(
                (p) =>
                  p.result.frame.origenLicencia === packet.result.frame.origenLicencia &&
                  p.result.frame.secuenciaId === packet.result.frame.secuenciaId &&
                  p.result.frame.archivoId === packet.result.frame.archivoId &&
                  Math.abs(p.timestamp - packet.timestamp) < 2000
              );
              if (duplicate) return prev;
              
              // Increment statistics
              setStats((s) => ({
                ...s,
                received: s.received + 1,
                fecCorrected: s.fecCorrected + (packet.result.fecCorrected ? 1 : 0),
                crcFailed: s.crcFailed + (packet.result.crcValid ? 0 : 1)
              }));

              // Handle File Chunk assembly
              if (packet.result.frame.tipo === FrameType.FRAGMENTO) {
                handleIncomingFileChunk(
                  packet.result.frame,
                  packet.result.fecCorrected,
                  packet.result.errorsCorrected
                );
              }

              // Handle ACK / NACK feedback
              if (packet.result.frame.tipo === FrameType.ACK) {
                handleIncomingAck(packet.result.frame);
              }


              return [packet, ...prev].slice(0, 100); // Keep last 100 packets
            });
          });

          // Clear buffer pool after successful reads to prevent duplicate scans
          bufferPool = new Float32Array(0);
        }
      };

      setIsListeningMic(true);
      setMicStatusText("Escuchando...");
      drawSpectrogram();

    } catch (err: any) {
      alert("Error al iniciar micrófono: " + err.message);
      setMicStatusText("Error en micrófono");
    }
  };

  const handleStopListening = () => {
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }
    if (requestRef.current) {
      cancelAnimationFrame(requestRef.current);
    }
    setIsListeningMic(false);
    setMicStatusText("Micrófono inactivo");
  };

  // Carga un archivo de audio WAV y lo procesa directamente por software
  const handleAudioFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        if (!event.target?.result) return;
        const arrayBuffer = event.target.result as ArrayBuffer;
        
        // Use OfflineAudioContext to decode reliably on all platforms
        const OfflineAudioCtx = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
        const tempCtx = new OfflineAudioCtx(1, 44100, 44100);
        const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
        const channelData = audioBuffer.getChannelData(0);

        setMicStatusText("Procesando archivo de audio...");

        const demodOptions = {
          baudRate,
          sampleRate: audioBuffer.sampleRate,
          useNRZI
        };

        const diff = demodulateFSK(channelData, demodOptions);
        const packets = extractPackets(diff, demodOptions);

        if (packets.length === 0) {
          alert("No se encontraron tramas LU-PAMPA V8 en el archivo de audio.");
          setMicStatusText("Procesamiento terminado (0 tramas)");
        } else {
          packets.forEach((packet) => {
            setReceivedPackets((prev) => {
              // Check duplicate
              const duplicate = prev.some(
                (p) =>
                  p.result.frame.origenLicencia === packet.result.frame.origenLicencia &&
                  p.result.frame.secuenciaId === packet.result.frame.secuenciaId &&
                  p.result.frame.archivoId === packet.result.frame.archivoId
              );
              if (duplicate) return prev;

              setStats((s) => ({
                ...s,
                received: s.received + 1,
                fecCorrected: s.fecCorrected + (packet.result.fecCorrected ? 1 : 0),
                crcFailed: s.crcFailed + (packet.result.crcValid ? 0 : 1)
              }));

              if (packet.result.frame.tipo === FrameType.FRAGMENTO) {
                handleIncomingFileChunk(
                  packet.result.frame,
                  packet.result.fecCorrected,
                  packet.result.errorsCorrected
                );
              }

              if (packet.result.frame.tipo === FrameType.ACK) {
                handleIncomingAck(packet.result.frame);
              }


              return [packet, ...prev];
            });
          });
          alert(`Decodificación exitosa: se encontraron ${packets.length} tramas.`);
          setMicStatusText(`Decodificadas ${packets.length} tramas.`);
        }
      } catch (err: any) {
        alert("Error al decodificar archivo de audio: " + err.message);
        setMicStatusText("Error de decodificación");
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // --- REASSEMBLER LOGIC ---

  const handleIncomingFileChunk = (frame: LU_PAMPA_Frame, fecCorrected?: boolean, errorsCorrected?: number) => {
    const payloadText = new TextDecoder().decode(frame.payload);
    const sessionKey = `${frame.origenLicencia}_${frame.archivoId}`;

    setReassembledFiles((prev) => {
      const nextMap = new Map(prev);
      let fileObj = nextMap.get(sessionKey);

      if (!fileObj) {
        fileObj = {
          archivoId: frame.archivoId,
          filename: `Archivo_${frame.archivoId}.bin`,
          totalSize: 0,
          totalChunks: 0,
          receivedChunks: new Map(),
          completed: false,
          origenLicencia: frame.origenLicencia,
          chunkStates: new Map()
        };
      }

      if (!fileObj.chunkStates) {
        fileObj.chunkStates = new Map();
      }

      // If this is the metadata chunk (secuenciaId = 0)
      if (frame.secuenciaId === 0 && payloadText.startsWith("META:")) {
        fileObj.receivedChunks.set(0, frame.payload); // Store metadata chunk index 0
        try {
          const metaStr = payloadText.slice(5); // strip "META:"
          const [filename, sizeStr, chunksStr] = metaStr.split(",");
          fileObj.filename = filename;
          fileObj.totalSize = parseInt(sizeStr, 10);
          fileObj.totalChunks = parseInt(chunksStr, 10);
        } catch (e) {
          console.error("Error parsing fragment metadata", e);
        }
      } else {
        // Regular data chunk
        // Store the Base85 raw string bytes (frame.payload contains the Base85 string)
        fileObj.receivedChunks.set(frame.secuenciaId, frame.payload);
      }

      // Record chunk state details
      fileObj.chunkStates.set(frame.secuenciaId, {
        secuenciaId: frame.secuenciaId,
        size: frame.payload.length,
        received: true,
        fecCorrected,
        errorsCorrected
      });

      // Check if all chunks from 1 to totalChunks are received
      if (fileObj.totalChunks > 0) {
        let allDone = true;
        for (let i = 1; i <= fileObj.totalChunks; i++) {
          if (!fileObj.receivedChunks.has(i)) {
            allDone = false;
            break;
          }
        }
        if (allDone) {
          fileObj.completed = true;
        }
      }

      nextMap.set(sessionKey, { ...fileObj });
      return nextMap;
    });
  };

  const handleIncomingAck = (frame: LU_PAMPA_Frame) => {
    const payloadText = new TextDecoder().decode(frame.payload);
    if (payloadText.startsWith("NACK:")) {
      try {
        const parts = payloadText.slice(5).split(",");
        const reqArchivoId = parseInt(parts[0], 10);
        const missingSeqs = parts.slice(1).map(s => parseInt(s, 10));

        const msg = `[NACK] Recibida solicitud de retransmisión de ${frame.origenLicencia} para Archivo ID ${reqArchivoId}, fragmentos: ${missingSeqs.join(", ")}`;
        console.log(msg);

        if (archivoId === reqArchivoId && fileChunks.length > 0) {
          const chunksToResend = fileChunks.filter(c => missingSeqs.includes(c.secuenciaId));
          if (chunksToResend.length > 0) {
            alert(`${msg}. Iniciando retransmisión automática...`);
            handleTransmitSpecificChunks(chunksToResend);
          } else {
            alert(`${msg}. No se encontraron los fragmentos especificados en el Transmisor.`);
          }
        } else {
          alert(`${msg}. Cargue el archivo ID ${reqArchivoId} en el Transmisor para poder responder.`);
        }
      } catch (e) {
        console.error("Error parsing received NACK payload", e);
      }
    }
  };

  const handleTransmitSpecificChunks = async (chunks: FileChunk[]) => {
    setIsTransmittingFile(true);
    isTransmittingRef.current = true;

    const options: ModulationOptions = {
      baudRate,
      sampleRate: 44100,
      preambleBytes,
      postambleBytes,
      useNRZI
    };

    const queue: LU_PAMPA_Frame[] = chunks.map(chunk => ({
      origenLicencia,
      origenNodo,
      destinoLicencia,
      destinoNodo,
      archivoId,
      secuenciaId: chunk.secuenciaId,
      tipo: FrameType.FRAGMENTO,
      payload: chunk.payloadBytes
    }));

    for (let i = 0; i < queue.length; i++) {
      if (!isTransmittingRef.current) break;
      setTransmissionProgress(Math.round(((i + 1) / queue.length) * 100));

      const frame = queue[i];
      const rawFrame = serializeFrame(frame);
      const bits = bytesToBits(rawFrame, options);
      const samples = modulateBits(bits, options);

      handlePlayAudio(samples);
      setStats((s) => ({ ...s, sent: s.sent + 1 }));

      const playDurationMs = (samples.length / 44100) * 1000;
      await new Promise((resolve) => setTimeout(resolve, playDurationMs + burstDelay));
    }

    setIsTransmittingFile(false);
    isTransmittingRef.current = false;
  };

  const handleRequestRetransmission = (sessionKey: string) => {
    const fileObj = reassembledFiles.get(sessionKey);
    if (!fileObj) return;
    if (fileObj.completed) return;
    if (fileObj.totalChunks === 0) {
      alert("No se puede solicitar reenvío sin el paquete de metadatos (Fragmento 0) para conocer el total de partes.");
      return;
    }

    const missingSeqs: number[] = [];
    if (!fileObj.receivedChunks.has(0)) {
      missingSeqs.push(0);
    }
    for (let i = 1; i <= fileObj.totalChunks; i++) {
      if (!fileObj.receivedChunks.has(i)) {
        missingSeqs.push(i);
      }
    }

    if (missingSeqs.length === 0) {
      alert("No faltan fragmentos en este archivo.");
      return;
    }

    const payloadText = `NACK:${fileObj.archivoId},${missingSeqs.join(",")}`;
    const payloadBytes = new TextEncoder().encode(payloadText);

    const nackFrame: LU_PAMPA_Frame = {
      origenLicencia,
      origenNodo,
      destinoLicencia: fileObj.origenLicencia,
      destinoNodo: 1,
      archivoId: fileObj.archivoId,
      secuenciaId: 0,
      tipo: FrameType.ACK,
      payload: payloadBytes
    };

    try {
      const options: ModulationOptions = {
        baudRate,
        sampleRate: 44100,
        preambleBytes,
        postambleBytes,
        useNRZI
      };

      const rawFrame = serializeFrame(nackFrame);
      const bits = bytesToBits(rawFrame, options);
      const samples = modulateBits(bits, options);

      alert(`Emitiendo solicitud NACK para retransmitir fragmentos: ${missingSeqs.join(", ")}`);
      handlePlayAudio(samples);
      
      setStats((s) => ({ ...s, sent: s.sent + 1 }));
    } catch (e: any) {
      alert("Error al emitir solicitud NACK: " + e.message);
    }
  };


  const handleDownloadFile = (sessionKey: string, forcePartial = false) => {
    const fileObj = reassembledFiles.get(sessionKey);
    if (!fileObj) return;
    if (!fileObj.completed && !forcePartial) return;

    try {
      const parts: Uint8Array[] = [];
      
      // Determine how many chunks to loop through
      // If metadata was lost, loop up to the maximum received sequence ID
      let maxSeqId = 0;
      for (const seqId of fileObj.receivedChunks.keys()) {
        if (seqId > maxSeqId) maxSeqId = seqId;
      }
      const totalChunksToLoop = fileObj.totalChunks > 0 ? fileObj.totalChunks : maxSeqId;

      for (let i = 1; i <= totalChunksToLoop; i++) {
        const chunkB85Bytes = fileObj.receivedChunks.get(i);
        if (chunkB85Bytes) {
          const b85Str = new TextDecoder().decode(chunkB85Bytes);
          const chunkBin = decodeBase85(b85Str);
          parts.push(chunkBin);
        } else {
          // Fill missing chunk with 48 bytes of zeros
          parts.push(new Uint8Array(48));
        }
      }

      // Concatenate all parts
      const totalBinSize = parts.reduce((acc, p) => acc + p.length, 0);
      const finalBin = new Uint8Array(totalBinSize);
      let offset = 0;
      for (const part of parts) {
        finalBin.set(part, offset);
        offset += part.length;
      }

      // Truncate to exact original size if specified and complete
      const exactBin = (fileObj.totalSize > 0 && !forcePartial) 
        ? finalBin.slice(0, fileObj.totalSize) 
        : finalBin;

      const blob = new Blob([exactBin], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = forcePartial ? `PARCIAL_${fileObj.filename}` : fileObj.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert("Error al reensamblar el archivo: " + e.message);
    }
  };


  // --- RENDER VISUALS (WATERFALL & OSCILLOSCOPE) ---

  const drawSpectrogram = () => {
    if (!isListeningMic || !analyzerRef.current) return;
    const canvas = waterfallCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const analyser = analyzerRef.current;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    // Shift waterfall down
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext("2d");
    if (tempCtx) {
      tempCtx.drawImage(canvas, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(tempCanvas, 0, 1); // Shift 1px down
    }

    // Draw the new top line
    const cellWidth = canvas.width / (bufferLength * 0.4); // Zoom in on low frequencies (up to 4000Hz)
    for (let i = 0; i < bufferLength * 0.4; i++) {
      const value = dataArray[i];
      // Map to blue-purple gradient
      const percent = value / 255;
      const r = Math.floor(percent * 120 + 20);
      const g = Math.floor(percent * 40);
      const b = Math.floor(percent * 240 + 50);

      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(i * cellWidth, 0, cellWidth + 1, 1);
    }

    // Draw grid marks for frequencies
    // sampleRate / fftSize = frequency resolution
    const sampleRate = audioContextRef.current?.sampleRate || 44100;
    const freqResolution = sampleRate / analyser.fftSize;

    // Draw frequency markers every 1000 Hz
    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.font = "8px sans-serif";
    for (let freq = 1000; freq <= 4000; freq += 1000) {
      const bin = Math.round(freq / freqResolution);
      const x = bin * cellWidth;
      if (x < canvas.width) {
        ctx.fillRect(x, 0, 1, 4);
        if (Math.random() < 0.05) { // draw text overlay rarely to avoid jitter
          ctx.fillText(`${freq / 1000}kHz`, x + 2, 8);
        }
      }
    }

    requestRef.current = requestAnimationFrame(drawSpectrogram);
  };

  useEffect(() => {
    if (isListeningMic) {
      drawSpectrogram();
    }
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isListeningMic]);

  // Clean console
  const handleClearConsole = () => {
    setReceivedPackets([]);
  };

  const getFrameTypeName = (type: FrameType): string => {
    switch (type) {
      case FrameType.TEXTO: return "Texto";
      case FrameType.FRAGMENTO: return "Fragmento";
      case FrameType.TOKEN: return "Token";
      case FrameType.ACK: return "ACK";
      case FrameType.BALIZA: return "Baliza";
      default: return "Desconocido";
    }
  };

  // UI Components helpers
  return (
    <div className={`min-h-screen transition-colors duration-200 bg-background text-foreground flex flex-col p-4 md:p-8`}>
      
      {/* HEADER SECTION */}
      <header className="flex flex-col md:flex-row justify-between items-center pb-6 border-b border-border mb-8 gap-4">
        <div className="flex items-center gap-3">
          <div className="bg-primary text-primary-foreground p-3 rounded-lg flex items-center justify-center shadow-lg">
            <Radio className="h-6 w-6 animate-pulse" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              LU-PAMPA V8
              <span className="text-xs bg-primary/20 text-foreground px-2 py-0.5 rounded font-normal border border-border">
                Radio Amateur Suite
              </span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Protocolo Argentino de Mensajería para Aficionados (Alejandro N. Avellaneda)
            </p>
          </div>
        </div>

        {/* Global Controls & Node Stats */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="bg-card border border-border text-card-foreground px-3 py-1.5 rounded-md flex gap-4 text-xs font-mono">
            <div>
              <span className="text-muted-foreground">TX: </span>
              <span className="font-bold text-foreground">{stats.sent}</span>
            </div>
            <div className="border-l border-border pl-4">
              <span className="text-muted-foreground">RX: </span>
              <span className="font-bold text-green-500">{stats.received}</span>
            </div>
            <div className="border-l border-border pl-4">
              <span className="text-muted-foreground">FEC: </span>
              <span className="font-bold text-yellow-500">{stats.fecCorrected}</span>
            </div>
            <div className="border-l border-border pl-4">
              <span className="text-muted-foreground">ERR: </span>
              <span className="font-bold text-destructive">{stats.crcFailed}</span>
            </div>
          </div>

          <button
            onClick={() => setIsDarkMode(!isDarkMode)}
            className="p-2 border border-border rounded-md hover:bg-muted text-foreground transition-colors flex items-center justify-center"
            title="Cambiar Tema"
          >
            <Sparkles className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* COMPLIANCE ALERT */}
      <div className="mb-6 bg-yellow-500/10 border border-yellow-500/20 text-yellow-600 dark:text-yellow-400 p-3 rounded-md text-xs flex gap-2.5 items-start">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
        <div>
          <strong className="font-semibold">Cumplimiento Normativo ENACOM:</strong> Todo tráfico es en texto plano o índices públicos sin cifrar. Es obligatorio indicar su Señal Distintiva (Callsign) oficial en cada transmisión. Prohibido el uso comercial.
        </div>
      </div>

      {/* DASHBOARD GRID */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">
        
        {/* PANEL IZQUIERDO: TRANSMISOR (5 columnas) */}
        <section className="xl:col-span-5 bg-card border border-border text-card-foreground p-5 rounded-lg shadow-sm flex flex-col gap-6">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Volume2 className="h-5 w-5 text-muted-foreground" />
              Transmisor (Modulador)
            </h2>
            {isTransmittingFile && (
              <span className="text-xs bg-destructive/15 text-destructive px-2 py-0.5 rounded font-mono animate-pulse">
                TX Activo
              </span>
            )}
          </div>

          {/* Config Cabeceras */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">ORIGEN LICENCIA</label>
              <input
                type="text"
                maxLength={7}
                value={origenLicencia}
                onChange={(e) => setOrigenLicencia(e.target.value.toUpperCase())}
                className="w-full bg-input/10 border border-input rounded-md px-3 py-1.5 text-sm font-mono tracking-wide focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">NODO ORIGEN</label>
              <input
                type="number"
                min={0}
                max={65535}
                value={origenNodo}
                onChange={(e) => setOrigenNodo(parseInt(e.target.value) || 0)}
                className="w-full bg-input/10 border border-input rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">DESTINO LICENCIA</label>
              <input
                type="text"
                maxLength={7}
                value={destinoLicencia}
                onChange={(e) => setDestinoLicencia(e.target.value.toUpperCase())}
                className="w-full bg-input/10 border border-input rounded-md px-3 py-1.5 text-sm font-mono tracking-wide focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">NODO DESTINO</label>
              <input
                type="number"
                min={0}
                max={65535}
                value={destinoNodo}
                onChange={(e) => setDestinoNodo(parseInt(e.target.value) || 0)}
                className="w-full bg-input/10 border border-input rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">ARCHIVO ID (SESIÓN)</label>
              <input
                type="number"
                min={0}
                max={255}
                value={archivoId}
                onChange={(e) => setArchivoId(parseInt(e.target.value) || 0)}
                className="w-full bg-input/10 border border-input rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">SECUENCIA ID</label>
              <input
                type="number"
                min={0}
                max={65535}
                value={secuenciaId}
                onChange={(e) => setSecuenciaId(parseInt(e.target.value) || 0)}
                disabled={frameType === FrameType.FRAGMENTO}
                className="w-full bg-input/10 border border-input rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              />
            </div>
          </div>

          {/* Tipo de Trama */}
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">TIPO DE PAQUETE</label>
            <div className="grid grid-cols-5 gap-1.5 bg-input/10 p-1 border border-border rounded-md">
              {[
                { type: FrameType.TEXTO, label: "Texto" },
                { type: FrameType.FRAGMENTO, label: "Archivo" },
                { type: FrameType.TOKEN, label: "Token" },
                { type: FrameType.ACK, label: "ACK" },
                { type: FrameType.BALIZA, label: "Baliza" }
              ].map((item) => (
                <button
                  key={item.type}
                  onClick={() => setFrameType(item.type)}
                  className={`text-[11px] font-medium py-1 px-1.5 rounded transition-all ${
                    frameType === item.type
                      ? "bg-primary text-primary-foreground shadow"
                      : "hover:bg-muted text-muted-foreground"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* Formulario Dinámico Payload */}
          <div className="bg-muted/30 border border-border p-4 rounded-md min-h-[120px] flex flex-col justify-center gap-3">
            {frameType === FrameType.TEXTO && (
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">MENSAJE EN TEXTO PLANO</label>
                <textarea
                  value={textPayload}
                  onChange={(e) => setTextPayload(e.target.value)}
                  maxLength={180}
                  className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm font-sans focus:outline-none focus:ring-1 focus:ring-ring min-h-[60px]"
                />
                <span className="text-[10px] text-muted-foreground flex justify-end font-mono mt-1">
                  {new TextEncoder().encode(textPayload).length} / 180 bytes
                </span>
              </div>
            )}

            {frameType === FrameType.TOKEN && (
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">ID DEL RECURSO (16-bit)</label>
                <input
                  type="number"
                  min={0}
                  max={65535}
                  value={tokenPayload}
                  onChange={(e) => setTokenPayload(parseInt(e.target.value) || 0)}
                  className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <span className="text-[10px] text-muted-foreground mt-1 block">
                  Invoca un recurso multimedia guardado localmente (Sincronización Delta).
                </span>
              </div>
            )}

            {frameType === FrameType.BALIZA && (
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">TELEMETRÍA (TEXTO)</label>
                <input
                  type="text"
                  value={telemetryPayload}
                  onChange={(e) => setTelemetryPayload(e.target.value)}
                  className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <span className="text-[10px] text-muted-foreground mt-1 block">
                  Difusión automática de estado de sensores, voltaje y temperatura.
                </span>
              </div>
            )}

            {frameType === FrameType.ACK && (
              <div className="text-center py-4 text-xs text-muted-foreground flex flex-col items-center gap-1.5">
                <CheckCircle className="h-6 w-6 text-green-500" />
                Acuse de Recibo (Confirma entrega exitosa de una trama)
              </div>
            )}

            {frameType === FrameType.FRAGMENTO && (
              <div className="flex flex-col gap-3">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-semibold text-muted-foreground">FRAGMENTACIÓN DE ARCHIVO</label>
                  {fileChunks.length > 0 && (
                    <span className="text-[10px] bg-primary/20 text-foreground px-2 py-0.5 rounded font-mono">
                      {fileChunks.length} fragmentos
                    </span>
                  )}
                </div>
                
                <div className="flex gap-2 items-center">
                  <label className="flex items-center justify-center border border-dashed border-border rounded-md bg-background px-4 py-2 hover:bg-muted cursor-pointer transition-colors w-full text-xs text-muted-foreground">
                    <FolderOpen className="h-4 w-4 mr-2" />
                    {selectedFile ? selectedFile.name : "Seleccionar Archivo (PDF, CSV, JPG...)"}
                    <input
                      type="file"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) setSelectedFile(file);
                      }}
                      className="sr-only"
                    />
                  </label>
                  {selectedFile && (
                    <button
                      onClick={() => {
                        setSelectedFile(null);
                        setFileChunks([]);
                      }}
                      className="p-2 border border-border hover:bg-destructive/10 hover:text-destructive rounded-md transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {fileChunks.length > 0 && (
                  <div className="text-[10px] text-muted-foreground font-mono space-y-1 bg-background p-2 rounded border border-border max-h-[80px] overflow-y-auto">
                    <div>Nombre: {selectedFile?.name}</div>
                    <div>Tamaño: {selectedFile?.size} bytes</div>
                    <div className="text-primary font-semibold">
                      Fragmento 0: Metadatos ({fileChunks[0].payloadText.length} bytes)
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Parámetros de la Capa Física */}
          <div className="border-t border-border pt-4 flex flex-col gap-4">
            <h3 className="text-xs font-bold text-muted-foreground uppercase flex items-center gap-1.5">
              <Sliders className="h-3.5 w-3.5" />
              Parámetros de Modulación
            </h3>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">VELOCIDAD BAUDIOS</label>
                <select
                  value={baudRate}
                  onChange={(e) => setBaudRate(parseInt(e.target.value))}
                  className="w-full bg-input/10 border border-input rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value={1200}>1200 Baudios (Bell 202)</option>
                  <option value={9600}>9600 Baudios (High Speed)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-muted-foreground mb-1">MÉTODO MODULACIÓN</label>
                <select
                  value={useNRZI ? "nrzi" : "direct"}
                  onChange={(e) => setUseNRZI(e.target.value === "nrzi")}
                  className="w-full bg-input/10 border border-input rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="direct">Direct FSK (Fuerte ruido)</option>
                  <option value="nrzi">NRZI + Bit Stuffing (AX.25)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-muted-foreground mb-1">PREÁMBULO (SYNC BYTES)</label>
                <input
                  type="number"
                  min={8}
                  max={64}
                  value={preambleBytes}
                  onChange={(e) => setPreambleBytes(parseInt(e.target.value) || 8)}
                  className="w-full bg-input/10 border border-input rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              <div>
                <label className="block text-xs text-muted-foreground mb-1">BURST DELAY (MS)</label>
                <input
                  type="number"
                  min={100}
                  max={2000}
                  value={burstDelay}
                  onChange={(e) => setBurstDelay(parseInt(e.target.value) || 500)}
                  className="w-full bg-input/10 border border-input rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              <div>
                <label className="block text-xs text-muted-foreground mb-1">REDUNDANCIA TRANSMISIÓN</label>
                <select
                  value={transmissionRedundancy}
                  onChange={(e) => setTransmissionRedundancy(parseInt(e.target.value) || 1)}
                  className="w-full bg-input/10 border border-input rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring font-medium"
                >
                  <option value={1} className="bg-card">x1 (Sin redundancia)</option>
                  <option value={2} className="bg-card">x2 (Duplicado ráfagas)</option>
                  <option value={3} className="bg-card">x3 (Triplicado ráfagas)</option>
                </select>
              </div>
            </div>


            {/* Volume control */}
            <div>
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>VOLUMEN REPRODUCCIÓN</span>
                <span className="font-mono">{Math.round(volume * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => setVolume(parseFloat(e.target.value))}
                className="w-full accent-primary bg-muted rounded-lg appearance-none h-1.5 cursor-pointer"
              />
            </div>
          </div>

          {/* Visualizador Osciloscopio TX */}
          <div className="bg-black border border-border p-1.5 rounded-md relative">
            <div className="absolute top-2 left-2 text-[9px] font-mono text-white/50 bg-black/70 px-1 rounded z-10">
              MODULADOR OSCILOSCOPIO
            </div>
            <canvas
              ref={txCanvasRef}
              width={600}
              height={100}
              className="w-full h-[80px] bg-black block rounded"
            />
          </div>

          {/* Controles de Transmisión */}
          <div className="flex flex-col gap-2.5">
            {frameType === FrameType.FRAGMENTO && fileChunks.length > 0 ? (
              // Controles Ráfaga para Archivos
              isTransmittingFile ? (
                <button
                  onClick={handleCancelTransmission}
                  className="w-full bg-destructive text-destructive-foreground font-semibold py-2.5 rounded-md shadow hover:bg-destructive/90 transition-all text-sm flex items-center justify-center gap-2"
                >
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  Cancelar Transmisión de Archivo ({transmissionProgress}%)
                </button>
              ) : (
                <div className="flex flex-col gap-2.5 w-full">
                  <button
                    onClick={handleTransmitFile}
                    className="w-full bg-primary text-primary-foreground font-semibold py-2.5 rounded-md shadow hover:bg-primary/90 transition-all text-sm flex items-center justify-center gap-2"
                  >
                    <Volume2 className="h-4 w-4" />
                    Transmitir Ráfaga ({fileChunks.length} Fragmentos)
                  </button>
                  <button
                    onClick={handleGenerateEntireFileAudio}
                    disabled={isGeneratingFileAudio}
                    className="w-full bg-secondary text-secondary-foreground font-semibold py-2.5 rounded-md hover:bg-secondary/80 transition-all text-sm flex items-center justify-center gap-2 border border-border disabled:opacity-50"
                  >
                    {isGeneratingFileAudio ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <FileCode className="h-4 w-4" />
                    )}
                    Generar Audio de Ráfaga (WAV/MP3)
                  </button>
                </div>
              )
            ) : (
              // Controles Individuales
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => handleGenerateAudio()}
                  className="bg-secondary text-secondary-foreground font-semibold py-2.5 rounded-md hover:bg-secondary/80 transition-all text-sm flex items-center justify-center gap-2 border border-border"
                >
                  <FileCode className="h-4 w-4" />
                  Generar Audio (WAV/MP3)
                </button>
                <button
                  onClick={() => {
                    handleGenerateAudio(true);
                    handlePlayAudio();
                    setStats((s) => ({ ...s, sent: s.sent + 1 }));
                  }}
                  className="bg-primary text-primary-foreground font-semibold py-2.5 rounded-md shadow hover:bg-primary/90 transition-all text-sm flex items-center justify-center gap-2"
                >
                  <Radio className="h-4 w-4" />
                  Emitir Trama
                </button>
              </div>
            )}

            {generatedWavUrl && !isTransmittingFile && (
              <div className="grid grid-cols-2 gap-2.5 w-full">
                <a
                  href={generatedWavUrl}
                  download={`pampa_v8_${origenLicencia}_frame.wav`}
                  className="border border-border hover:bg-muted font-medium py-1.5 rounded-md text-xs text-center flex items-center justify-center gap-2 transition-all font-semibold"
                >
                  <Download className="h-3.5 w-3.5" />
                  Descargar WAV
                </a>
                {generatedMp3Url && (
                  <a
                    href={generatedMp3Url}
                    download={`pampa_v8_${origenLicencia}_frame.mp3`}
                    className="border border-border hover:bg-muted font-medium py-1.5 rounded-md text-xs text-center flex items-center justify-center gap-2 transition-all font-semibold"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Descargar MP3
                  </a>
                )}
              </div>
            )}

            {frameType === FrameType.FRAGMENTO && generatedFileWavUrl && !isTransmittingFile && (
              <div className="grid grid-cols-2 gap-2.5 w-full animate-fadeIn">
                <a
                  href={generatedFileWavUrl}
                  download={`pampa_v8_${origenLicencia}_rafaga_${archivoId}.wav`}
                  className="border border-border hover:bg-muted font-medium py-1.5 rounded-md text-xs text-center flex items-center justify-center gap-2 transition-all font-semibold text-green-500 border-green-500/30"
                >
                  <Download className="h-3.5 w-3.5" />
                  Descargar Ráfaga WAV
                </a>
                {generatedFileMp3Url && (
                  <a
                    href={generatedFileMp3Url}
                    download={`pampa_v8_${origenLicencia}_rafaga_${archivoId}.mp3`}
                    className="border border-border hover:bg-muted font-medium py-1.5 rounded-md text-xs text-center flex items-center justify-center gap-2 transition-all font-semibold text-green-500 border-green-500/30"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Descargar Ráfaga MP3
                  </a>
                )}
              </div>
            )}


          </div>
        </section>

        {/* PANEL DERECHO: RECEPTOR (7 columnas) */}
        <section className="xl:col-span-7 flex flex-col gap-6">
          
          {/* CONTROL DE ENTRADA Y CASCADA DSP */}
          <div className="bg-card border border-border text-card-foreground p-5 rounded-lg shadow-sm flex flex-col gap-5">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Activity className="h-5 w-5 text-muted-foreground" />
                Receptor (Demodulador DSP)
              </h2>
              <div className="flex items-center gap-2.5">
                <label className="flex items-center gap-1.5 text-xs bg-muted border border-border hover:bg-muted/80 rounded px-2.5 py-1 cursor-pointer transition-colors font-medium">
                  <FolderOpen className="h-3.5 w-3.5" />
                  Decodificar Audio WAV
                  <input
                    type="file"
                    accept="audio/wav,audio/*"
                    onChange={handleAudioFileUpload}
                    className="sr-only"
                  />
                </label>
                
                {isListeningMic ? (
                  <button
                    onClick={handleStopListening}
                    className="bg-destructive text-destructive-foreground text-xs font-semibold px-3 py-1 rounded shadow hover:bg-destructive/90 transition-all flex items-center gap-1.5"
                  >
                    <MicOff className="h-3.5 w-3.5" />
                    Detener Escucha
                  </button>
                ) : (
                  <button
                    onClick={handleToggleMic}
                    className="bg-primary text-primary-foreground text-xs font-semibold px-3 py-1 rounded shadow hover:bg-primary/90 transition-all flex items-center gap-1.5"
                  >
                    <Mic className="h-3.5 w-3.5" />
                    Escuchar Micrófono
                  </button>
                )}
              </div>
            </div>

            {/* Squelch slider */}
            <div className="flex gap-4 items-center">
              <div className="w-1/3">
                <div className="flex justify-between text-xs text-muted-foreground mb-1">
                  <span>Squelch Threshold</span>
                  <span className="font-mono">{(squelch * 1000).toFixed(0)}m</span>
                </div>
                <input
                  type="range"
                  min={0.002}
                  max={0.1}
                  step={0.002}
                  value={squelch}
                  onChange={(e) => setSquelch(parseFloat(e.target.value))}
                  className="w-full accent-primary bg-muted rounded-lg appearance-none h-1 cursor-pointer"
                />
              </div>
              <div className="text-xs font-mono text-muted-foreground mt-4">
                Estado: <span className={isListeningMic ? "text-green-500 font-bold" : "text-destructive"}>{micStatusText}</span>
              </div>
            </div>

            {/* Waterfall display */}
            <div className="bg-black border border-border p-1.5 rounded-md relative">
              <div className="absolute top-2 left-2 text-[9px] font-mono text-white/50 bg-black/70 px-1 rounded z-10">
                DSP ESPECTRO EN TIEMPO REAL (WATERFALL 1000 - 4000Hz)
              </div>
              <canvas
                ref={waterfallCanvasRef}
                width={800}
                height={120}
                className="w-full h-[120px] bg-black block rounded"
              />
            </div>
          </div>

          {/* SECCIÓN REENSAMBLADOR DE ARCHIVOS */}
          {reassembledFiles.size > 0 && (
            <div className="bg-card border border-border text-card-foreground p-5 rounded-lg shadow-sm flex flex-col gap-4">
              <h2 className="text-md font-semibold border-b border-border pb-2 flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-primary" />
                Catálogo de Archivos Recibidos (Sincronización Multiplexada)
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {Array.from(reassembledFiles.entries()).map(([key, file]) => {
                  let dataChunksCount = 0;
                  for (const k of file.receivedChunks.keys()) {
                    if (k > 0) dataChunksCount++;
                  }
                  const progress = file.totalChunks > 0
                    ? Math.round((dataChunksCount / file.totalChunks) * 100)
                    : 0;

                  return (
                    <div key={key} className="border border-border p-3 rounded bg-muted/20 flex flex-col gap-2.5 animate-fadeIn">
                      <div className="flex justify-between items-start gap-2">
                        <div className="min-w-0">
                          <h3 className="text-xs font-bold truncate text-foreground flex items-center gap-1">
                            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            {file.filename}
                          </h3>
                          <span className="text-[10px] text-muted-foreground">
                            De: {file.origenLicencia} | ID Sesión: {file.archivoId}
                          </span>
                        </div>
                        {file.completed ? (
                          <span className="text-[10px] bg-green-500/10 text-green-500 border border-green-500/20 px-2 py-0.5 rounded font-semibold shrink-0">
                            Completado
                          </span>
                        ) : (
                          <span className="text-[10px] bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border border-yellow-500/20 px-2 py-0.5 rounded font-semibold shrink-0">
                            Recibiendo
                          </span>
                        )}
                      </div>

                      {/* progress bar */}
                      <div className="w-full bg-muted rounded-full h-1.5 mt-2">
                        <div
                          className={`h-1.5 rounded-full ${file.completed ? "bg-green-500" : "bg-primary"}`}
                          style={{ width: `${progress}%` }}
                        />
                      </div>


                      <div className="flex justify-between items-center text-[10px] font-mono text-muted-foreground">
                        <span>
                          Fragmentos: {dataChunksCount} / {file.totalChunks}
                        </span>
                        <span>{file.totalSize} bytes</span>
                      </div>

                      {/* VS Code Style Tree View of Packets */}
                      <div className="flex flex-col gap-1.5 mt-2 border-t border-border/40 pt-3">
                        <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">
                          Estructura de Tramos (Vista de Árbol):
                        </span>
                        
                        {file.totalChunks > 0 ? (
                          <div className="bg-black/20 dark:bg-black/35 border border-border/60 rounded-md p-1 font-mono text-[11px]">
                            {/* Folder Row */}
                            <div 
                              onClick={() => toggleFileExpansion(key)}
                              className="flex items-center justify-between py-1 px-2 rounded hover:bg-muted/50 cursor-pointer transition-colors"
                            >
                              <div className="flex items-center gap-1.5 select-none font-semibold text-foreground">
                                {expandedFiles[key] !== false ? (
                                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                                )}
                                {expandedFiles[key] !== false ? (
                                  <FolderOpen className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500/20" />
                                ) : (
                                  <Folder className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500/20" />
                                )}
                                <span className="truncate max-w-[140px]">{file.filename}</span>
                              </div>
                              <span className="text-[9px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded font-bold">
                                {dataChunksCount} / {file.totalChunks}
                              </span>
                            </div>

                            {/* Expanded Children */}
                            {expandedFiles[key] !== false && (
                              <div className="border-l border-border/30 ml-[15px] pl-2 mt-0.5 space-y-0.5 max-h-[160px] overflow-y-auto select-none">
                                {/* Fragment 0 (Metadata) */}
                                {(() => {
                                  const received = file.receivedChunks.has(0);
                                  const state = file.chunkStates?.get(0);
                                  return (
                                    <div className="flex items-center justify-between py-0.5 px-1.5 rounded hover:bg-muted/20 transition-colors">
                                      <div className="flex items-center gap-1.5 text-foreground/80">
                                        <FileText className="h-3 w-3 text-blue-400" />
                                        <span>Metadatos (Frag 0)</span>
                                      </div>
                                      {received ? (
                                        state?.fecCorrected ? (
                                          <span className="text-[9px] text-yellow-500 font-bold" title={`${state.errorsCorrected} bytes corregidos por Reed-Solomon`}>
                                            FEC ({state.errorsCorrected})
                                          </span>
                                        ) : (
                                          <span className="text-[9px] text-green-500 font-bold">OK</span>
                                        )
                                      ) : (
                                        <span className="text-[9px] text-destructive font-bold animate-pulse">FALTA</span>
                                      )}
                                    </div>
                                  );
                                })()}

                                {/* Data Fragments */}
                                {Array.from({ length: file.totalChunks }, (_, idx) => {
                                  const chunkId = idx + 1;
                                  const received = file.receivedChunks.has(chunkId);
                                  const state = file.chunkStates?.get(chunkId);
                                  
                                  return (
                                    <div key={chunkId} className="flex items-center justify-between py-0.5 px-1.5 rounded hover:bg-muted/20 transition-colors">
                                      <div className="flex items-center gap-1.5 text-foreground/80">
                                        <FileText className="h-3 w-3 text-muted-foreground" />
                                        <span>Parte {chunkId}</span>
                                      </div>
                                      {received ? (
                                        state?.fecCorrected ? (
                                          <span className="text-[9px] text-yellow-500 font-bold" title={`${state.errorsCorrected} bytes corregidos por Reed-Solomon`}>
                                            FEC ({state.errorsCorrected})
                                          </span>
                                        ) : (
                                          <span className="text-[9px] text-green-500 font-bold">OK</span>
                                        )
                                      ) : (
                                        <span className="text-[9px] text-destructive font-bold animate-pulse">FALTA</span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-[9px] text-yellow-600 dark:text-yellow-400 italic bg-yellow-500/10 p-2 rounded border border-yellow-500/20 leading-tight">
                            Esperando recibir el paquete de metadatos (Fragmento 0) para iniciar el árbol de paquetes.
                          </div>
                        )}
                      </div>

                      {/* Download & NACK buttons */}
                      <div className="flex flex-col gap-1.5 mt-2">
                        {file.completed ? (
                          <button
                            onClick={() => handleDownloadFile(key)}
                            className="w-full bg-green-500 text-white font-semibold py-1.5 px-3 rounded hover:bg-green-600 transition-colors text-xs flex items-center justify-center gap-1.5 shadow"
                          >
                            <CheckCircle className="h-3.5 w-3.5" />
                            Reensamblar y Descargar
                          </button>
                        ) : (
                          <>
                            {dataChunksCount > 0 && (
                              <button
                                onClick={() => handleDownloadFile(key, true)}
                                className="w-full bg-amber-500 hover:bg-amber-600 text-white font-semibold py-1.5 px-3 rounded transition-colors text-xs flex items-center justify-center gap-1.5 shadow"
                              >
                                <AlertTriangle className="h-3.5 w-3.5" />
                                Forzar Descarga Parcial
                              </button>
                            )}
                            {file.totalChunks > 0 && (
                              <button
                                onClick={() => handleRequestRetransmission(key)}
                                className="w-full bg-primary/20 hover:bg-primary/30 border border-primary/30 text-foreground font-semibold py-1.5 px-3 rounded transition-colors text-xs flex items-center justify-center gap-1.5 shadow"
                              >
                                <Radio className="h-3.5 w-3.5 text-primary animate-pulse" />
                                Solicitar Reenvío de Faltantes (NACK)
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}

              </div>
            </div>
          )}

          {/* TRÁFICO DE TRAMAS RECIBIDAS */}
          <div className="bg-card border border-border text-card-foreground p-5 rounded-lg shadow-sm flex-col flex gap-4 min-h-[300px]">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Radio className="h-5 w-5 text-muted-foreground" />
                Consola de Tráfico Recibido
              </h2>
              {receivedPackets.length > 0 && (
                <button
                  onClick={handleClearConsole}
                  className="text-xs hover:text-destructive flex items-center gap-1 transition-colors text-muted-foreground"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Limpiar Consola
                </button>
              )}
            </div>

            <div className="flex flex-col gap-3 overflow-y-auto max-h-[400px]">
              {receivedPackets.length === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-16">
                  Esperando tramas... (Inicie la escucha con el micrófono o cargue un archivo WAV)
                </div>
              ) : (
                receivedPackets.map((pkt, idx) => {
                  const { frame, fecCorrected, errorsCorrected, crcValid } = pkt.result;
                  const dateStr = new Date(pkt.timestamp).toLocaleTimeString();
                  
                  // Convert payload to printable string
                  let payloadText = "";
                  if (frame.tipo === FrameType.TOKEN) {
                    const id = (frame.payload[0] << 8) | frame.payload[1];
                    payloadText = `TOKEN ID: ${id}`;
                  } else {
                    payloadText = new TextEncoder().encode(new TextDecoder().decode(frame.payload)).length > 0 
                      ? new TextDecoder().decode(frame.payload)
                      : "[Vacío]";
                  }

                  return (
                    <div
                      key={idx}
                      className={`border p-3.5 rounded-lg shadow-sm flex flex-col gap-2.5 transition-all bg-card ${
                        !crcValid
                          ? "border-destructive/30 bg-destructive/5"
                          : fecCorrected
                          ? "border-yellow-500/30 bg-yellow-500/5"
                          : "border-border hover:border-muted-foreground/30"
                      }`}
                    >
                      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
                        {/* Callsign Routing Info */}
                        <div className="flex items-center gap-2 text-xs font-mono">
                          <span className="font-bold text-foreground bg-muted px-1.5 py-0.5 rounded border border-border">
                            {frame.origenLicencia} (Nodo {frame.origenNodo})
                          </span>
                          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="font-bold text-foreground bg-muted px-1.5 py-0.5 rounded border border-border">
                            {frame.destinoLicencia} (Nodo {frame.destinoNodo})
                          </span>
                        </div>

                        {/* Timestamp & Type */}
                        <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
                          <span>{dateStr}</span>
                          <span className="bg-primary/10 text-foreground px-2 py-0.5 rounded font-semibold uppercase">
                            {getFrameTypeName(frame.tipo)}
                          </span>
                          <button
                            onClick={() => handleDownloadPacketMp3(pkt)}
                            className="flex items-center gap-1 bg-secondary hover:bg-muted text-foreground border border-border px-2 py-0.5 rounded transition-all cursor-pointer font-semibold text-[10px]"
                            title="Descargar audio MP3 de esta trama"
                          >
                            <Download className="h-3 w-3 text-muted-foreground" />
                            MP3
                          </button>
                        </div>

                      </div>

                      {/* Decoded Data Payload */}
                      <div className="bg-background/50 border border-border p-2.5 rounded font-mono text-xs text-foreground select-text whitespace-pre-wrap break-all">
                        {payloadText}
                      </div>

                      {/* Header details & FEC state */}
                      <div className="flex flex-wrap justify-between items-center text-[10px] font-mono text-muted-foreground border-t border-border/50 pt-2 gap-2">
                        <div className="flex gap-4">
                          <span>Archivo ID: {frame.archivoId}</span>
                          <span>Sec: {frame.secuenciaId}</span>
                        </div>

                        <div className="flex items-center gap-3">
                          {fecCorrected ? (
                            <span className="text-yellow-600 dark:text-yellow-400 font-semibold flex items-center gap-1">
                              <ShieldCheck className="h-3.5 w-3.5" />
                              FEC OK (+{errorsCorrected} bytes corregidos)
                            </span>
                          ) : (
                            <span className="text-green-500 font-semibold flex items-center gap-1">
                              <ShieldCheck className="h-3.5 w-3.5" />
                              FEC Limpio
                            </span>
                          )}

                          {crcValid ? (
                            <span className="text-green-500 font-semibold flex items-center gap-1 bg-green-500/10 px-1.5 py-0.5 rounded">
                              CRC Válido
                            </span>
                          ) : (
                            <span className="text-destructive font-semibold flex items-center gap-1 bg-destructive/10 px-1.5 py-0.5 rounded">
                              CRC Inválido
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>

      </div>

      {/* FOOTER */}
      <footer className="mt-16 pt-6 border-t border-border text-center text-xs text-muted-foreground">
        <div>
          LU-PAMPA V8 Suite de Comunicaciones Digitales por Radio
        </div>
        <div className="mt-1 opacity-70">
          Desarrollado de conformidad con la normativa de radioafición de la República Argentina.
        </div>
      </footer>
    </div>
  );
}
