# 📻 LU-PAMPA (LU-PAMPAR) — Web-Based AFSK Modem & Protocol

[![React Version](https://img.shields.io/badge/React-19.2.6-blue.svg?style=flat-square&logo=react)](https://react.dev)
[![TypeScript Version](https://img.shields.io/badge/TypeScript-6.0.2-blue.svg?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![Vite Version](https://img.shields.io/badge/Vite-8.0.12-646CFF.svg?style=flat-square&logo=vite)](https://vite.dev)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4.3.1-06B6D4.svg?style=flat-square&logo=tailwindcss)](https://tailwindcss.com)
[![License](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](#)

**LU-PAMPA** (también conocido como **LU-PAMPAR**) es un módem digital de audio y protocolo de comunicación acústica/radio basado en web. Permite la transmisión y recepción de datos, balizas de telemetría y transferencia de archivos binarios utilizando modulación de frecuencia por desplazamiento de audio (**AFSK - Audio Frequency-Shift Keying**) con control de errores mediante **Reed-Solomon (FEC)** y validación **CRC-16**.

La aplicación está diseñada para ejecutarse completamente en el navegador (lado del cliente) y se comunica a través de altavoces y micrófonos de forma acústica, o mediante transceptores de radio conectando el audio del dispositivo (cables de interfaz de radio). Es una herramienta ideal para demostraciones educativas de la capa física de comunicaciones, pruebas de radioafición y enlaces acústicos locales de datos.

---

## 🚀 Características Clave

*   **🔊 Capa Física Flexible (AFSK / CPFSK):**
    *   Soporte para múltiples velocidades de símbolos (**Baud Rates**): `300`, `600`, `1200`, `2400`, `4800` y `9600` Baudios.
    *   Mapeo dinámico de frecuencias de tonos para portadoras de señal (Mark/Space).
    *   Modulación de fase continua (**CPFSK**) con suavizado de transiciones (**fades de 5ms**) en los extremos para evitar clics transitorios de audio.
    *   Codificación NRZI opcional con inserción de bits redundantes (*bit-stuffing* al estilo AX.25) para garantizar sincronismo, o modo FSK directo binario de alta robustez.
*   **🛠️ Robustez del Protocolo (Control de Errores):**
    *   **Reed-Solomon FEC (Forward Error Correction):** Algoritmo de corrección de errores en el aire sobre un campo de Galois $\text{GF}(256)$ usando el polinomio generador de AES ($x^8 + x^4 + x^3 + x^2 + 1$). Aplica automáticamente un ~25% de redundancia dinámica (mínimo 6 bytes de paridad) capaz de reparar pérdidas de paquetes por ruido acústico o desvanecimientos.
    *   **CRC-16 CCITT:** Validación de integridad mediante polinomio `0x1021` (valor inicial `0xFFFF`) ejecutado sobre los datos deserializados.
*   **📂 Transmisión de Archivos en Ráfagas:**
    *   Fraccionamiento automático de archivos binarios en fragmentos (*chunks*) de 48 bytes.
    *   Codificación a ASCII mediante formato **Adobe Base85 (Ascii85)** para una transmisión limpia sin pérdida de bytes de control de audio.
    *   Estructuración de transmisión secuencial tipo YMODEM: Envío de paquete inicial de metadatos (`META:filename,size,totalChunks`), seguido por los fragmentos de datos, y cierre con repetición del paquete de metadatos.
    *   Configuración de retardo de ráfagas (*burst delay*) y retransmisiones redundantes por bloque.
*   **🎙️ Demodulación por Matched-Filters en Tiempo Real:**
    *   Monitoreo continuo de entrada de micrófono mediante procesador de audio web con tamaño de búfer ajustable y umbral de silenciamiento (*squelch*).
    *   Demodulador FSK por correlación deslizante de filtros adaptados (*matched-filters*) para máxima inmunidad al ruido.
    *   Algoritmo de **búsqueda de reloj multipase (8 fases)** que encuentra la fase óptima de muestreo de símbolos, evitando la fragilidad de un lazo de seguimiento de fase (PLL) ciego.
*   **📊 Interfaz Visual e Informes:**
    *   Espectrograma en cascada (**Waterfall**) y osciloscopio de forma de onda en tiempo real.
    *   Consola interactiva con logs detallados de la decodificación de tramas en tiempo real (métrica de errores RS corregidos, fallos CRC, etc.).
    *   **Generador de Reportes PDF (QSL Cards):** Permite descargar un reporte estilizado de transmisión y recepción al estilo de una tarjeta QSL de radioaficionado tradicional, detallando velocidad, redundancia, bytes transmitidos e integridad.

---

## 📐 Especificación de la Trama (Capa de Enlace)

El formato de una trama **LU-PAMPA V8** está optimizado para transmitir pequeños fragmentos de datos de forma compacta y robusta. A continuación se muestra la distribución de bytes previa a la aplicación de Reed-Solomon (pre-FEC) y posterior (Codeword final):

### Formato Pre-FEC (Bloque de Datos base de 26 bytes + longitud de payload)

| Campo | Tamaño (Bytes) | Descripción |
| :--- | :---: | :--- |
| **SYNC** | 1 | Byte de alineación e inicio de trama (siempre `0x7E`). |
| **ORIGEN_LICENCIA** | 7 | Licencia (Callsign) de origen. ASCII rellenado con espacios a la derecha (ej. `LU1AAA `). |
| **ORIGEN_NODO** | 2 | Identificador de nodo de origen en Big-Endian (0-65535). |
| **DESTINO_LICENCIA** | 7 | Licencia (Callsign) de destino. ASCII rellenado con espacios a la derecha (ej. `LU2BBB `). |
| **DESTINO_NODO** | 2 | Identificador de nodo de destino en Big-Endian (0-65535). |
| **ARCHIVO_ID** | 1 | ID único para la transferencia de archivos activa (0-255). |
| **SECUENCIA_ID** | 2 | Número de secuencia del fragmento en Big-Endian (0-65535). La secuencia `0` es reservada para metadatos. |
| **TIPO** | 1 | Tipo de trama: `0x01` (TEXTO), `0x02` (FRAGMENTO DE ARCHIVO), `0x03` (TOKEN), `0x04` (ACK), `0x05` (BALIZA). |
| **LONGITUD** | 1 | Longitud en bytes del campo Payload ($L \le 255$). |
| **PAYLOAD** | $L$ | Datos de la trama ($L$ bytes). |
| **CRC16** | 2 | CRC-16 CCITT calculado sobre todos los bytes anteriores (desde SYNC hasta el final de PAYLOAD). |

### Formato Final (Codeword con FEC)

Tras calcular el tamaño pre-FEC ($K = 26 + L$), se calcula el número de símbolos de paridad de Reed-Solomon ($N_{sym} = \max(6, \lceil K \times 0.25 \rceil)$). El total de bytes a transmitir por el aire es:

$$\text{Codeword Total} = K + N_{sym}$$

Donde los últimos $N_{sym}$ bytes corresponden a la paridad Reed-Solomon calculada sobre el bloque pre-FEC de $K$ bytes en $\text{GF}(256)$.

---

## 🛠️ Estructura del Código

La lógica de la aplicación se encuentra desacoplada en módulos de TypeScript dentro de `src/`:

```
p:/PAMPA/
├── src/
│   ├── App.tsx                 # Interfaz de usuario (React), estado del módem y bucle de audio
│   ├── App.css                 # Estilos principales de la aplicación (Tailwind v4)
│   ├── utils/
│   │   ├── protocol.ts         # Serialización de tramas, CRC-16, codificación Base85
│   │   ├── reedsolomon.ts      # Aritmética de Galois Field 256 y decodificador Berlekamp-Massey
│   │   ├── modulator.ts        # Modulador CPFSK, empaquetado de archivos WAV y MP3 (lamejs)
│   │   ├── demodulator.ts      # Demodulación por filtros acoplados y alineación de reloj de bits
│   │   ├── pdf.ts              # Generación de reportes PDF QSL con jsPDF
│   │   └── lame.min.js         # Codificador LAME MP3 compilado para JS
```

---

## ⚙️ Frecuencias de Audio por Velocidad (Capa Física)

Para evitar colisiones armónicas y adaptarse a las limitaciones de banda de transceptores comunes de HF/VHF, las frecuencias de los tonos varían de acuerdo al Baud Rate seleccionado:

| Baud Rate (Baudios) | Tono de Marca (Mark - Hz) | Tono de Espacio (Space - Hz) | Desviación | Notas |
| :---: | :---: | :---: | :---: | :--- |
| **300** | 1200 | 2200 | 1000 Hz | Compatible con modems acústicos tradicionales. |
| **600** | 1200 | 2200 | 1000 Hz | Transición suave. |
| **1200** | 1200 | 2200 | 1000 Hz | Estándar Bell 202/AX.25 VHF Packet Radio. |
| **2400** | 2400 | 4800 | 2400 Hz | Para canales acústicos limpios o enlaces de radio anchos. |
| **4800** | 3000 | 6000 | 3000 Hz | Requiere alto ancho de banda. |
| **9600** | 4800 | 9600 | 4800 Hz | FSK directa de alta velocidad. |

---

## 💻 Configuración de Desarrollo Local

### Requisitos Previos
*   [Node.js](https://nodejs.org) v22 o superior.
*   Administrador de paquetes `pnpm` (recomendado) o `npm`.

### Instalación de dependencias:
```bash
# Habilitar corepack e instalar con pnpm
corepack enable
pnpm install
```

### Ejecutar en modo desarrollo:
```bash
pnpm run dev
```
La aplicación estará disponible localmente en `http://localhost:5173`.

### Compilación para producción:
```bash
pnpm run build
```
Esto generará los archivos estáticos listos para producción en el directorio `/dist`.

---

## 🐳 Ejecución con Docker

El proyecto incluye soporte listo para Docker y Nginx para servir la aplicación de forma rápida y reproducible en producción o entornos locales aislados.

### Opción 1: Docker Compose (Recomendada)
Para iniciar la aplicación en el puerto `8080`:
```bash
docker-compose up -d
```
Accede a la app mediante `http://localhost:8080`. Para detener el servicio:
```bash
docker-compose down
```

### Opción 2: Docker CLI Directo
1.  **Construir la imagen:**
    ```bash
    docker build -t lu-pampa-app .
    ```
2.  **Ejecutar el contenedor:**
    ```bash
    docker run -d -p 8080:3000 --name pampa-app lu-pampa-app
    ```

---

## 📖 Guía de Uso del Módem

> [!NOTE]
> Para probar la transmisión y recepción en la misma computadora, abre la aplicación en dos pestañas diferentes del navegador. Una pestaña actuará como transmisor (TX) y la otra como receptor (RX). Asegúrate de autorizar el uso del micrófono en la pestaña receptora.

### Paso 1: Configuración de Nodos
1.  Establece la **Licencia de Origen** (Callsign, ej. `LU1AAA`) y el **Nodo** (ej. `1`).
2.  Configura la **Licencia de Destino** (ej. `LU2BBB`) y su correspondiente **Nodo**.
3.  Selecciona la velocidad de símbolo (**Baud Rate**) deseada. El emisor y el receptor deben tener configurada **la misma velocidad** para poder comunicarse.

### Paso 2: Configurar la Entrada de Audio (Receptor)
1.  En la pestaña o dispositivo del receptor, haz clic en **"Iniciar Micrófono"**.
2.  Verifica que el espectrograma cascada (**Waterfall**) comience a pintar el ruido ambiente en azul/verde.
3.  Ajusta el valor de **Squelch** (umbral de silenciamiento). Si el ruido ambiente es muy fuerte, sube el valor ligeramente para evitar falsas detecciones de preámbulo.

### Paso 3: Transmitir Mensajes o Archivos
*   **Transmitir Texto Simple:** Escribe en la sección de texto rápido y haz clic en **"Generar Audio"** y luego en **"Reproducir"**, o envía la baliza periódica (**Baliza** / *Beacon*).
*   **Transmitir Archivos:**
    1.  Carga un archivo pequeño (menor a 5-10 KB para mejores resultados en acústico) en el selector de archivos.
    2.  Configura las **Repeticiones Redundantes** (se recomienda `2x` o `3x` en entornos ruidosos) y el **Burst Delay** (tiempo de silencio entre paquetes, ej. `600ms`).
    3.  Haz clic en **"Transmitir Archivo Completo"**. La aplicación modulará y reproducirá secuencialmente todos los paquetes de ráfaga.
    4.  *(Opcional)* Puedes descargar la ráfaga completa de audio de la transferencia del archivo en formato `.wav` o `.mp3` para reproducirla de forma diferida.

### Paso 4: Recepción y Reensamblado
1.  A medida que el receptor detecta la señal acústica, verás los logs del decodificador detallando:
    *   *Preamble detected* (cuando detecta los bytes SYNC repetidos).
    *   Logs del estado de la corrección Reed-Solomon (*Corrected X errors*).
    *   Validación CRC-16 exitosa.
2.  Si estás recibiendo una transferencia de archivos, se listará el progreso de los fragmentos recibidos en el panel de **Archivos Recibidos**.
3.  Cuando todos los fragmentos se hayan recibido correctamente, el panel mostrará el estado completado y te permitirá **descargar el archivo reconstruido** en su formato binario original.
4.  Haz clic en cualquier paquete individual decodificado en la lista para ver su cabecera completa, exportar su audio en `.mp3` o generar su **Ficha/QSL en formato PDF**.

---

## 🛠️ Tecnologías Empleadas

*   **Vite + React 19 + TypeScript 6** — Framework, motor de UI e instrumentación tipada.
*   **Tailwind CSS v4** — Framework de estilos y utilidades CSS en modo oscuro por defecto.
*   **Web Audio API** — Generación de osciladores sintéticos para CPFSK y captura del micrófono para procesamiento pormatched-filter en tiempo real.
*   **jsPDF** — Biblioteca de generación estricta de documentos PDF del lado del cliente.
*   **LameJS** — Compilación nativa de LAME en JavaScript para compresión MP3 en caliente de las tramas capturadas y transmitidas.
*   **Lucide React** — Pack de iconos vectoriales modernos y estilizados.

---

*Desarrollado con pasión para la comunidad de radioafición y entusiastas del procesamiento digital de señales.* 📶📡
