import { jsPDF } from 'jspdf';
import type { LU_PAMPA_Frame } from './protocol';

export function downloadFramePdf(frame: LU_PAMPA_Frame, options: {
  baudRate: number;
  useNRZI: boolean;
  isReceived?: boolean;
  errorsCorrected?: number;
  fecCorrected?: boolean;
  crcValid?: boolean;
}) {
  const doc = new jsPDF();
  
  // Set draw color and line width for decorative borders
  doc.setDrawColor(20, 20, 20);
  doc.setLineWidth(0.5);
  doc.rect(5, 5, 200, 287); // Page border
  doc.rect(7, 7, 196, 283); // Secondary border
  
  // Header background color
  doc.setFillColor(30, 41, 59); // Slate-800
  doc.rect(8, 8, 194, 25, 'F');
  
  // Title text
  doc.setTextColor(255, 255, 255);
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(16);
  const title = options.isReceived ? "INFORME DE RECEPCIÓN (QSL CARD)" : "FICHA DE TRANSMISIÓN DE TRAMA";
  doc.text(title, 15, 24);
  
  // Protocol Version
  doc.setFontSize(10);
  doc.text("LU-PAMPA V8 PROTOCOL", 155, 24);
  
  // Section 1: Frame metadata
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(12);
  doc.setFont("Helvetica", "bold");
  doc.text("1. METADATOS DE LA TRAMA", 12, 45);
  doc.line(12, 47, 198, 47);
  
  doc.setFont("Helvetica", "normal");
  doc.setFontSize(10);
  
  const col1X = 15;
  const col2X = 110;
  let y = 55;
  
  // Details Grid
  doc.setFont("Helvetica", "bold"); doc.text("Licencia de Origen:", col1X, y);
  doc.setFont("Helvetica", "normal"); doc.text(frame.origenLicencia, col1X + 45, y);
  
  doc.setFont("Helvetica", "bold"); doc.text("Nodo de Origen:", col2X, y);
  doc.setFont("Helvetica", "normal"); doc.text(frame.origenNodo.toString(), col2X + 45, y);
  
  y += 10;
  doc.setFont("Helvetica", "bold"); doc.text("Licencia de Destino:", col1X, y);
  doc.setFont("Helvetica", "normal"); doc.text(frame.destinoLicencia, col1X + 45, y);
  
  doc.setFont("Helvetica", "bold"); doc.text("Nodo de Destino:", col2X, y);
  doc.setFont("Helvetica", "normal"); doc.text(frame.destinoNodo.toString(), col2X + 45, y);
  
  y += 10;
  doc.setFont("Helvetica", "bold"); doc.text("ID del Archivo:", col1X, y);
  doc.setFont("Helvetica", "normal"); doc.text(frame.archivoId.toString(), col1X + 45, y);
  
  doc.setFont("Helvetica", "bold"); doc.text("ID de Secuencia:", col2X, y);
  doc.setFont("Helvetica", "normal"); doc.text(frame.secuenciaId.toString(), col2X + 45, y);
  
  y += 10;
  const frameTypeNames: Record<number, string> = {
    1: "TEXTO (0x01)",
    2: "FRAGMENTO (0x02)",
    3: "TOKEN (0x03)",
    4: "ACK (0x04)",
    5: "BALIZA (0x05)"
  };
  doc.setFont("Helvetica", "bold"); doc.text("Tipo de Trama:", col1X, y);
  doc.setFont("Helvetica", "normal"); doc.text(frameTypeNames[frame.tipo] || `DESCONOCIDO (${frame.tipo})`, col1X + 45, y);
  
  doc.setFont("Helvetica", "bold"); doc.text("Fecha y Hora:", col2X, y);
  doc.setFont("Helvetica", "normal"); doc.text(new Date().toLocaleString(), col2X + 45, y);
  
  // Section 2: Physical layer
  y += 20;
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(12);
  doc.text("2. CAPA FÍSICA Y CONFIGURACIÓN", 12, y);
  doc.line(12, y + 2, 198, y + 2);
  
  y += 10;
  doc.setFont("Helvetica", "normal");
  doc.setFontSize(10);
  
  doc.setFont("Helvetica", "bold"); doc.text("Velocidad de Símbolo:", col1X, y);
  doc.setFont("Helvetica", "normal"); doc.text(`${options.baudRate} Baudios`, col1X + 45, y);
  
  doc.setFont("Helvetica", "bold"); doc.text("Método de Modulación:", col2X, y);
  doc.setFont("Helvetica", "normal"); doc.text(options.useNRZI ? "NRZI + Bit Stuffing (AX.25)" : "Direct Binary FSK", col2X + 45, y);
  
  y += 10;
  doc.setFont("Helvetica", "bold"); doc.text("Frecuencia Mark (1):", col1X, y);
  doc.setFont("Helvetica", "normal"); doc.text(options.baudRate === 9600 ? "4800 Hz" : "1200 Hz", col1X + 45, y);
  
  doc.setFont("Helvetica", "bold"); doc.text("Frecuencia Space (0):", col2X, y);
  doc.setFont("Helvetica", "normal"); doc.text(options.baudRate === 9600 ? "9600 Hz" : "2200 Hz", col2X + 45, y);
  
  if (options.isReceived) {
    y += 10;
    doc.setFont("Helvetica", "bold"); doc.text("Decodificación RS:", col1X, y);
    const rsStatus = options.fecCorrected 
      ? `Corregido (${options.errorsCorrected} Bytes de error)` 
      : "Exitoso (Sin errores)";
    doc.setFont("Helvetica", "normal"); doc.text(rsStatus, col1X + 45, y);
    
    doc.setFont("Helvetica", "bold"); doc.text("Verificación CRC16:", col2X, y);
    doc.setFont("Helvetica", "normal"); 
    if (options.crcValid) {
      doc.setTextColor(34, 197, 94); // Green
      doc.text("VÁLIDO (Exitoso)", col2X + 45, y);
    } else {
      doc.setTextColor(239, 68, 68); // Red
      doc.text("INVÁLIDO (Error de suma)", col2X + 45, y);
    }
    doc.setTextColor(20, 20, 20); // Reset
  }
  
  // Section 3: Payload
  y += 20;
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(12);
  doc.text("3. PAYLOAD Y VOLCADO DE DATOS", 12, y);
  doc.line(12, y + 2, 198, y + 2);
  
  y += 10;
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(10);
  doc.text(`Contenido del Mensaje (${frame.payload.length} Bytes):`, col1X, y);
  
  y += 6;
  doc.setFont("Courier", "normal");
  doc.setFontSize(9);
  
  // Convert payload to text or hex representation
  let asciiText: string;
  try {
    const decoded = new TextDecoder().decode(frame.payload);
    // Replace non-printable characters
    asciiText = decoded.replace(/[^\x20-\x7E\n]/g, ".");
  } catch {
    asciiText = "[Datos Binarios]";
  }
  
  // Split into lines to fit page
  const textLines = doc.splitTextToSize(asciiText, 180);
  doc.text(textLines, col1X, y);
  
  // Draw Hex Dump below
  y += (textLines.length * 4) + 10;
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Volcado Hexadecimal (Hex Dump):", col1X, y);
  
  y += 6;
  doc.setFont("Courier", "normal");
  doc.setFontSize(8.5);
  
  const hexDumpLines: string[] = [];
  for (let i = 0; i < frame.payload.length; i += 16) {
    const chunk = frame.payload.slice(i, i + 16);
    const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const offsetStr = i.toString(16).padStart(4, '0').toUpperCase();
    
    // Create printable preview side-by-side
    let preview = "";
    for (let j = 0; j < chunk.length; j++) {
      const char = String.fromCharCode(chunk[j]);
      preview += (chunk[j] >= 32 && chunk[j] <= 126) ? char : ".";
    }
    
    hexDumpLines.push(`${offsetStr}  ${hex.padEnd(48, ' ')}  |${preview}|`);
  }
  
  doc.text(hexDumpLines, col1X, y);
  
  // Footer
  doc.setFont("Helvetica", "oblique");
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text("Este reporte representa el estado lógico de una trama de radio digital decodificada por software.", 15, 275);
  doc.text("Sistema LU-PAMPA V8 - Desarrollado para Radioafición y Telecomunicaciones de Emergencia.", 15, 280);
  
  const filename = options.isReceived
    ? `QSL_LU_PAMPA_V8_${frame.origenLicencia}_${frame.secuenciaId}.pdf`
    : `TICKET_LU_PAMPA_V8_${frame.origenLicencia}_${frame.secuenciaId}.pdf`;
    
  doc.save(filename);
}
