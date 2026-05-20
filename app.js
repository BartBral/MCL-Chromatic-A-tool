// ============================================================
// MD TRANSFER — Main Application Script
// Say A! — MegaCommand Chromatic tool for MD
// ============================================================

// ============================================================
// SECTION 1: CONSTANTS & CONFIGURATION
// ============================================================
const MD_CONFIG = {
  MK1: { slots: 32, maxMemory: 2 * 1024 * 1024 },         // 2.0 MB
  MK2: { slots: 48, maxMemory: 2.5 * 1024 * 1024 },       // 2.5 MB
};

// SDS slot offset — change here if needed for hardware quirks
const SDS_SLOT_OFFSET = 0;

// Elektron SysEx name prefix: F0 00 20 3C 02 00 73
const ELEKTRON_NAME_PREFIX = [0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00, 0x73];

// SDS SysEx constants
const SDS = {
  HEADER: 0xF0,
  MANU_ID: 0x7E,
  DUMP_HEADER: 0x01,
  DUMP_REQ: 0x03,
  DATA_PACKET: 0x02,
  ACK: 0x7F,
  NAK: 0x7E,
  CANCEL: 0x7D,
  WAIT: 0x7C,
  EOX: 0xF7,
  DEVICE_ID: 0x00,
  PACKET_DELAY_MS: 60,
  BYTES_PER_PACKET: 120,  // 40 3-byte samples
};

// NOTE NAMES
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MIDI_NOTE_A = [9, 21, 33, 45, 57, 69, 81, 93]; // A0–A7

// ============================================================
// SECTION 2: APPLICATION STATE
// ============================================================
const state = {
  hwVersion: 'mk1',
  sourceFiles: [],       // { id, name, rawBuffer, processedBuffer, hqBuffer, rootNote, loopStart, loopEnd, hasLoop, status, syxData, size }
  slots: [],             // Array of { sampleId | null }
  selectedSourceIds: new Set(),
  selectedSlotIndices: new Set(),
  midiAccess: null,
  midiOutput: null,
  isSending: false,
  playingItemId: null,  // id of item currently playing inline
  abortSend: false,
  abortProcess: false,
  pendingRootNoteResolve: null,
  playerItem: null,
  playerAudioCtx: null,
  playerNode: null,
  playerLoopStart: 0,
  playerLoopEnd: 0,
  playerIsLooping: false,
};

let nextId = 1;

// ============================================================
// SECTION 3: DOM REFS
// ============================================================
const $ = id => document.getElementById(id);
const dom = {
  memGaugeFill: $('memGaugeFill'),
  memNumbers: $('memNumbers'),
  midiDot: $('midiDot'),
  midiLabel: $('midiLabel'),
  sourceDropZone: $('sourceDropZone'),
  sourceDropOverlay: $('sourceDropOverlay'),
  fileInput: $('fileInput'),
  sourceList: $('sourceList'),
  slotGrid: $('slotGrid'),
  batchBanner: $('batchBanner'),
  batchMsg: $('batchMsg'),
  btnSelectAll: $('btnSelectAll'),
  btnClearSource: $('btnClearSource'),
  btnClearQueue: $('btnClearQueue'),
  btnGo: $('btnGo'),
  btnProcessSelected: $('btnProcessSelected'),
  btnDownloadProcessed: $('btnDownloadProcessed'),
  btnDownloadHQ: $('btnDownloadHQ'),
  btnDownloadSyx: $('btnDownloadSyx'),
  btnAddToQueue: $('btnAddToQueue'),
  btnReprocess: $('btnReprocess'),
  btnSendAll: $('btnSendAll'),
  btnSendSelected: $('btnSendSelected'),
  btnAbortSend: $('btnAbortSend'),
  sendProgressBar: $('sendProgressBar'),
  sendProgressFill: $('sendProgressFill'),
  turboIndicator: $('turboIndicator'),
  statusText: $('statusText'),
  globalSpinner: $('globalSpinner'),
  targetOctave: $('targetOctave'),
  targetSampleRate: $('targetSampleRate'),
  customSampleRate: $('customSampleRate'),
  monoMode: $('monoMode'),
  sincTaps: $('sincTaps'),
  loopSnapWindow: $('loopSnapWindow'),
  loopXfade: $('loopXfade'),
  xfadeCurve: $('xfadeCurve'),
  cropAfterLoop: $('cropAfterLoop'),
  midiPortSelect: $('midiPortSelect'),
  turboSpeed: $('turboSpeed'),
  sdsHandshake: $('sdsHandshake'),
  // player
  playerModal: $('playerModal'),
  playerFileName: $('playerFileName'),
  waveform: $('waveform'),
  loopEnabled: $('loopEnabled'),
  loopStart: $('loopStart'),
  loopEnd: $('loopEnd'),
  playerSampleRate: $('playerSampleRate'),
  btnPlay: $('btnPlay'),
  btnPlayLoop: $('btnPlayLoop'),
  btnStop: $('btnStop'),
  btnApplyLoop: $('btnApplyLoop'),
  btnClosePlayer: $('btnClosePlayer'),
  // root note
  rootNoteModal: $('rootNoteModal'),
  rootNoteModalMsg: $('rootNoteModalMsg'),
  btnRootCancel: $('btnRootCancel'),
  btnRootConfirm: $('btnRootConfirm'),
  btnOpenSettings: $('btnOpenSettings'),
  settingsModal: $('settingsModal'),
  // batch confirm
  batchConfirmModal: $('batchConfirmModal'),
  batchConfirmMsg: $('batchConfirmMsg'),
  btnBatchCancel: $('btnBatchCancel'),
  btnBatchProceed: $('btnBatchProceed'),
};

// ============================================================
// SECTION 4: HARDWARE VERSION / MEMORY GAUGE
// ============================================================
function getHWConfig() {
  return MD_CONFIG[state.hwVersion === 'mk1' ? 'MK1' : 'MK2'];
}

function initSlots() {
  const cfg = getHWConfig();
  state.slots = Array(cfg.slots).fill(null);
  renderSlotGrid();
  updateMemGauge();
}

function updateMemGauge() {
  const cfg = getHWConfig();
  let used = 0;
  state.slots.forEach(sid => {
    if (sid) {
      const item = state.sourceFiles.find(f => f.id === sid);
      if (item && item.processedBuffer) used += item.processedBuffer.byteLength;
    }
  });
  const pct = Math.min(100, (used / cfg.maxMemory) * 100);
  dom.memGaugeFill.style.width = pct + '%';
  dom.memGaugeFill.className = 'gauge-fill' + (pct >= 100 ? ' over' : pct > 85 ? ' warn' : '');
  dom.memNumbers.textContent = `${fmtBytes(used)} / ${fmtBytes(cfg.maxMemory)}`;
}

document.querySelectorAll('input[name=hwver]').forEach(r => {
  r.addEventListener('change', () => {
    state.hwVersion = r.value;
    initSlots();
    setStatus(`Hardware: ${r.value.toUpperCase()} (${getHWConfig().slots} slots, ${fmtBytes(getHWConfig().maxMemory)})`);
  });
});

// ============================================================
// SECTION 5: WAV PARSER (binary chunk reader)
// ============================================================
function parseWAV(buffer) {
  const view = new DataView(buffer);
  const result = {
    channels: 0, sampleRate: 0, bitsPerSample: 0, numSamples: 0,
    audioData: null,
    loopStart: null, loopEnd: null, hasLoop: false, loopType: 0,
    rootNote: null, rootNoteMidi: null,
    rootNoteSmpl: null, rootNoteInst: null,
    errors: [],
  };

  const readFourCC = offset => String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3)
  );

  if (readFourCC(0) !== 'RIFF' || readFourCC(8) !== 'WAVE') {
    result.errors.push('Not a valid WAV file');
    return result;
  }

  // Two-pass parse: read fmt first regardless of chunk order,
  // so numSamples and loop rescaling are always based on correct channel count.
  let offset = 12;
  while (offset < buffer.byteLength - 8) {
    const chunkId = readFourCC(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'fmt ') {
      result.channels = view.getUint16(offset + 10, true);
      result.sampleRate = view.getUint32(offset + 12, true);
      result.bitsPerSample = view.getUint16(offset + 22, true);
      result.audioFormat = view.getUint16(offset + 8, true);
    }
    offset += 8 + chunkSize + (chunkSize & 1);
  }

  // Second pass: read all other chunks (fmt already known)
  offset = 12;
  while (offset < buffer.byteLength - 8) {
    const chunkId = readFourCC(offset);
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'fmt ') {
      // already read above
    }
    else if (chunkId === 'data') {
      result.audioDataOffset = offset + 8;
      result.audioDataSize = chunkSize;
    }
    else if (chunkId === 'smpl') {
      // smpl chunk layout (offsets relative to chunk start):
      // +8 manufacturer, +12 product, +16 sample period, +20 unity note, +36 num loops
      const unityNote = view.getUint32(offset + 20, true);
      if (unityNote <= 127) result.rootNoteSmpl = unityNote;
      const numLoops = view.getUint32(offset + 36, true);
      if (numLoops > 0) {
        const loopOffset = offset + 44;
        result.loopType = view.getUint32(loopOffset + 4, true);
        result.loopStart = view.getUint32(loopOffset + 8, true);
        result.loopEnd = view.getUint32(loopOffset + 12, true);
        result.hasLoop = true;
      }
    }
    else if (chunkId === 'inst') {
      // inst chunk layout (offsets relative to chunk start):
      // +8 unshiftedNote (uint8, absolute MIDI note 0-127) — the root note directly
      // +9 fineTune (int8, cents), +10 gain (int8, dB), +11-14 note/vel range
      const instNote = view.getUint8(offset + 8);
      if (instNote <= 127) result.rootNoteInst = instNote;
    }

    offset += 8 + chunkSize + (chunkSize & 1); // word align
  }

  // Decode audio samples to float32
  if (result.audioDataOffset !== undefined) {
    const raw = new Uint8Array(buffer, result.audioDataOffset, result.audioDataSize);
    const bytesPerSample = result.bitsPerSample / 8;
    result.numSamples = Math.floor(result.audioDataSize / (bytesPerSample * result.channels));
    result.audioData = decodeToFloat32(raw, result.bitsPerSample, result.audioFormat, result.numSamples * result.channels);
  }

  return result;
}

function decodeToFloat32(raw, bits, format, count) {
  const out = new Float32Array(count);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i < count; i++) {
    const byteOff = i * (bits / 8);
    if (format === 3) { // float
      out[i] = bits === 64 ? dv.getFloat64(byteOff, true) : dv.getFloat32(byteOff, true);
    } else {
      if (bits === 8) out[i] = (dv.getUint8(byteOff) - 128) / 128.0;
      else if (bits === 16) out[i] = dv.getInt16(byteOff, true) / 32768.0;
      else if (bits === 24) {
        const b0 = dv.getUint8(byteOff), b1 = dv.getUint8(byteOff + 1), b2 = dv.getUint8(byteOff + 2);
        let val = b0 | (b1 << 8) | (b2 << 16);
        if (val & 0x800000) val |= 0xFF000000;
        out[i] = val / 8388608.0;
      } else if (bits === 32) {
        out[i] = dv.getInt32(byteOff, true) / 2147483648.0;
      }
    }
  }
  return out;
}

// ============================================================
// SECTION 6: DSP ENGINE
// ============================================================

// --- Mono Mixdown (before pitch shift) ---
function toMono(floatData, channels, monoMode) {
  if (channels === 1 || monoMode === 'stereo') return { data: floatData, channels };
  const frames = floatData.length / channels;
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const L = floatData[i * channels];
    const R = channels > 1 ? floatData[i * channels + 1] : L;
    switch (monoMode) {
      case 'left': mono[i] = L; break;
      case 'right': mono[i] = R; break;
      case 'mid': mono[i] = (L + R) * 0.5; break; // true mid (no side)
      default: mono[i] = (L + R) * 0.5; break;  // sum → normalize
    }
  }
  return { data: mono, channels: 1 };
}

// --- Windowed Sinc Interpolation Resampler ---
// Kaiser window, configurable taps (64/128/256)
function kaiserWindow(n, N, beta) {
  // Approximation of I0 (modified Bessel function)
  function i0(x) {
    let s = 1, t = 1;
    for (let k = 1; k <= 30; k++) {
      t *= (x / 2 / k) * (x / 2 / k);
      s += t;
      if (t < 1e-12) break;
    }
    return s;
  }
  const mid = (N - 1) / 2;
  const arg = 1 - Math.pow((n - mid) / mid, 2);
  return i0(beta * Math.sqrt(Math.max(0, arg))) / i0(beta);
}

// buildSincKernel removed: resampleWindowed now evaluates the kernel inline per output sample
// for correct fractional sinc interpolation.

function resampleWindowed(inputData, srcRate, dstRate, taps) {
  if (srcRate === dstRate) return inputData;
  const ratio = srcRate / dstRate;
  const outLen = Math.round(inputData.length * dstRate / srcRate);
  const half = Math.floor((taps - 1) / 2);
  // Correct cutoff: for upsample (ratio<1) limit to srcNyquist; for downsample (ratio>1) anti-alias
  const cutoff = ratio < 1.0 ? ratio : 1.0 / ratio;
  const out = new Float32Array(outLen);
  const PI = Math.PI;
  // Fractional windowed-sinc resampler.
  // For each output sample i at continuous source position srcPos = i*ratio:
  //   - srcBase = floor(srcPos) is the integer anchor in the source buffer
  //   - frac = srcPos - srcBase is the sub-sample offset (0..1)
  //   - the sinc kernel is evaluated at the TRUE fractional offset x = (k-half) - frac
  //   - per-sample normalisation divides by the kernel sum to guarantee unity DC gain
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const srcBase = Math.floor(srcPos);
    const frac = srcPos - srcBase;
    let s = 0, norm = 0;
    for (let k = 0; k < taps; k++) {
      const srcIdx = srcBase - half + k;
      const x = (k - half) - frac;
      const sincVal = Math.abs(x) < 1e-10 ? 1.0 : Math.sin(PI * cutoff * x) / (PI * x);
      const winVal = kaiserWindow(k, taps, 8.5);
      const w = sincVal * winVal;
      norm += w;
      if (srcIdx >= 0 && srcIdx < inputData.length) {
        s += inputData[srcIdx] * w;
      }
    }
    out[i] = norm > 1e-10 ? s / norm : 0.0;
  }
  return out;
}

// pitchShift() removed — pitch shifting is now handled directly inside
// resampleWindowed() by passing effectiveSrcRate = srcRate * pitchRatio.
// This gives one high-quality sinc pass instead of linear-interp + sinc.

// --- Recalculate loop points after resampling ---
function rescaleLoopPoints(loopStart, loopEnd, srcLen, dstLen) {
  const ratio = dstLen / srcLen;
  return {
    start: Math.round(loopStart * ratio),
    end: Math.min(dstLen - 1, Math.round(loopEnd * ratio)),
  };
}

// --- Find best loop start: sample in output whose value AND slope
//     most closely match the source loop start value and slope.
//     'targetVal'   = value at source loopStart (float32)
//     'targetSlope' = sign of slope at source loopStart (+1 ascending, -1 descending, 0 flat)
//     'window'      = ±samples to search
function findBestLoopStart(data, scaledPos, targetVal, targetSlope, window) {
  const len = data.length;
  const center = Math.max(1, Math.min(len - 2, scaledPos));
  if (window <= 0) return center;
  let bestIdx = center;
  let bestScore = Infinity;
  for (let i = Math.max(1, center - window); i <= Math.min(len - 2, center + window); i++) {
    const slope = Math.sign(data[i] - data[i - 1]);
    const valDiff = Math.abs(data[i] - targetVal);
    // Slope mismatch penalty: 2× the full value range (0..2 for floats in -1..1)
    const slopePenalty = (slope !== targetSlope) ? 2.0 : 0.0;
    const score = valDiff + slopePenalty;
    if (score < bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

// --- Find best loop end: sample in output whose value AND slope
//     most closely match those at loopStart — so the jump
//     loopEnd → loopStart is as seamless as possible.
function findBestLoopEnd(data, scaledPos, matchVal, matchSlope, window) {
  // Identical algorithm — just matching a different target
  return findBestLoopStart(data, scaledPos, matchVal, matchSlope, window);
}

// --- Loop crossfade ---
// Blends the tail of the loop into the head using equal-power crossfade.
// XF samples from just after loopStart are blended with XF samples just before loopEnd+1.
// The crossfade is written IN PLACE into the data array.
// After this, the loop plays seamlessly at loopEnd→loopStart with no discontinuity.
//
// Topology (standard forward-loop crossfade):
//   The region [loopEnd+1-xf .. loopEnd] in the output gets a mix of:
//     - itself (fade out: 1→0)
//     - samples [loopStart .. loopStart+xf-1] (fade in: 0→1)
//   So the tail of the loop absorbs the beginning of the loop, blended.
//   loopStart itself is unchanged — the loop jumps back there cleanly.
function applyLoopCrossfade(data, loopStart, loopEnd, xfLen, curve = 'linear') {
  if (xfLen <= 0) return;
  // Clamp xfLen so it fits within the loop and the pre-loop material
  const maxXf = Math.min(xfLen, loopStart, loopEnd - loopStart);
  if (maxXf <= 0) return;

  // The crossfade region is the last maxXf samples of the loop:
  //   tailIdx runs from (loopEnd - maxXf + 1) up to loopEnd
  //
  // Each tail sample is blended with a head sample, but headIdx runs BACKWARDS:
  //   headIdx = loopStart + (maxXf - 1 - i)
  //
  // This ensures that at i = maxXf-1 (= loopEnd), headIdx = loopStart.
  // So data[loopEnd] ends up ≈ data[loopStart] → the jump is seamless.
  //
  // t uses (i+1)/maxXf so the last sample reaches exactly gainHead=1.0.
  //
  // Equal-power:
  //   gainTail = cos(t·π/2)  goes 1→0 as t goes 0→1
  //   gainHead = sin(t·π/2)  goes 0→1 as t goes 0→1

  // Use pre-roll material (the XF samples immediately BEFORE loopStart).
  // This audio is never played in the loop itself, so mixing it into the tail
  // causes zero phase cancellation with the loop content.
  // At loopEnd, the tail has fully transitioned to sound like the audio just
  // before loopStart — so the jump back to loopStart is seamless.
  for (let i = 0; i < maxXf; i++) {
    const t = (i + 1) / maxXf;  // 0→1 approaching loopEnd
    // gainPre: how much pre-roll to blend in (0→1)
    // gainTail: how much original tail to keep  (1→0)
    let gainPre;
    switch (curve) {
      case 'logarithmic':
        // Fades in quickly at first, then slows — natural-feeling for many sounds
        gainPre = Math.log(1 + t * (Math.E - 1));       // log base e, normalised 0→1
        break;
      case 'equal_power':
        gainPre = Math.sin(t * Math.PI * 0.5);           // sin curve, equal power with cos
        break;
      case 'sine':
        // Full S-curve: slow start, fast middle, slow end
        gainPre = 0.5 - 0.5 * Math.cos(t * Math.PI);
        break;
      case 'exponential':
        // Stays near 0 for a long time then rises sharply at the end
        gainPre = Math.pow(t, 3);
        break;
      case 'square_root':
        // Fades in very quickly, then flattens — opposite of exponential
        gainPre = Math.sqrt(t);
        break;
      case 'linear':
      default:
        gainPre = t;  // straight line 0→1
        break;
    }
    const gainTail = 1 - gainPre;  // always the complement

    // tail: last maxXf samples of the loop
    const tailIdx = loopEnd - maxXf + 1 + i;
    // pre-roll: maxXf samples before loopStart (never played during loop)
    // aligned so preIdx = loopStart-1 when i = maxXf-1 (at loopEnd)
    const preIdx = loopStart - maxXf + i;

    if (tailIdx < 0 || tailIdx >= data.length) continue;
    if (preIdx < 0 || preIdx >= data.length) continue;

    data[tailIdx] = data[tailIdx] * gainTail + data[preIdx] * gainPre;
  }
}

// --- Crop audio after loop end ---
// Returns a new Float32Array containing only samples 0..loopEnd (inclusive).
function cropAfterLoop(data, loopEnd) {
  return data.slice(0, loopEnd + 1);
}

// --- Dither & convert to 16-bit PCM ---
function floatTo16BitPCM(floatData) {
  const out = new Int16Array(floatData.length);
  // TPDF dither
  for (let i = 0; i < floatData.length; i++) {
    const dither = (Math.random() - Math.random()) / 32768;
    const clamped = Math.max(-1, Math.min(1, floatData[i] + dither));
    out[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
  }
  return out;
}

// floatTo24BitPCM removed — HQ output is 32-bit float (no intermediate conversion needed)

// ============================================================
// SECTION 7: WAV BUILDER
// ============================================================
function buildWAV(pcmData, sampleRate, channels, bitsPerSample, loopStart, loopEnd, hasLoop, rootNoteMidi) {
  // pcmData: Int16Array (16-bit), Uint8Array (24-bit packed bytes), or Float32Array (32-bit)
  const is16 = pcmData instanceof Int16Array;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = pcmData.length * bytesPerSample;
  const numSamples = dataSize / bytesPerSample / channels;
  const unityNote = (rootNoteMidi !== null && rootNoteMidi !== undefined) ? rootNoteMidi : 69;
  const periodNs = Math.round(1e9 / sampleRate);

  // Always write smpl chunk (carries unity note + optional loop).
  // smpl payload: 9 × uint32 header fields + (1 loop struct of 6 × uint32 if hasLoop)
  const smplPayload = hasLoop ? 36 + 24 : 36; // 36 = 9 fields × 4 bytes, 24 = 6 loop fields × 4
  // Always write inst chunk (7 bytes payload, word-padded to 8)
  const instPayload = 7; // unshiftedNote(1) fineTune(1) gain(1) lowNote(1) highNote(1) lowVel(1) highVel(1)
  const instPadded = instPayload + (instPayload & 1); // pad to even = 8 bytes

  // Total: RIFF(4)+size(4)+WAVE(4) + fmt(8+16) + smpl(8+smplPayload) + inst(8+instPadded) + data(8+dataSize)
  const totalSize = 4 + (8 + 16) + (8 + smplPayload) + (8 + instPadded) + (8 + dataSize);
  const buf = new ArrayBuffer(8 + totalSize);
  const view = new DataView(buf);
  let off = 0;

  const writeStr = s => { for (const c of s) view.setUint8(off++, c.charCodeAt(0)); };
  const writeU32 = v => { view.setUint32(off, v >>> 0, true); off += 4; };
  const writeU16 = v => { view.setUint16(off, v & 0xFFFF, true); off += 2; };
  const writeU8 = v => { view.setUint8(off++, v & 0xFF); };
  const writeI8 = v => { view.setInt8(off++, v); };

  // RIFF header
  writeStr('RIFF');
  writeU32(totalSize);
  writeStr('WAVE');

  // fmt chunk
  writeStr('fmt ');
  writeU32(16);
  const isFloat = pcmData instanceof Float32Array;
  writeU16(isFloat ? 3 : 1); // 1=PCM, 3=IEEE float
  writeU16(channels);
  writeU32(sampleRate);
  writeU32(sampleRate * channels * bytesPerSample); // byte rate
  writeU16(channels * bytesPerSample);              // block align
  writeU16(bitsPerSample);

  // smpl chunk — ALWAYS written so unity note is preserved in every output file.
  // The unity note is set to the TARGET A note (the audio has been pitched there).
  writeStr('smpl');
  writeU32(smplPayload);
  writeU32(0);          // manufacturer
  writeU32(0);          // product
  writeU32(periodNs);   // sample period (ns)
  writeU32(unityNote);  // unity note = target A MIDI note ← KEY FIX
  writeU32(0);          // pitch fraction
  writeU32(0);          // SMPTE format
  writeU32(0);          // SMPTE offset
  writeU32(hasLoop ? 1 : 0); // num sample loops
  writeU32(0);          // sampler data (extra bytes after loops)
  if (hasLoop) {
    writeU32(0);         // loop id
    writeU32(0);         // loop type: 0 = forward
    writeU32(loopStart);
    writeU32(loopEnd);
    writeU32(0);         // fraction
    writeU32(0);         // play count (0 = infinite)
  }

  // inst chunk — ALWAYS written so DAWs and samplers read the correct root note.
  // unshiftedNote is the absolute MIDI note at which the sample plays at unity pitch.
  writeStr('inst');
  writeU32(instPadded); // chunk size (padded)
  writeU8(unityNote);   // unshiftedNote = target A MIDI note ← KEY FIX
  writeI8(0);           // fineTune (cents, 0 = no detune)
  writeI8(0);           // gain (dB, 0 = unity)
  writeU8(0);           // low note (0 = C-1, full range)
  writeU8(127);         // high note (127 = G9, full range)
  writeU8(0);           // low velocity
  writeU8(127);         // high velocity
  writeU8(0);           // padding byte (to reach even chunk size of 8)

  // data chunk
  writeStr('data');
  writeU32(dataSize);
  if (is16) {
    // 16-bit PCM: Int16Array, 2-byte aligned (off is always even here)
    new Int16Array(buf, off, pcmData.length).set(pcmData);
  } else {
    // 32-bit float: Float32Array, 4-byte aligned (off is always 4-byte aligned here)
    new Float32Array(buf, off, pcmData.length).set(pcmData);
  }

  return buf;
}

// ============================================================
// SECTION 7b: SDS FILE PARSER (for drag-drop import)
// ============================================================
// Validates and decodes a .syx/.sds file containing MMA SDS dump.
// Returns { ok, error, sampleRate, numSamples, hasLoop, loopStart, loopEnd,
//           pcm16, name, slot } or { ok:false, error }
function parseSysexFile(buffer) {
  const bytes = new Uint8Array(buffer);
  const result = {
    ok: false, error: null,
    sampleRate: 44100, numSamples: 0,
    hasLoop: false, loopStart: 0, loopEnd: 0,
    pcm16: null, name: null, slot: null,
    bitsPerWord: 16,
  };

  // Helper: decode 3-byte 7-bit SDS value (LSB first)
  const dec3 = (b, off) => b[off] | (b[off + 1] << 7) | (b[off + 2] << 14);

  let i = 0;
  let foundHeader = false;
  const dataPackets = [];

  while (i < bytes.length) {
    // Find next F0
    if (bytes[i] !== 0xF0) { i++; continue; }

    // Need at least 3 bytes to identify message type
    if (i + 2 >= bytes.length) break;

    // Find matching F7
    let end = i + 1;
    while (end < bytes.length && bytes[end] !== 0xF7) end++;
    if (end >= bytes.length) break;

    const msg = bytes.slice(i, end + 1);

    // Elektron name SysEx: F0 00 20 3C 02 00 73 <slot> <4chars> F7
    if (msg.length === 13 &&
      msg[1] === 0x00 && msg[2] === 0x20 && msg[3] === 0x3C &&
      msg[4] === 0x02 && msg[5] === 0x00 && msg[6] === 0x73) {
      result.slot = msg[7];
      result.name = String.fromCharCode(msg[8], msg[9], msg[10], msg[11]).trimEnd();
    }

    // SDS Dump Header: F0 7E <dev> 01 <sn_lo> <sn_hi> <bits> <period×3> <len×3> <ls×3> <le×3> <type> F7
    else if (msg.length === 21 && msg[1] === 0x7E && msg[3] === 0x01) {
      result.slot = result.slot !== null ? result.slot : (msg[4] | (msg[5] << 7));
      result.bitsPerWord = msg[6];
      const periodNs = dec3(msg, 7);
      const rawRate = periodNs > 0 ? Math.round(1e9 / periodNs + 1) : 44100;
      // The period field is an integer number of nanoseconds, so 1e9/period is
      // rarely exact. Snap to the nearest standard rate within 0.5% to absorb
      // rounding errors (e.g. period=22676 gives 44099.8, snaps to 44100).
      const STANDARD_RATES = [8000, 11025, 22050, 32000, 44100, 48000];
      const snapped = STANDARD_RATES.reduce((best, r) =>
        Math.abs(r - rawRate) < Math.abs(best - rawRate) ? r : best, rawRate);
      result.sampleRate = (Math.abs(snapped - rawRate) / rawRate < 0.005) ? snapped : rawRate;
      result.numSamples = dec3(msg, 10);
      const lsRaw = dec3(msg, 13);
      const leRaw = dec3(msg, 16);
      const loopType = msg[19];
      result.hasLoop = loopType !== 0x7F && leRaw !== 0x1FFFFF;
      result.loopStart = lsRaw;
      result.loopEnd = leRaw;
      foundHeader = true;
    }

    // SDS Data Packet: F0 7E <dev> 02 <pktNum> <120 bytes> <chk> F7 (127 bytes total)
    else if (msg.length === 127 && msg[1] === 0x7E && msg[3] === 0x02) {
      // Verify checksum per MMA SDS spec: XOR of bytes at indices 1..124 inclusive
      // (the 4 header bytes after F0, plus all 120 payload bytes), result masked to 7 bits.
      let chk = 0;
      for (let k = 1; k < 125; k++) chk ^= msg[k];
      chk &= 0x7F;
      // Accept packets even if checksum fails: Elektron-produced files use a
      // non-standard checksum. The Python reference (len/sds2wav) skips
      // checksum verification entirely. Track warnings but do not abort.
      if (chk !== msg[125]) result.checksumWarnings = (result.checksumWarnings || 0) + 1;
      dataPackets.push({ pktNum: msg[4], data: msg.slice(5, 125) });
    }

    i = end + 1;
  }

  if (!foundHeader) {
    result.error = 'No SDS Dump Header found — not a valid SDS file';
    return result;
  }
  if (dataPackets.length === 0) {
    result.error = 'No SDS data packets found';
    return result;
  }

  // Sort packets by pktNum (wraps at 0x7F)
  dataPackets.sort((a, b) => a.pktNum - b.pktNum);

  // Decode 3×7-bit → signed 16-bit (offset binary: s = u16 - 32768).
  //
  // The low 2 bits of each sample occupy one of two positions in the third byte,
  // depending on which software produced the file:
  //   • Bits 1–0  (& 0x03):         app-exported files
  //   • Bits 6–5  ((>> 5) & 0x03):  MD hardware dumps, C6, Elektron sample packs
  //
  // Auto-detect by scanning the first packet: if any third byte has bits set
  // above position 1 (byte & 0xFC non-zero), the file uses the shifted convention.
  let useShiftedLSB = false;
  if (dataPackets.length > 0) {
    const probe = dataPackets[0].data;
    for (let k = 2; k < 120; k += 3) {
      if (probe[k] & 0xFC) { useShiftedLSB = true; break; }
    }
  }

  const totalSamples = result.numSamples || dataPackets.length * 40;
  const pcm16 = new Int16Array(totalSamples);
  let sampleIdx = 0;
  for (const pkt of dataPackets) {
    const d = pkt.data;
    for (let k = 0; k < 120 && sampleIdx < totalSamples; k += 3) {
      const lsb = useShiftedLSB ? (d[k + 2] >> 5) & 0x03 : d[k + 2] & 0x03;
      const u = (d[k] << 9) | (d[k + 1] << 2) | lsb;
      pcm16[sampleIdx++] = u - 32768;  // offset binary → signed
    }
  }

  result.pcm16 = pcm16;
  result.ok = true;
  return result;
}

// ============================================================
// SECTION 8: SDS SYSEX BUILDER
// ============================================================
function buildSDS(slot, pcm16Data, sampleRate, channels, loopStart, loopEnd, hasLoop, name) {
  const packets = [];
  const totalSamples = pcm16Data.length;

  // --- Dump Header ---
  // F0 7E <dev> 01 <sn_lsb> <sn_msb> <bits_lsb> <bits_msb>
  // <period_lsb> ... (3 bytes) <length_lsb>...(3 bytes) <loop_start>(3) <loop_end>(3) <loop_type> F7
  const sn = (slot + SDS_SLOT_OFFSET) & 0x7FFF;
  const periodNs = Math.round(1e9 / sampleRate);
  const loopSt = hasLoop ? loopStart : 0xFFFFFF;
  const loopEn = hasLoop ? loopEnd : 0xFFFFFF;

  const encode3byte = v => [(v & 0x7F), ((v >> 7) & 0x7F), ((v >> 14) & 0x7F)];

  const header = [
    SDS.HEADER, SDS.MANU_ID, SDS.DEVICE_ID, SDS.DUMP_HEADER,
    sn & 0x7F, (sn >> 7) & 0x7F,
    16,   // bits per word — 1 byte only (NOT 2; the extra 0x00 is the classic SDS off-by-one)
    ...encode3byte(periodNs),
    ...encode3byte(totalSamples),
    ...encode3byte(loopSt),
    ...encode3byte(loopEn),
    hasLoop ? 0x00 : 0x7F, // loop type: 0=forward, 7F=no loop
    SDS.EOX
  ];
  packets.push({ type: 'header', data: new Uint8Array(header) });

  // --- Data Packets ---
  // Each packet: F0 7E <dev> 02 <pkt_num> <120 bytes 7-bit encoded> <checksum> F7
  // 120 bytes = 40 samples × 3 bytes (16-bit sample packed as 3×7-bit)
  const SAMPLES_PER_PACKET = 40;

  let pktNum = 0;
  for (let i = 0; i < totalSamples; i += SAMPLES_PER_PACKET) {
    const chunk = [];
    for (let j = 0; j < SAMPLES_PER_PACKET; j++) {
      const s = i + j < totalSamples ? pcm16Data[i + j] : 0;
      // SDS 16-bit → 3×7-bit packing (offset binary, tested working with MD hardware):
      //   u16 = (s + 32768) & 0xFFFF  — convert signed to unsigned offset binary
      //   b2 = (u16 >> 9) & 0x7F   bits 15..9  (MSB)
      //   b1 = (u16 >> 2) & 0x7F   bits  8..2  (mid)
      //   b0 =  u16        & 0x03   bits  1..0  (LSB, raw value 0..3)
      //   packet order: [b2, b1, b0]
      const u = (s + 32768) & 0xFFFF;
      chunk.push((u >> 9) & 0x7F);   // b2: bits 15..9
      chunk.push((u >> 2) & 0x7F);   // b1: bits  8..2
      chunk.push( u       & 0x03);   // b0: bits  1..0
    }
    // Checksum per MMA SDS spec and Python reference:
    // XOR of all bytes between F0 and F7 exclusive:
    // 0x7E ^ device_id ^ 0x02 ^ pktNum ^ all_120_payload_bytes
    let chk = 0x7E ^ SDS.DEVICE_ID ^ 0x02 ^ (pktNum & 0x7F);
    for (const b of chunk) chk ^= b;
    chk &= 0x7F;

    const pkt = new Uint8Array([
      SDS.HEADER, SDS.MANU_ID, SDS.DEVICE_ID, SDS.DATA_PACKET,
      pktNum & 0x7F,
      ...chunk,
      chk,
      SDS.EOX
    ]);
    packets.push({ type: 'data', pktNum: pktNum & 0x7F, data: pkt });
    pktNum = (pktNum + 1) & 0x7F;
  }

  return packets;
}

// --- Elektron Name SysEx ---
function buildNameSysEx(slot, name) {
  const truncated = (name.toUpperCase().replace(/[^A-Z0-9\-_]/g, '').substring(0, 4)).padEnd(4, ' ');
  const bytes = [];
  for (const c of truncated) bytes.push(c.charCodeAt(0));
  return new Uint8Array([
    ...ELEKTRON_NAME_PREFIX,
    (slot + SDS_SLOT_OFFSET) & 0x7F,
    ...bytes,
    SDS.EOX
  ]);
}

// Flatten all SDS packets for a slot into one Uint8Array (for .syx download).
// Name SysEx is placed first so the MD registers the name before the audio data arrives;
// both name and dump header always carry the same slot number, set by rebuildSDS().
function flattenSDS(packets, nameSysEx) {
  // Name first, then header+data — overwrites MD cached name before audio arrives
  const parts = [nameSysEx, ...packets.map(p => p.data)];
  const total = parts.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

// ============================================================
// SECTION 9: CORE PROCESSING PIPELINE
// ============================================================
async function processItem(item, settings) {
  item.status = 'processing';
  renderSourceItem(item);
  // Await setSpinner so the browser paints the overlay BEFORE the DSP work starts
  await setStatus(`Processing: ${item.name}…`, true);
  renderSourceItem(item);

  const wav = parseWAV(item.rawBuffer);
  if (wav.errors.length) {
    item.status = 'error';
    item.error = wav.errors.join(', ');
    renderSourceItem(item);
    setStatus(`Error: ${item.name} — ${item.error}`, false, 'err');
    return;
  }

  // Warn about unsupported loop types
  if (wav.hasLoop && wav.loopType !== 0) {
    const typeNames = { 1: 'ping-pong', 2: 'reverse' };
    const typeName = typeNames[wav.loopType] || `type ${wav.loopType}`;
    const proceed = await confirmDialog(
      'Loop Type Warning',
      `"${item.name}" has a ${typeName} loop. The Machinedrum only supports forward loops. Convert to forward loop and continue?`
    );
    if (!proceed || state.abortProcess) { item.status = 'idle'; renderSourceItem(item); return; }
  }

  // Step 1: Mono mixdown — must happen BEFORE root note detection
  // so monoData is available for the FFT pitch detector.
  let { data: monoData, channels: outChannels } = toMono(wav.audioData, wav.channels, settings.monoMode);
  if (settings.monoMode !== 'stereo') outChannels = 1;

  // Determine root note — read from smpl and inst chunks independently
  const smplNote = wav.rootNoteSmpl; // from smpl chunk unity note (or null)
  const instNote = wav.rootNoteInst; // from inst chunk unshiftedNote (or null)
  let rootMidi = null;

  if (smplNote !== null && instNote !== null && smplNote !== instNote) {
    rootMidi = await askRootNoteConflict(item.name, smplNote, instNote);
  } else if (smplNote !== null) {
    rootMidi = smplNote;
  } else if (instNote !== null) {
    rootMidi = instNote;
  } else {
    // Neither chunk — run FFT on monoData and ask user
    rootMidi = await askRootNote(item.name, monoData, wav.sampleRate);
  }

  if (rootMidi === null) { item.status = 'idle'; renderSourceItem(item); return; }

  // Check if user cancelled while the root note modal was open
  if (state.abortProcess) { item.status = 'idle'; renderSourceItem(item); return; }

  item.rootNote = rootMidi;

  // Reshow the processing overlay — it was hidden while the modal was open.
  // Yield two frames so the browser paints it before the heavy DSP starts.
  await setStatus(`Processing: ${item.name}…`, true);

  // Steps 2+3 combined: pitch shift + resample in ONE sinc pass.
  // Pitch shifting IS resampling at a different ratio. Doing it as a separate
  // linear-interpolation step first then sinc-resampling introduces aliasing
  // for large shifts. Instead we pass an "effective source rate" to the sinc:
  //
  //   effectiveSrcRate = srcRate * pitchRatio
  //
  // where pitchRatio = 2^(semitones/12). The sinc resamples from this effective
  // rate to dstRate in one pass — correct pitch AND correct rate, no aliasing.
  //
  // Examples:
  //   root=C4(60), target=A4(69), srcRate=44100, dstRate=44100:
  //     semitones=+9, pitchRatio=1.6818, effectiveSrc=74163
  //     outLen = round(N * 44100/74163) = round(N * 0.5946) → shorter → higher pitch ✓
  //   root=A4(69), target=A4(69), srcRate=22050, dstRate=44100:
  //     semitones=0, pitchRatio=1.0, effectiveSrc=22050
  //     outLen = round(N * 44100/22050) = N*2 → standard 2× upsample ✓

  const targetMidi = 69 + (parseInt(settings.targetOctave) - 4) * 12; // A4=69
  const semitones = targetMidi - rootMidi;
  const pitchRatio = Math.pow(2, semitones / 12);
  const taps = parseInt(settings.sincTaps);
  const dstRate = settings.targetSampleRate;
  const srcRate = wav.sampleRate;
  // Effective source rate encodes the pitch shift into the resample ratio
  const effectiveSrcRate = srcRate * pitchRatio;

  // MD-ready: pitch + resample in one sinc pass
  const resampledData = resampleWindowed(monoData, effectiveSrcRate, dstRate, taps);

  // HQ download: same combined pass to 2× dstRate
  const hqData = resampleWindowed(monoData, effectiveSrcRate, dstRate * 2, taps);

  // Step 4: Recalculate loop points
  // Loop points from smpl chunk are in original FRAME units (same as wav.numSamples).
  // The combined pitch+resample changes the frame count from wav.numSamples to
  // resampledData.length. We scale loop points by this same ratio.
  // Using resampledData.length / wav.numSamples captures BOTH the pitch shift
  // AND the rate conversion in one ratio — sample-accurate.
  let loopStart = 0, loopEnd = resampledData.length - 1, hasLoop = false;
  if (wav.hasLoop && wav.numSamples > 0) {
    // Clamp source loop points to valid range before scaling
    const srcLoopStart = Math.max(0, Math.min(wav.numSamples - 1, wav.loopStart));
    const srcLoopEnd = Math.max(0, Math.min(wav.numSamples - 1, wav.loopEnd));
    const scaled = rescaleLoopPoints(srcLoopStart, srcLoopEnd, wav.numSamples, resampledData.length);
    const snapWindow = settings.loopSnapWindow;
    if (snapWindow > 0) {
      // Step 1: find loopStart in output that best matches source loop start
      //   value and slope direction — preserves the character of the original loop point.
      // monoData is the mono float32 source BEFORE resampling, range -1..1.
      const srcStartVal = srcLoopStart < monoData.length
        ? monoData[srcLoopStart] : 0;
      const srcStartPrev = srcLoopStart > 0
        ? monoData[srcLoopStart - 1] : srcStartVal;
      const srcStartSlope = Math.sign(srcStartVal - srcStartPrev);

      loopStart = findBestLoopStart(
        resampledData, scaled.start, srcStartVal, srcStartSlope, snapWindow
      );

      // Step 2: find loopEnd in output whose value+slope makes the jump
      //   loopEnd → loopStart seamless.
      //
      //   The playback sequence at the boundary is:
      //     ... data[loopEnd-1], data[loopEnd], data[loopStart], data[loopStart+1] ...
      //
      //   We need TWO things to be continuous across the jump:
      //     1. VALUE:  data[loopEnd] ≈ data[loopStart]  (no amplitude step)
      //     2. SLOPE:  the direction arriving at loopEnd must match the direction
      //                leaving loopStart, i.e.:
      //                sign(data[loopEnd] - data[loopEnd-1])
      //                  === sign(data[loopStart+1] - data[loopStart])
      //                Because after the jump, data[loopStart+1] is the next sample.
      const lsVal = resampledData[loopStart];
      const lsOutSlope = (loopStart + 1 < resampledData.length)
        ? Math.sign(resampledData[loopStart + 1] - resampledData[loopStart])
        : 0;

      loopEnd = findBestLoopEnd(
        resampledData, scaled.end, lsVal, lsOutSlope, snapWindow
      );
      // The found index is where data[i] ≈ data[loopStart].
      // But loopEnd is the LAST sample played before the jump back.
      // The jump is: data[loopEnd] → data[loopStart].
      // We found where data[i] ≈ data[loopStart], so data[i] itself would
      // create a near-zero jump to data[loopStart] — but the preceding sample
      // data[i-1] transitions INTO data[i] which then jumps to data[loopStart].
      // Subtract 1: data[loopEnd-1] is now the last sample played, and
      // data[loopEnd] (the found match) is effectively skipped — the jump
      // data[loopEnd-1] → data[loopStart] uses the sample BEFORE the match,
      // which is approaching the target value from the correct direction.
      loopEnd = loopEnd - 1;
      // loopEnd must be after loopStart and before end of buffer
      loopEnd = Math.max(loopStart + 1, Math.min(resampledData.length - 2, loopEnd));
    } else {
      loopStart = scaled.start;
      loopEnd = scaled.end;
    }
    hasLoop = true;
  }
  if (item.overrideLoop) {
    loopStart = item.loopStart;
    loopEnd = item.loopEnd;
    hasLoop = item.hasLoop;
  }
  item.loopStart = loopStart;
  item.loopEnd = loopEnd;
  item.hasLoop = hasLoop;

  // Step 5: Loop crossfade and/or crop
  // Apply to BOTH the MD-ready buffer and the HQ buffer so they are consistent.
  function applyPostProcess(data, ls, le, doXfade, xfLen, curve, doCrop) {
    let d = doXfade && le > ls ? new Float32Array(data) : data;
    if (doXfade && le > ls) applyLoopCrossfade(d, ls, le, xfLen, curve);
    if (doCrop && le > ls) d = cropAfterLoop(d, le);
    return d;
  }

  let processedData = resampledData;
  let processedHqData = hqData;

  if (hasLoop) {
    const doXfade = settings.loopXfade > 0;
    const doCrop = settings.cropAfterLoop;
    const curve = settings.xfadeCurve;
    // MD-ready (at dstRate)
    processedData = applyPostProcess(
      resampledData, loopStart, loopEnd, doXfade, settings.loopXfade, curve, doCrop
    );
    // HQ (at dstRate*2) — loop points are at 2× coordinates
    processedHqData = applyPostProcess(
      hqData,
      Math.round(loopStart * 2), Math.round(loopEnd * 2),
      doXfade, settings.loopXfade * 2, curve, doCrop
    );
  }

  // Step 6: Dither to 16-bit
  const pcm16 = floatTo16BitPCM(processedData);

  // Build output buffers
  // Use targetMidi (the A-key we pitched TO) as the unity note in smpl/inst chunks —
  // NOT rootMidi (the original source root). The audio is now at targetMidi pitch.
  item.processedBuffer = buildWAV(pcm16, dstRate, outChannels, 16, loopStart, loopEnd, hasLoop, targetMidi);
  // HQ: 32-bit float WAV at 2× target rate — maximum quality for external use.
  // hqData is already a Float32Array from resampleWindowed. Pass directly.
  item.hqBuffer = buildWAV(processedHqData, dstRate * 2, outChannels, 32,
    Math.round(loopStart * 2),
    Math.round(loopEnd * 2),
    hasLoop, targetMidi);
  item.pcm16 = pcm16;
  item.processedSampleRate = dstRate;
  item.processedChannels = outChannels;
  item.size = item.processedBuffer.byteLength;
  item.targetMidi = targetMidi;  // the A-key we pitched to — shown in UI

  // Build SDS packets
  const slotIdx = state.slots.indexOf(item.id);
  const nameStr = item.name.replace(/\.wav$/i, '');
  item.sdsMeta = { slot: slotIdx >= 0 ? slotIdx : 0, name: nameStr, loopStart, loopEnd, hasLoop, rootMidi, dstRate, outChannels };
  item.sdsPackets = buildSDS(item.sdsMeta.slot, pcm16, dstRate, outChannels, loopStart, loopEnd, hasLoop, nameStr);
  item.nameSysEx = buildNameSysEx(item.sdsMeta.slot, nameStr);
  item.syxData = flattenSDS(item.sdsPackets, item.nameSysEx);

  item.status = 'done';
  renderSourceItem(item);
  updateMemGauge();
  setStatus(`Done: ${item.name} — ${fmtBytes(item.size)} @ ${fmtRate(dstRate)}, ${semitones >= 0 ? '+' : ''}${semitones} semi`);
}

async function processItems(items) {
  const settings = getSettings();
  state.abortProcess = false;
  setSpinner(true);
  for (const item of items) {
    if (state.abortProcess) {
      item.status = 'idle';
      setStatus('Processing cancelled', false, 'warn');
      break;
    }
    if (item.status === 'processing') continue;
    await processItem(item, settings);
    await sleep(4); // yield to UI
  }
  state.abortProcess = false;
  setSpinner(false);
  renderSourceList();
  updateMemGauge();
}

function getSettings() {
  let rate = parseInt(dom.targetSampleRate.value);
  if (dom.targetSampleRate.value === 'custom') rate = parseInt(dom.customSampleRate.value) || 44100;
  return {
    targetOctave: dom.targetOctave.value,
    targetSampleRate: rate,
    monoMode: dom.monoMode.value,
    sincTaps: dom.sincTaps.value,
    loopSnapWindow: parseInt(dom.loopSnapWindow.value) || 0,
    loopXfade: parseInt(dom.loopXfade.value) || 0,
    xfadeCurve: dom.xfadeCurve.value,
    cropAfterLoop: dom.cropAfterLoop.checked,
  };
}

// ============================================================
// SECTION 10: FILE LOADING
// ============================================================
async function handleFiles(files) {
  const wavFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.wav'));
  if (!wavFiles.length) { setStatus('No WAV files found', false, 'warn'); return; }

  const newItems = [];
  for (const file of wavFiles) {
    const buf = await file.arrayBuffer();
    // Quick pre-parse to get source file metadata for display
    const preview = parseWAV(buf);
    const srcRootNote = preview.rootNoteSmpl ?? preview.rootNoteInst ?? null;
    const item = {
      id: nextId++,
      name: file.name,
      rawBuffer: buf,
      processedBuffer: null,
      hqBuffer: null,
      pcm16: null,
      syxData: null,
      sdsPackets: null,
      nameSysEx: null,
      rootNote: srcRootNote,   // source root note for display before processing
      targetMidi: null,        // set after processing
      customName: null,        // user-overridden 4-char MD name (null = auto from filename)
      loopStart: 0,
      loopEnd: 0,
      hasLoop: false,
      overrideLoop: false,
      status: 'idle',
      size: buf.byteLength,
      error: null,
      // srcInfo: source file metadata shown in the UI before/after processing
      srcInfo: {
        sampleRate: preview.sampleRate || null,
        hasLoop: preview.hasLoop,
        loopStart: preview.loopStart,
        loopEnd: preview.loopEnd,
        rootNote: srcRootNote,
      },
    };
    state.sourceFiles.push(item);
    newItems.push(item);
  }

  renderSourceList();
  dom.sourceDropZone.classList.remove('empty');

  if (newItems.length === 1) {
    // Single file: process immediately
    await processItems(newItems);
  } else {
    // Multiple files: show banner
    dom.batchBanner.classList.add('visible');
    dom.batchMsg.textContent = `⬡ ${newItems.length} files queued — click GO to process all`;
  }
}

// ============================================================
// SECTION 11: SOURCE LIST RENDERING
// ============================================================
function renderSourceList() {
  dom.sourceList.innerHTML = '';
  state.sourceFiles.forEach(item => renderSourceItem(item, true));
  if (state.sourceFiles.length === 0) dom.sourceDropZone.classList.add('empty');
  else dom.sourceDropZone.classList.remove('empty');
}

function renderSourceItem(item, append = false) {
  const existing = document.getElementById(`src-${item.id}`);
  const el = existing || document.createElement('li');

  el.id = `src-${item.id}`;
  el.className = 'sample-item' + (state.selectedSourceIds.has(item.id) ? ' selected' : '') + (item.status === 'processing' ? ' processing' : '');
  el.draggable = true;

  const statusTag = item.status === 'done' ? '<span class="tag ok">READY</span>'
    : item.status === 'processing' ? '<span class="tag warn">PROC…</span>'
      : item.status === 'error' ? `<span class="tag err">ERR</span>`
        : '<span class="tag">RAW</span>';

  // Show source-file info before processing, output info after.
  // item.srcInfo is populated from parseWAV during handleFiles (before processing).
  const done = item.status === 'done';
  const src = item.srcInfo || {};

  // Size: show output PCM data size (without WAV header) when done,
  // otherwise raw file size.
  const sizeStr = done && item.processedBuffer
    ? fmtBytes(item.pcm16 ? item.pcm16.byteLength : item.processedBuffer.byteLength) + ' (out)'
    : fmtBytes(item.rawBuffer.byteLength) + ' (src)';

  // Sample rate: show "srcRate → dstRate" when done and rates differ, else just the relevant rate.
  const srcRate = src.sampleRate || null;
  const dstRate = item.processedSampleRate || null;
  const rateStr = done && dstRate
    ? (srcRate && srcRate !== dstRate ? fmtRate(srcRate) + '→' + fmtRate(dstRate) : fmtRate(dstRate))
    : srcRate ? fmtRate(srcRate) : '—';

  // Root note: show "srcRoot → targetA" when done and transposition happened,
  // otherwise show the source root (or — if unknown).
  const srcRoot = item.rootNote;   // original root read from file
  const targetA = item.targetMidi; // target A note after processing
  const rootStr = done && targetA !== undefined
    ? (srcRoot !== null && srcRoot !== targetA
      ? midiToNote(srcRoot) + '→' + midiToNote(targetA)
      : midiToNote(targetA))
    : (srcRoot !== null ? midiToNote(srcRoot) : '—');

  // Loop: show output loop points when done, source loop info before.
  const loopStr = done
    ? (item.hasLoop ? `LOOP ${item.loopStart}–${item.loopEnd}` : 'NO LOOP')
    : (src.hasLoop ? `SRC LOOP ${src.loopStart}–${src.loopEnd}` : 'NO LOOP');

  el.innerHTML = `
    <div class="sample-drag-handle">⋮⋮</div>
    <div class="sample-main">
      <div class="sample-name" title="${item.name}">${item.name}</div>
      <div class="sample-meta">
        ${statusTag}
        <span>${sizeStr}</span>
        <span>${rateStr}</span>
        <span>Root: ${rootStr}</span>
        <span>${loopStr}</span>
        ${item.error ? `<span class="tag err">${item.error}</span>` : ''}
      </div>
    </div>
    <div class="sample-actions">
      ${item.status === 'done' ? `<button class="btn btn-ghost btn-icon src-play-btn${state.playingItemId === item.id ? ' playing' : ''}" title="${state.playingItemId === item.id ? 'Stop' : 'Play'}" data-action="play" data-id="${item.id}">${state.playingItemId === item.id ? '■' : '▶'}</button>` : ''}
      ${item.status === 'done' ? `<button class="btn btn-ghost btn-icon" title="Edit loop points" data-action="preview" data-id="${item.id}">✎</button>` : ''}
      ${item.status === 'done' ? `<button class="btn btn-ghost btn-icon" title="Reprocess from original" data-action="reprocess" data-id="${item.id}" style="font-size:0.8rem">↺</button>` : ''}
      <button class="btn btn-ghost btn-icon" title="Remove" data-action="remove" data-id="${item.id}">✕</button>
    </div>
    ${item.status === 'processing' ? `<div class="sample-progress" style="width:60%"></div>` : ''}
  `;

  el.addEventListener('click', e => {
    if (e.target.dataset.action) return;
    toggleSelectSource(item.id);
  });
  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', String(item.id));
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));

  if (!existing && append) dom.sourceList.appendChild(el);
  else if (existing) existing.replaceWith(el);
}

function toggleSelectSource(id) {
  if (state.selectedSourceIds.has(id)) state.selectedSourceIds.delete(id);
  else state.selectedSourceIds.add(id);
  renderSourceList();
}

// ============================================================
// SECTION 12: SLOT GRID RENDERING
// ============================================================
function renderSlotGrid() {
  const cfg = getHWConfig();
  dom.slotGrid.innerHTML = '';
  for (let i = 0; i < cfg.slots; i++) {
    const sid = state.slots[i];
    const item = sid ? state.sourceFiles.find(f => f.id === sid) : null;
    const el = document.createElement('div');
    el.className = 'slot-item' +
      (sid ? ' occupied' : '') +
      (state.selectedSlotIndices.has(i) ? ' selected-slot' : '');
    el.dataset.slot = i;

    // Slot number displayed as 1-based (internal index stays 0-based)
    const displayNum = String(i + 1).padStart(2, '0');
    const shortName = item
      ? (item.customName !== null && item.customName !== undefined
        ? item.customName
        : item.name.replace(/\.wav$/i, '').substring(0, 4).toUpperCase())
      : '';
    const detail = item
      ? `${fmtBytes(item.size || 0)}${item.processedSampleRate ? '  ' + fmtRate(item.processedSampleRate) : ''}`
      : '';

    el.innerHTML = `
      <span class="slot-num">${displayNum}</span>
      <div class="slot-name ${sid ? '' : 'empty'}" ${sid ? `data-slot-name="${i}" title="Click to rename"` : ''}>${sid ? shortName : '—'}</div>
      <div class="slot-detail">${detail}</div>
      <div class="slot-actions">
        ${sid ? `<button class="slot-play-btn${state.playingItemId === sid ? ' playing' : ''}" data-slot="${i}" title="${state.playingItemId === sid ? 'Stop' : 'Play'}">${state.playingItemId === sid ? '■' : '▶'}</button>` : ''}
        ${sid ? `<button class="slot-edit-btn" data-slot="${i}" title="Edit loop points">✎</button>` : ''}
        ${sid ? `<button class="slot-clear-btn" data-slot="${i}" title="Clear slot">✕</button>` : ''}
      </div>
    `;

    el.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (btn) {
        const slotIdx = parseInt(btn.dataset.slot);
        if (btn.classList.contains('slot-clear-btn')) { clearSlot(slotIdx); return; }
        if (btn.classList.contains('slot-play-btn')) { playSlotInline(slotIdx); return; }
        if (btn.classList.contains('slot-edit-btn')) { previewSlot(slotIdx); return; }
      }
      // Click on slot name → inline rename
      if (e.target.dataset.slotName !== undefined && sid) {
        startSlotRename(e.target, parseInt(e.target.dataset.slotName), item);
        return;
      }
      toggleSelectSlot(i);
    });
    // Drag FROM an occupied slot (for slot-to-slot swapping)
    el.draggable = !!sid;
    if (sid) {
      el.addEventListener('dragstart', e => {
        // Mark this as a slot drag so the drop handler knows to swap
        e.dataTransfer.setData('text/plain', String(sid));
        e.dataTransfer.setData('slot-source', String(i));
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
    }
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drop-target'); });
    el.addEventListener('dragleave', e => {
      // Only remove if we're actually leaving this element (not entering a child)
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target');
    });
    el.addEventListener('drop', async e => {
      e.preventDefault();
      el.classList.remove('drop-target');

      // External file drop (.syx / .sds)?
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'syx' || ext === 'sds') {
          await importSysexIntoSlot(file, i);
          return;
        }
      }

      const sourceSlot = parseInt(e.dataTransfer.getData('slot-source'));
      const sampleId = parseInt(e.dataTransfer.getData('text/plain'));
      if (!isNaN(sourceSlot)) {
        swapSlots(sourceSlot, i);
      } else {
        assignToSlot(sampleId, i);
      }
    });

    dom.slotGrid.appendChild(el);
  }
}

function startSlotRename(nameEl, slotIdx, item) {
  const current = nameEl.textContent;
  nameEl.textContent = '';
  const input = document.createElement('input');
  input.className = 'name-edit';
  input.maxLength = 4;
  input.value = current;
  input.style.cssText = 'font-family:var(--font-mono);font-size:0.8rem;color:var(--text-amber);background:var(--bg3);border:1px solid var(--amber);border-radius:2px;width:52px;padding:1px 3px;letter-spacing:0.08em;text-transform:uppercase;outline:none;';
  nameEl.appendChild(input);
  input.focus();
  input.select();

  let committed = false;
  function commit() {
    if (committed) return;  // prevent double-fire from Enter keydown + blur
    committed = true;
    const val = input.value.toUpperCase().replace(/[^A-Z0-9\-_ ]/g, '').substring(0, 4).trimEnd();
    item.customName = val || null;
    // Rebuild SDS/name SysEx with the new name immediately
    const slot = state.slots.indexOf(item.id);
    if (slot >= 0) rebuildSDS(item, slot);
    renderSlotGrid();
    setStatus(`Slot ${slotIdx + 1} renamed to "${item.customName || 'auto'}"`);
  }

  function cancel() {
    if (committed) return;
    committed = true;
    renderSlotGrid();
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { cancel(); }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', e => e.stopPropagation());
}

function previewSlot(slotIndex) {
  const sid = state.slots[slotIndex];
  if (!sid) return;
  const item = state.sourceFiles.find(f => f.id === sid);
  if (!item || !item.pcm16) { setStatus('Process sample before previewing', false, 'warn'); return; }
  openPlayer(item);
}

function playItemInline(item) {
  if (!item || !item.pcm16) { setStatus('Process sample before playing', false, 'warn'); return; }
  // Toggle: if already playing this item, stop it
  if (state.playingItemId === item.id) {
    stopInlinePlayback();
    return;
  }
  // Stop anything else — stopAudio() inside playAudio() now handles this too,
  // but we clear state here so buttons update before playback starts.
  stopInlinePlayback();
  // Set state and update buttons to ■
  state.playerItem = item;
  state.playingItemId = item.id;
  dom.loopStart.value = item.loopStart;
  dom.loopEnd.value = item.loopEnd;
  dom.loopEnabled.checked = item.hasLoop;
  renderSlotGrid();
  renderSourceList();
  // Fully synchronous — no await, no races
  playAudio(item.hasLoop);
  setStatus(`Playing: ${item.name}`);
}

function playSlotInline(slotIndex) {
  const sid = state.slots[slotIndex];
  if (!sid) return;
  const item = state.sourceFiles.find(f => f.id === sid);
  playItemInline(item);
}

function toggleSelectSlot(i) {
  if (state.selectedSlotIndices.has(i)) state.selectedSlotIndices.delete(i);
  else state.selectedSlotIndices.add(i);
  renderSlotGrid();
}

function assignToSlot(sampleId, slotIndex) {
  const item = state.sourceFiles.find(f => f.id === sampleId);
  if (!item) return;
  if (item.status !== 'done') {
    setStatus(`Process "${item.name}" before assigning to slot`, false, 'warn');
    return;
  }
  state.slots[slotIndex] = sampleId;
  // Update SDS packets with correct slot number
  rebuildSDS(item, slotIndex);
  renderSlotGrid();
  updateMemGauge();
  setStatus(`Assigned "${item.name}" → slot ${slotIndex}`);
}

async function importSysexIntoSlot(file, slotIndex) {
  setStatus(`Reading ${file.name}…`, true);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const buffer = await file.arrayBuffer();
  const parsed = parseSysexFile(buffer);

  if (!parsed.ok) {
    setStatus(`Import failed: ${parsed.error}`, false, 'err');
    setSpinner(false);
    return;
  }

  // Build WAV buffer from decoded PCM so the item integrates with existing pipeline
  const name = parsed.name || file.name.replace(/\.[^.]+$/, '').substring(0, 4).toUpperCase();
  const sr = parsed.sampleRate;
  const wavBuf = buildWAV(parsed.pcm16, sr, 1, 16,
    parsed.loopStart, parsed.loopEnd, parsed.hasLoop, 69);

  const item = {
    id: nextId++,
    name: file.name,
    rawBuffer: buffer,       // keep original .syx as the immutable source record
    processedBuffer: wavBuf,
    hqBuffer: null,
    pcm16: parsed.pcm16,
    syxData: null,           // populated below by rebuildSDS() with the correct slot number
    sdsPackets: null,        // populated below by rebuildSDS()
    nameSysEx: null,         // populated below by rebuildSDS()
    rootNote: 69,
    targetMidi: 69,
    customName: name,
    loopStart: parsed.loopStart,
    loopEnd: parsed.loopEnd,
    hasLoop: parsed.hasLoop,
    overrideLoop: true,
    status: 'done',
    size: wavBuf.byteLength,
    error: null,
    processedSampleRate: sr,
    processedChannels: 1,
    srcInfo: {
      sampleRate: sr,
      hasLoop: parsed.hasLoop,
      loopStart: parsed.loopStart,
      loopEnd: parsed.loopEnd,
      rootNote: 69,
    },
  };

  state.sourceFiles.push(item);
  state.slots[slotIndex] = item.id;

  // Rebuild SDS packets and syxData for the TARGET slot, not whatever slot
  // was encoded in the original file. The raw .syx may have been exported from
  // a different slot, so reusing its bytes verbatim would embed the wrong slot
  // number in the dump header and Elektron name SysEx, corrupting the transfer.
  rebuildSDS(item, slotIndex);

  renderSourceList();
  renderSlotGrid();
  updateMemGauge();
  setSpinner(false);
  setStatus(`Imported "${name}" → slot ${slotIndex + 1} (${fmtBytes(parsed.pcm16.byteLength)} · ${fmtRate(sr)})`);
}

function swapSlots(fromIdx, toIdx) {
  if (fromIdx === toIdx) return;
  const tmp = state.slots[toIdx];
  state.slots[toIdx] = state.slots[fromIdx];
  state.slots[fromIdx] = tmp;
  // Rebuild SDS for both slots with their new slot numbers
  if (state.slots[toIdx]) { const item = state.sourceFiles.find(f => f.id === state.slots[toIdx]); if (item) rebuildSDS(item, toIdx); }
  if (state.slots[fromIdx]) { const item = state.sourceFiles.find(f => f.id === state.slots[fromIdx]); if (item) rebuildSDS(item, fromIdx); }
  renderSlotGrid();
  updateMemGauge();
  setStatus(`Swapped slot ${fromIdx + 1} ↔ slot ${toIdx + 1}`);
}

function rebuildSDS(item, slot) {
  if (!item.pcm16) return;
  const nameStr = item.customName !== null && item.customName !== undefined
    ? item.customName
    : item.name.replace(/\.wav$/i, '');
  // Clamp loop points to actual pcm16 length — stale values from a previous
  // processing run or edit can exceed the current buffer, causing the MD to
  // read past the end of the sample into adjacent memory (other slots).
  const maxSample = item.pcm16.length - 1;
  const loopStart = Math.max(0, Math.min(item.loopStart || 0, maxSample));
  const loopEnd = Math.max(0, Math.min(item.loopEnd || 0, maxSample));
  const hasLoop = item.hasLoop && loopEnd > loopStart;
  item.sdsPackets = buildSDS(slot, item.pcm16, item.processedSampleRate, item.processedChannels,
    loopStart, loopEnd, hasLoop, nameStr);
  item.nameSysEx = buildNameSysEx(slot, nameStr);
  item.syxData = flattenSDS(item.sdsPackets, item.nameSysEx);
}

function clearSlot(i) {
  state.slots[i] = null;
  state.selectedSlotIndices.delete(i);
  renderSlotGrid();
  updateMemGauge();
}

// ============================================================
// SECTION 13: PLAYER / LOOP EDITOR
// ============================================================
let playerAudioCtx = null;
let playerSourceNode = null;
let playerAudioBuffer = null;

function openPlayer(item) {
  if (!item || !item.processedBuffer) { setStatus('Process the sample first', false, 'warn'); return; }
  state.playerItem = item;
  dom.playerFileName.textContent = item.name;
  dom.loopStart.value = item.loopStart;
  dom.loopEnd.value = item.loopEnd;
  dom.loopEnabled.checked = item.hasLoop;

  // Parse processedBuffer to get sampleRate for display
  const view = new DataView(item.processedBuffer);
  const sr = view.getUint32(24, true);
  dom.playerSampleRate.textContent = fmtRate(sr) + ' · ' + (item.processedChannels === 1 ? 'Mono' : 'Stereo');
  dom.loopEnd.max = (item.pcm16 ? item.pcm16.length - 1 : 0);
  dom.loopStart.max = dom.loopEnd.value;

  drawWaveform(item);
  dom.playerModal.classList.add('open');
}

function drawWaveform(item) {
  const canvas = dom.waveform;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (!item.pcm16) return;
  const data = item.pcm16;
  const len = data.length;

  // Background
  ctx.fillStyle = '#181c22';
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = '#2a3040';
  ctx.lineWidth = 1;
  for (let y = H * 0.25; y < H; y += H * 0.25) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // Loop region
  if (item.hasLoop && item.loopEnd > item.loopStart) {
    const x1 = (item.loopStart / len) * W;
    const x2 = (item.loopEnd / len) * W;
    ctx.fillStyle = '#30c06018';
    ctx.fillRect(x1, 0, x2 - x1, H);
    ctx.strokeStyle = '#30c06060';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2, 0); ctx.lineTo(x2, H); ctx.stroke();
  }

  // Waveform
  const samplesPerPixel = Math.max(1, Math.floor(len / W));
  ctx.strokeStyle = '#e8a020';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let px = 0; px < W; px++) {
    let min = 1, max = -1;
    const start = Math.floor(px * len / W);
    const end = Math.min(len, start + samplesPerPixel);
    for (let i = start; i < end; i++) {
      const v = data[i] / 32768;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = (1 - max) * H / 2;
    const y2 = (1 - min) * H / 2;
    if (px === 0) ctx.moveTo(px, (y1 + y2) / 2);
    ctx.lineTo(px, y1);
    ctx.lineTo(px, y2);
  }
  ctx.stroke();

  // Center line
  ctx.strokeStyle = '#3a455880';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
}

// ── Audio engine ─────────────────────────────────────────────────────────
// Single AudioContext, single active source node.
// All state lives here; no async races.
let _audioCtx = null;
let _srcNode = null;
let _audioBuf = null;
let _bufItemId = null;
let _bufResampRatio = 1.0;  // itemSr / ctxSr — for rescaling loop points

function _getCtx(sr) {
  // Reuse context if sample rate matches; otherwise create a new one.
  // AudioContext at exactly the sample rate of the buffer = zero resampling.
  if (_audioCtx && _audioCtx.sampleRate === sr && _audioCtx.state !== 'closed') return _audioCtx;
  if (_audioCtx) { try { _audioCtx.close(); } catch (e) { } }
  _audioCtx = new AudioContext({ sampleRate: sr });
  _audioBuf = null;   // buffer belongs to old ctx, must rebuild
  _bufItemId = null;
  return _audioCtx;
}

function _loadBuffer(item) {
  // Rebuild Float32 buffer only when the item changes.
  if (_bufItemId === item.id && _audioBuf) return _audioBuf;
  const itemSr = item.processedSampleRate;
  const ctxSr = _audioCtx.sampleRate;   // what the browser ACTUALLY runs at
  const pcm = item.pcm16;

  let floatData;
  if (itemSr === ctxSr) {
    // Rates match exactly — straight copy, zero resampling, loop points untouched
    floatData = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) floatData[i] = pcm[i] / 32768.0;
  } else {
    // Browser is running at a different rate (e.g. 48 kHz output, 44.1 kHz sample).
    // Resample NOW in JS using linear interpolation so the AudioBuffer lives
    // entirely at ctxSr — the browser will play it with zero internal resampling
    // and loop points will be exactly on integer sample boundaries.
    const ratio = itemSr / ctxSr;                         // e.g. 44100/48000
    const outLen = Math.round(pcm.length / ratio);
    floatData = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = idx < pcm.length ? pcm[idx] / 32768.0 : 0;
      const b = idx + 1 < pcm.length ? pcm[idx + 1] / 32768.0 : 0;
      floatData[i] = a + frac * (b - a);
    }
  }

  const buf = _audioCtx.createBuffer(item.processedChannels || 1, floatData.length, ctxSr);
  buf.getChannelData(0).set(floatData);

  // Store the ratio so callers can rescale loop points into ctxSr coordinates
  _audioBuf = buf;
  _bufItemId = item.id;
  _bufResampRatio = itemSr / ctxSr;   // multiply sample-index by this → ctxSr index
  return buf;
}

function stopAudio() {
  if (_srcNode) {
    _srcNode.onended = null;          // prevent stale callback firing
    try { _srcNode.stop(0); } catch (e) { }
    _srcNode.disconnect();
    _srcNode = null;
  }
}

function stopInlinePlayback() {
  stopAudio();
  state.playingItemId = null;
  renderSlotGrid();
  renderSourceList();
  setStatus('Stopped');
}

function playAudio(looping) {
  const item = state.playerItem;
  if (!item?.pcm16) return;

  stopAudio();

  const sr = item.processedSampleRate;
  const ctx = _getCtx(sr);
  if (ctx.state === 'suspended') ctx.resume();

  const pcm = item.pcm16;
  const ls = parseInt(dom.loopStart.value) || 0;
  const le = parseInt(dom.loopEnd.value) || pcm.length - 1;
  const doLoop = looping && dom.loopEnabled.checked && le > ls;

  // Load full sample into buffer — straight Int16→Float32, no tricks
  const buf = _loadBuffer(item);

  _srcNode = ctx.createBufferSource();
  _srcNode.buffer = buf;
  _srcNode.connect(ctx.destination);

  if (doLoop) {
    // Native AudioBufferSourceNode loop.
    // loopEnd is EXCLUSIVE in the spec — the engine wraps back to loopStart
    // BEFORE playing the sample at loopEnd. So the played range is [ls .. le-1]
    // then back to ls. To include sample le in the loop, set loopEnd = le + 1.
    // Both points in seconds: divide by sample rate.
    _srcNode.loop = true;
    _srcNode.loopStart = ls / sr;
    _srcNode.loopEnd = (le + 1) / sr;
    _srcNode.start(0, ls / sr);
  } else {
    _srcNode.loop = false;
    _srcNode.start();
    _srcNode.onended = () => {
      if (state.playingItemId === item.id) stopInlinePlayback();
    };
  }

  playerSourceNode = _srcNode;
}


// ============================================================
// SECTION 14: MIDI / SDS TRANSFER
// ============================================================
async function initMIDI() {
  if (!navigator.requestMIDIAccess) {
    dom.midiDot.className = 'midi-dot error';
    dom.midiLabel.textContent = 'MIDI N/A';
    setStatus('WebMIDI not supported in this browser', false, 'err');
    return;
  }
  try {
    state.midiAccess = await navigator.requestMIDIAccess({ sysex: true });
    populateMIDIPorts();
    state.midiAccess.onstatechange = populateMIDIPorts;
    dom.midiDot.className = 'midi-dot connected';
    dom.midiLabel.textContent = 'MIDI OK';
    setStatus('WebMIDI connected');
  } catch (e) {
    dom.midiDot.className = 'midi-dot error';
    dom.midiLabel.textContent = 'MIDI DENIED';
    setStatus('MIDI access denied — enable SysEx permissions', false, 'err');
  }
}

function populateMIDIPorts() {
  if (!state.midiAccess) return;
  const sel = dom.midiPortSelect;
  const current = sel.value;
  sel.innerHTML = '<option value="">— none —</option>';
  for (const [id, port] of state.midiAccess.outputs) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = port.name;
    if (id === current) opt.selected = true;
    sel.appendChild(opt);
  }
  if (!sel.value && state.midiAccess.outputs.size > 0) {
    sel.selectedIndex = 1;
  }
  updateMIDIOutput();
}

function updateMIDIOutput() {
  const id = dom.midiPortSelect.value;
  state.midiOutput = id && state.midiAccess ? state.midiAccess.outputs.get(id) : null;
  const portName = state.midiOutput ? state.midiOutput.name : 'NO PORT';
  dom.midiLabel.textContent = portName.substring(0, 14);

}

async function sendSDS(slots) {
  if (!state.midiOutput) { setStatus('Select a MIDI port first', false, 'warn'); return; }
  if (state.isSending) return;

  const items = slots
    .filter(i => state.slots[i] !== null)
    .map(i => ({ slot: i, item: state.sourceFiles.find(f => f.id === state.slots[i]) }))
    .filter(x => x.item && x.item.status === 'done');

  if (!items.length) { setStatus('No processed samples in selected slots', false, 'warn'); return; }

  state.isSending = true;
  state.abortSend = false;
  dom.btnSendAll.disabled = true;
  dom.btnSendSelected.disabled = true;
  dom.btnAbortSend.style.display = '';
  dom.sendProgressBar.style.display = '';
  dom.sendProgressFill.style.width = '0%';

  const turbo = parseInt(dom.turboSpeed.value);
  const closedLoop = dom.sdsHandshake.value === 'closed';
  const baseDelay = Math.round(SDS.PACKET_DELAY_MS / turbo);

  dom.turboIndicator.className = 'turbo-indicator' + (turbo > 1 ? ' active' : '');
  dom.turboIndicator.textContent = `${turbo}× ${turbo > 1 ? 'TURBO' : 'STD'}`;

  // Rebuild ALL items first with their correct slot numbers,
  // so totalPackets is accurate and headers have fresh sample lengths/loop points.
  for (const { slot, item } of items) {
    rebuildSDS(item, slot);
  }
  let totalPackets = items.reduce((s, x) => s + (x.item.sdsPackets?.length || 0), 0);
  let sent = 0;

  setStatus(`Sending ${items.length} sample(s) via SDS…`, true);

  for (const { slot, item } of items) {
    if (state.abortSend) break;
    setStatus(`Sending slot ${slot}: ${item.name} (${item.sdsPackets.length} packets)`, true);

    // Order: name FIRST, then dump header, then data packets.
    // Sending name first overwrites any cached name/metadata in the MD for this slot.
    // Stale name on first send was the MD using its previous cached name
    // because the new name arrived AFTER the audio (too late to associate it).

    // 1. Name SysEx FIRST
    if (!state.abortSend) {
      state.midiOutput.send(item.nameSysEx);
      await sleep(baseDelay);
    }

    // 2. Dump header
    const headerPkt = item.sdsPackets.find(p => p.type === 'header');
    if (headerPkt) {
      state.midiOutput.send(headerPkt.data);
      await sleep(baseDelay);
    }

    // 3. Data packets
    const dataPackets = item.sdsPackets.filter(p => p.type === 'data');
    for (const pkt of dataPackets) {
      if (state.abortSend) break;

      state.midiOutput.send(pkt.data);
      sent++;
      dom.sendProgressFill.style.width = (sent / totalPackets * 100) + '%';

      if (closedLoop) {
        const ack = await waitForACK(item.sdsMeta?.slot ?? slot, pkt.pktNum, 500);
        if (ack === 'nak') {
          // Resend and wait full base delay
          state.midiOutput.send(pkt.data);
          await sleep(baseDelay);
        } else if (ack === 'timeout') {
          // MD not responding — give it extra time before next packet
          await sleep(baseDelay * 2);
        } else {
          // ACK received — add a small post-ACK gap so MD can prepare for next packet.
          // Without this, at 4x turbo the next packet arrives before MD is ready.
          // Minimum 5ms regardless of turbo speed — empirically safe for MD firmware.
          await sleep(Math.max(5, Math.round(baseDelay * 0.5)));
        }
      } else {
        await sleep(baseDelay);
      }
    }
  }

  state.isSending = false;
  dom.btnSendAll.disabled = false;
  dom.btnSendSelected.disabled = false;
  dom.btnAbortSend.style.display = 'none';
  dom.sendProgressFill.style.width = '100%';
  setTimeout(() => { dom.sendProgressBar.style.display = 'none'; }, 1500);
  setStatus(state.abortSend ? 'Transfer cancelled' : 'Transfer complete', false, state.abortSend ? 'warn' : 'ok');
  setSpinner(false);
}

function waitForACK(slotNum, pktNum, timeoutMs) {
  return new Promise(resolve => {
    if (!state.midiAccess) { resolve('timeout'); return; }

    // Use addEventListener so we don't clobber other listeners and
    // don't create a gap between cleanup and next packet's listener setup.
    const inputs = [...state.midiAccess.inputs.values()];
    let resolved = false;

    function onMessage(e) {
      if (resolved) return;
      const d = e.data;
      // Must be a universal non-realtime SysEx response
      if (d.length >= 6 && d[0] === SDS.HEADER && d[1] === SDS.MANU_ID) {
        if (d[3] === SDS.WAIT) {
          // MD needs more time — reset timeout and keep waiting
          clearTimeout(timer);
          timer = setTimeout(() => { cleanup(); resolve('timeout'); }, timeoutMs * 3);
          return;
        }
        if (d[3] === SDS.ACK) { cleanup(); resolve('ack'); }
        else if (d[3] === SDS.NAK) { cleanup(); resolve('nak'); }
        else if (d[3] === SDS.CANCEL) { cleanup(); resolve('cancel'); }
      }
    }

    function cleanup() {
      resolved = true;
      clearTimeout(timer);
      inputs.forEach(inp => inp.removeEventListener('midimessage', onMessage));
    }

    let timer = setTimeout(() => { cleanup(); resolve('timeout'); }, timeoutMs);
    inputs.forEach(inp => inp.addEventListener('midimessage', onMessage));
  });
}

// ============================================================
// SECTION 15: DOWNLOAD HELPERS
// ============================================================
function downloadBuffer(buffer, filename, mime = 'audio/wav') {
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function downloadSelected(type) {
  const selected = state.sourceFiles.filter(f => state.selectedSourceIds.has(f.id));
  const targets = selected.length ? selected : state.sourceFiles.filter(f => f.status === 'done');
  if (!targets.length) { setStatus('No processed samples to download', false, 'warn'); return; }
  for (const item of targets) {
    const base = item.name.replace(/\.wav$/i, '');
    if (type === 'wav' && item.processedBuffer) downloadBuffer(item.processedBuffer, `${base}_md.wav`);
    else if (type === 'hq' && item.hqBuffer) downloadBuffer(item.hqBuffer, `${base}_hq.wav`);
    else if (type === 'syx' && item.syxData) downloadBuffer(item.syxData, `${base}.syx`, 'application/octet-stream');
    else setStatus(`No ${type.toUpperCase()} data — process first`, false, 'warn');
  }
}

// ============================================================
// SECTION 16: MODALS & PROMPTS
// ============================================================
// ============================================================
// FFT PITCH DETECTOR (HPS — Harmonic Product Spectrum)
// ============================================================
// Returns { midi, freq, confidence (0..1), note }
// confidence < 0.15 = no clear pitch detected
function detectPitch(monoFloat32, sampleRate) {
  // Use up to 2 seconds, minimum 4096 samples
  const MAX_SAMPLES = sampleRate * 2;
  const data = monoFloat32.length > MAX_SAMPLES
    ? monoFloat32.slice(0, MAX_SAMPLES)
    : monoFloat32;

  // Choose FFT size: largest power of 2 <= data.length, min 4096 max 32768
  let fftSize = 4096;
  while (fftSize * 2 <= data.length && fftSize < 32768) fftSize *= 2;

  // Apply Hann window to reduce spectral leakage
  const windowed = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
    windowed[i] = (i < data.length ? data[i] : 0) * w;
  }

  // FFT (Cooley-Tukey, in-place)
  // CRITICAL: bit-reversal permutation MUST come BEFORE the butterfly loops.
  const re = new Float32Array(windowed);
  const im = new Float32Array(fftSize);
  // Step 1: Bit-reversal permutation
  for (let i = 1, j = 0; i < fftSize; i++) {
    let bit = fftSize >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Step 2: Butterfly loops
  for (let len = 2; len <= fftSize; len <<= 1) {
    const half = len >> 1;
    const step = 2 * Math.PI / len;
    for (let i = 0; i < fftSize; i += len) {
      for (let j = 0; j < half; j++) {
        const cos = Math.cos(step * j);
        const sin = Math.sin(step * j);
        const tr = cos * re[i + j + half] + sin * im[i + j + half];
        const ti = -sin * re[i + j + half] + cos * im[i + j + half];
        re[i + j + half] = re[i + j] - tr;
        im[i + j + half] = im[i + j] - ti;
        re[i + j] += tr;
        im[i + j] += ti;
      }
    }
  }

  // Magnitude spectrum (only positive frequencies up to Nyquist)
  const N = fftSize / 2;
  const mag = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }

  // Limit search to musically relevant range: C0 (16.35 Hz) to B8 (7902 Hz)
  const freqPerBin = sampleRate / fftSize;
  const minBin = Math.ceil(16.35 / freqPerBin);
  const maxBin = Math.floor(7902 / freqPerBin);

  // Find peak bin in magnitude spectrum
  // Plain FFT peak with parabolic interpolation is sufficient and correct
  // for both pure sines and harmonic-rich sounds. HPS was removed because
  // the naive implementation (multiply by harmonics) kills pure sine fundamentals.
  let peakBin = minBin, peakVal = 0;
  for (let i = minBin; i <= maxBin; i++) {
    if (mag[i] > peakVal) { peakVal = mag[i]; peakBin = i; }
  }

  // Parabolic interpolation for sub-bin frequency accuracy
  const alpha = peakBin > minBin ? mag[peakBin - 1] : 0;
  const beta = mag[peakBin];
  const gamma = peakBin < N - 1 ? mag[peakBin + 1] : 0;
  const denom = alpha - 2 * beta + gamma;
  const interp = denom !== 0 ? 0.5 * (alpha - gamma) / denom : 0;
  const detectedFreq = (peakBin + interp) * freqPerBin;

  // Convert frequency to MIDI note
  const midi = Math.round(69 + 12 * Math.log2(detectedFreq / 440));
  const midiClamped = Math.max(0, Math.min(127, midi));

  // Confidence: ratio of peak energy to mean energy in the musical range.
  // A clear tonal signal has a sharp peak far above the mean.
  let sum = 0;
  for (let i = minBin; i <= maxBin; i++) sum += mag[i];
  const mean = sum / (maxBin - minBin + 1);
  const confidence = mean > 0 ? Math.min(1, peakVal / (mean * 20)) : 0;

  return {
    midi: midiClamped,
    freq: detectedFreq,
    confidence: confidence,
    note: midiToNote(midiClamped),
  };
}

async function askRootNote(filename, monoData, sampleRate) {
  // Yield before FFT so spinner is visible and animating
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Run FFT pitch detection
  let detected = null;
  if (monoData && monoData.length > 512 && sampleRate) {
    detected = detectPitch(monoData, sampleRate);
  }

  return new Promise(resolve => {
    const sel = document.getElementById('rootNoteSelect');
    const tunerDiv = document.getElementById('tunerResult');
    const tunerNote = document.getElementById('tunerNote');
    const tunerFreq = document.getElementById('tunerFreq');
    const tunerBar = document.getElementById('tunerConfBar');
    const tunerLbl = document.getElementById('tunerConfLabel');

    // Build dropdown
    sel.innerHTML = '';
    const defaultMidi = (detected && detected.confidence >= 0.15) ? detected.midi : 69;
    for (let midi = 0; midi <= 127; midi++) {
      const opt = document.createElement('option');
      opt.value = midi;
      opt.textContent = `${midiToNote(midi)}  (MIDI ${midi})`;
      if (midi === defaultMidi) opt.selected = true;
      sel.appendChild(opt);
    }

    // Show tuner result
    if (detected) {
      tunerDiv.style.display = '';
      const conf = detected.confidence;
      const strong = conf >= 0.5;
      const medium = conf >= 0.15;

      if (!medium) {
        tunerNote.textContent = '—';
        tunerFreq.textContent = 'No clear pitch detected';
        tunerFreq.style.color = 'var(--text-dim)';
        tunerBar.style.width = '0%';
        tunerBar.style.background = 'var(--text-dim)';
        tunerLbl.textContent = 'Weak';
        tunerLbl.style.color = 'var(--text-dim)';
        dom.rootNoteModalMsg.textContent = `No root note in "${filename}". FFT found no clear pitch — please select manually:`;
      } else {
        tunerNote.textContent = detected.note;
        tunerFreq.textContent = `${detected.freq.toFixed(1)} Hz`;
        tunerFreq.style.color = 'var(--text-secondary)';
        const pct = Math.round(conf * 100);
        const color = strong ? 'var(--green)' : 'var(--amber)';
        const label = strong ? 'Strong' : 'Medium';
        tunerBar.style.width = pct + '%';
        tunerBar.style.background = color;
        tunerLbl.textContent = label;
        tunerLbl.style.color = color;
        dom.rootNoteModalMsg.textContent = `No root note in "${filename}". FFT detected — confirm or override:`;
      }
    } else {
      tunerDiv.style.display = 'none';
      dom.rootNoteModalMsg.textContent = `No root note found in "${filename}". Select the root note:`;
    }

    // Hide the processing overlay while user interacts with this modal
    const procOverlay = document.getElementById('procOverlay');
    if (procOverlay) procOverlay.classList.remove('active');

    dom.rootNoteModal.classList.add('open');

    dom.btnRootConfirm.onclick = () => {
      dom.rootNoteModal.classList.remove('open');
      if (procOverlay) procOverlay.classList.add('active');
      resolve(parseInt(sel.value));
    };
    dom.btnRootCancel.onclick = () => {
      dom.rootNoteModal.classList.remove('open');
      if (procOverlay) procOverlay.classList.add('active');
      resolve(null);
    };
  });
}

function askRootNoteConflict(filename, smplNote, instNote) {
  return new Promise(resolve => {
    dom.rootNoteModalMsg.textContent =
      `"${filename}" has conflicting root notes:
` +
      `smpl chunk: ${midiToNote(smplNote)} (MIDI ${smplNote})  |  ` +
      `inst chunk: ${midiToNote(instNote)} (MIDI ${instNote})
Which should be used?`;

    // Repurpose the select as two big option buttons instead
    const sel = document.getElementById('rootNoteSelect');
    sel.innerHTML = '';
    const optSmpl = document.createElement('option');
    optSmpl.value = smplNote;
    optSmpl.textContent = `smpl chunk — ${midiToNote(smplNote)} (MIDI ${smplNote})`;
    optSmpl.selected = true;
    const optInst = document.createElement('option');
    optInst.value = instNote;
    optInst.textContent = `inst chunk — ${midiToNote(instNote)} (MIDI ${instNote})`;
    sel.appendChild(optSmpl);
    sel.appendChild(optInst);

    const procOverlay2 = document.getElementById('procOverlay');
    if (procOverlay2) procOverlay2.classList.remove('active');

    dom.rootNoteModal.classList.add('open');

    dom.btnRootConfirm.onclick = () => {
      dom.rootNoteModal.classList.remove('open');
      if (procOverlay2) procOverlay2.classList.add('active');
      resolve(parseInt(sel.value));
    };
    dom.btnRootCancel.onclick = () => {
      dom.rootNoteModal.classList.remove('open');
      if (procOverlay2) procOverlay2.classList.add('active');
      resolve(null);
    };
  });
}

function confirmDialog(title, msg) {
  return new Promise(resolve => {
    dom.batchConfirmModal.querySelector('h3').textContent = title;
    dom.batchConfirmMsg.textContent = msg;
    dom.batchConfirmModal.classList.add('open');
    dom.btnBatchProceed.onclick = () => { dom.batchConfirmModal.classList.remove('open'); resolve(true); };
    dom.btnBatchCancel.onclick = () => { dom.batchConfirmModal.classList.remove('open'); resolve(false); };
  });
}

// ============================================================
// SECTION 17: UTILITY FUNCTIONS
// ============================================================
function fmtBytes(b) {
  if (b === 0) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(2) + ' MB';
}
function fmtRate(r) {
  return r >= 1000 ? (r / 1000).toFixed(r % 1000 === 0 ? 0 : 1) + ' kHz' : r + ' Hz';
}
function midiToNote(midi) {
  const oct = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[midi % 12] + oct;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function setStatus(msg, spin = false, type = '') {
  dom.statusText.textContent = msg;
  dom.statusText.className = 'status-text' + (type ? ' ' + type : '');
  return setSpinner(spin, msg);  // propagate Promise so callers can await
}
function setSpinner(on, msg = '') {
  dom.globalSpinner.className = 'spinner' + (on ? ' active' : '');
  const overlay = document.getElementById('procOverlay');
  if (!overlay) return Promise.resolve();
  if (on) {
    overlay.classList.add('active');
    const labelEl = document.getElementById('procLabel');
    const fileEl = document.getElementById('procFile');
    if (labelEl) labelEl.textContent = state.isSending ? 'Sending SDS…' : 'Processing…';
    if (fileEl) {
      const m = msg.match(/(?:Processing|Sending):\s*(.+)/i);
      fileEl.textContent = m ? m[1] : msg;
    }
    // Return a Promise that resolves after TWO animation frames —
    // the first frame schedules the paint, the second confirms it has happened.
    // Without this yield, the browser never renders the overlay before
    // the JS thread is locked by the DSP resampler loop.
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  } else {
    overlay.classList.remove('active');
    return Promise.resolve();
  }
}

// ============================================================
// SECTION 18: EVENT WIRING
// ============================================================
// Drop zone
dom.sourceDropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dom.sourceDropZone.classList.add('drag-over');
});
dom.sourceDropZone.addEventListener('dragleave', e => {
  if (!dom.sourceDropZone.contains(e.relatedTarget))
    dom.sourceDropZone.classList.remove('drag-over');
});
dom.sourceDropZone.addEventListener('drop', async e => {
  e.preventDefault();
  dom.sourceDropZone.classList.remove('drag-over');
  // Only handle external file drops (not internal sample drags)
  if (e.dataTransfer.files.length > 0) await handleFiles(e.dataTransfer.files);
});
dom.sourceDropOverlay.addEventListener('click', () => dom.fileInput.click());
dom.fileInput.addEventListener('change', e => { if (e.target.files.length) handleFiles(e.target.files); });

// Settings
dom.targetSampleRate.addEventListener('change', () => {
  dom.customSampleRate.style.display = dom.targetSampleRate.value === 'custom' ? '' : 'none';
});
dom.midiPortSelect.addEventListener('change', updateMIDIOutput);
dom.turboSpeed.addEventListener('change', () => {
  const t = parseInt(dom.turboSpeed.value);
  dom.turboIndicator.textContent = `${t}× ${t > 1 ? 'TURBO' : 'STD'}`;
  dom.turboIndicator.className = 'turbo-indicator' + (t > 1 ? ' active' : '');
});

// Buttons
dom.btnGo.addEventListener('click', async () => {
  dom.batchBanner.classList.remove('visible');
  await processItems(state.sourceFiles.filter(f => f.status === 'idle'));
});
dom.btnReprocess.addEventListener('click', () => {
  const sel = state.sourceFiles.filter(f => state.selectedSourceIds.has(f.id));
  const targets = sel.length ? sel : state.sourceFiles;
  if (!targets.length) { setStatus('Nothing to reprocess', false, 'warn'); return; }
  targets.forEach(item => {
    // Reset processed state — rawBuffer is always kept, so we can reprocess from original
    item.processedBuffer = null;
    item.hqBuffer = null;
    item.pcm16 = null;
    item.syxData = null;
    item.sdsPackets = null;
    item.nameSysEx = null;
    item.status = 'idle';
    item.error = null;
    item.overrideLoop = false;  // clear manual loop overrides so fresh loop points are calculated
  });
  renderSourceList();
  processItems(targets);
});

dom.btnProcessSelected.addEventListener('click', () => {
  const sel = state.sourceFiles.filter(f => state.selectedSourceIds.has(f.id));
  const targets = sel.length ? sel : state.sourceFiles.filter(f => f.status === 'idle');
  if (!targets.length) { setStatus('Nothing to process', false, 'warn'); return; }
  processItems(targets);
});
dom.btnSelectAll.addEventListener('click', () => {
  state.sourceFiles.forEach(f => state.selectedSourceIds.add(f.id));
  renderSourceList();
});
dom.btnClearSource.addEventListener('click', () => {
  state.sourceFiles = [];
  state.selectedSourceIds.clear();
  renderSourceList();
  updateMemGauge();
  dom.batchBanner.classList.remove('visible');
  setStatus('Source list cleared');
});
dom.btnClearQueue.addEventListener('click', () => {
  state.slots.fill(null);
  state.selectedSlotIndices.clear();
  renderSlotGrid();
  updateMemGauge();
  setStatus('Transfer queue cleared');
});
dom.btnDownloadProcessed.addEventListener('click', () => downloadSelected('wav'));
dom.btnDownloadHQ.addEventListener('click', () => downloadSelected('hq'));
dom.btnDownloadSyx.addEventListener('click', () => downloadSelected('syx'));
dom.btnAddToQueue.addEventListener('click', () => {
  const sel = state.sourceFiles.filter(f => state.selectedSourceIds.has(f.id) && f.status === 'done');
  if (!sel.length) { setStatus('Select processed samples to add to queue', false, 'warn'); return; }
  let slotIdx = 0;
  for (const item of sel) {
    while (slotIdx < state.slots.length && state.slots[slotIdx] !== null) slotIdx++;
    if (slotIdx >= state.slots.length) { setStatus('No free slots available', false, 'warn'); break; }
    assignToSlot(item.id, slotIdx);
    slotIdx++;
  }
  renderSlotGrid();
  updateMemGauge();
});
dom.btnSendAll.addEventListener('click', () => {
  const all = state.slots.map((_, i) => i).filter(i => state.slots[i] !== null);
  sendSDS(all);
});
dom.btnSendSelected.addEventListener('click', () => {
  sendSDS([...state.selectedSlotIndices]);
});
dom.btnAbortSend.addEventListener('click', () => { state.abortSend = true; });
document.getElementById('btnCancelProcess').addEventListener('click', () => {
  if (state.isSending) {
    // Cancel SDS transfer
    state.abortSend = true;
    setStatus('Transfer cancelled', false, 'warn');
    const ov = document.getElementById('procOverlay');
    if (ov) ov.classList.remove('active');
    dom.globalSpinner.className = 'spinner';
  } else {
    // Cancel processing — set flag and also dismiss any open modal
    // (root note modal may be open waiting for user input)
    state.abortProcess = true;
    setStatus('Processing cancelled', false, 'warn');
    // Close root note modal if open — simulate clicking Skip
    const rootModal = document.getElementById('rootNoteModal');
    if (rootModal && rootModal.classList.contains('open')) {
      rootModal.classList.remove('open');
      // Trigger the cancel handler so the Promise resolves(null)
      const cancelBtn = document.getElementById('btnRootCancel');
      if (cancelBtn) cancelBtn.click();
    }
    // Close loop type warning modal if open
    const batchModal = document.getElementById('batchConfirmModal');
    if (batchModal && batchModal.classList.contains('open')) {
      batchModal.classList.remove('open');
      const cancelBtn = document.getElementById('btnBatchCancel');
      if (cancelBtn) cancelBtn.click();
    }
    const ov = document.getElementById('procOverlay');
    if (ov) ov.classList.remove('active');
    dom.globalSpinner.className = 'spinner';
  }
});

// Source list action delegation
dom.sourceList.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = parseInt(btn.dataset.id);
  const action = btn.dataset.action;
  if (action === 'remove') {
    if (state.playingItemId === id) stopInlinePlayback();
    state.sourceFiles = state.sourceFiles.filter(f => f.id !== id);
    state.selectedSourceIds.delete(id);
    state.slots = state.slots.map(s => s === id ? null : s);
    renderSourceList();
    renderSlotGrid();
    updateMemGauge();
  } else if (action === 'play') {
    const item = state.sourceFiles.find(f => f.id === id);
    playItemInline(item);
  } else if (action === 'preview') {
    const item = state.sourceFiles.find(f => f.id === id);
    openPlayer(item);
  } else if (action === 'reprocess') {
    const item = state.sourceFiles.find(f => f.id === id);
    if (!item) return;
    if (state.playingItemId === item.id) stopInlinePlayback();
    item.processedBuffer = null; item.hqBuffer = null; item.pcm16 = null;
    item.syxData = null; item.sdsPackets = null; item.nameSysEx = null;
    item.status = 'idle'; item.error = null; item.overrideLoop = false;
    renderSourceItem(item);
    processItems([item]);
  }
});

// Player
dom.btnPlay.addEventListener('click', () => playAudio(false));
dom.btnPlayLoop.addEventListener('click', () => playAudio(true));
dom.btnStop.addEventListener('click', stopAudio);
dom.btnClosePlayer.addEventListener('click', () => {
  stopAudio();
  dom.playerModal.classList.remove('open');
});
dom.btnApplyLoop.addEventListener('click', () => {
  const item = state.playerItem;
  if (!item) return;
  item.loopStart = parseInt(dom.loopStart.value);
  item.loopEnd = parseInt(dom.loopEnd.value);
  item.hasLoop = dom.loopEnabled.checked;
  item.overrideLoop = true;
  // Rebuild WAV + SDS with new loop points
  if (item.pcm16) {
    item.processedBuffer = buildWAV(item.pcm16, item.processedSampleRate, item.processedChannels, 16,
      item.loopStart, item.loopEnd, item.hasLoop, item.rootNote);
    item.size = item.processedBuffer.byteLength;
    const slotIdx = state.slots.indexOf(item.id);
    if (slotIdx >= 0) rebuildSDS(item, slotIdx);
  }
  renderSourceItem(item);
  drawWaveform(item);
  updateMemGauge();
  setStatus(`Loop updated: ${item.loopStart}–${item.loopEnd} samples`);
});

// Nudge buttons
document.querySelectorAll('.nudge-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    const dir = parseInt(btn.dataset.dir);
    const input = document.getElementById(target);
    input.value = Math.max(0, parseInt(input.value) + dir);
    // Redraw waveform with new loop markers
    if (state.playerItem) {
      const tempItem = {
        ...state.playerItem,
        loopStart: parseInt(dom.loopStart.value),
        loopEnd: parseInt(dom.loopEnd.value),
        hasLoop: dom.loopEnabled.checked
      };
      drawWaveform(tempItem);
    }
  });
});

dom.loopStart.addEventListener('input', () => {
  if (state.playerItem) {
    const t = { ...state.playerItem, loopStart: parseInt(dom.loopStart.value), loopEnd: parseInt(dom.loopEnd.value), hasLoop: dom.loopEnabled.checked };
    drawWaveform(t);
  }
});
dom.loopEnd.addEventListener('input', () => {
  if (state.playerItem) {
    const t = { ...state.playerItem, loopStart: parseInt(dom.loopStart.value), loopEnd: parseInt(dom.loopEnd.value), hasLoop: dom.loopEnabled.checked };
    drawWaveform(t);
  }
});
dom.loopEnabled.addEventListener('change', () => {
  if (state.playerItem) {
    const t = { ...state.playerItem, loopStart: parseInt(dom.loopStart.value), loopEnd: parseInt(dom.loopEnd.value), hasLoop: dom.loopEnabled.checked };
    drawWaveform(t);
  }
});

// Waveform click = set playback position (visual only)
dom.waveform.addEventListener('click', e => {
  if (!state.playerItem?.pcm16) return;
  const rect = dom.waveform.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  const sample = Math.round(frac * state.playerItem.pcm16.length);
  // Set loop start to clicked position as convenience
  dom.loopStart.value = sample;
  const t = { ...state.playerItem, loopStart: sample, loopEnd: parseInt(dom.loopEnd.value), hasLoop: dom.loopEnabled.checked };
  drawWaveform(t);
});

// ---- SDS EXPERIMENT LAB ----
function enc3(v) {
  return [v & 0x7F, (v >> 7) & 0x7F, (v >> 14) & 0x7F];
}

function buildExpHeader(slot, totalSamples, sampleRate, loopStart, loopEnd, loopType) {
  const sn = slot & 0x7FFF;
  const period = Math.round(1e9 / sampleRate);
  return new Uint8Array([
    0xF0, 0x7E, SDS.DEVICE_ID, 0x01,
    sn & 0x7F, (sn >> 7) & 0x7F,
    16,
    ...enc3(period),
    ...enc3(totalSamples),
    ...enc3(loopStart),
    ...enc3(loopEnd),
    loopType & 0x7F,
    0xF7
  ]);
}

function updateExpPreview() {
  const slot = parseInt(document.getElementById('expSlot').value);
  const totalSmp = parseInt(document.getElementById('expTotalSamples').value) || 0;
  const sr = parseInt(document.getElementById('expSampleRate').value) || 44100;
  const ls = parseInt(document.getElementById('expLoopStart').value) || 0;
  const le = parseInt(document.getElementById('expLoopEnd').value) || 0;
  const loopType = parseInt(document.getElementById('expLoopType').value) || 0x7F;
  const srcId = document.getElementById('expPcmSource').value;

  const header = buildExpHeader(slot, totalSmp, sr, ls, le, loopType);
  const hex = Array.from(header).map(b => b.toString(16).padStart(2, '0').toUpperCase());

  // Colour the meaningful bytes
  const labels = ['F0', '7E', 'dev', '01', 'sn_lo', 'sn_hi', 'bits',
    'per_lo', 'per_mi', 'per_hi',
    'len_lo', 'len_mi', 'len_hi',
    'ls_lo', 'ls_mi', 'ls_hi',
    'le_lo', 'le_mi', 'le_hi',
    'type', 'F7'];
  const coloured = hex.map((b, i) => {
    const tip = labels[i] || '';
    if ([0, 20].includes(i)) return `<span style="color:var(--text-dim)">${b}</span>`;
    if ([3].includes(i)) return `<span style="color:var(--text-secondary)">${b}</span>`;
    if ([10, 11, 12].includes(i)) return `<span class="hdr-byte" style="color:var(--red)">${b}·${tip}</span>`;
    if ([13, 14, 15, 16, 17, 18, 19].includes(i)) return `<span class="hdr-byte">${b}·${tip}</span>`;
    return `<span style="color:var(--text-primary)">${b}</span>`;
  });
  document.getElementById('expHexPreview').innerHTML = coloured.join(' ');

  // Info note
  const item = srcId ? state.sourceFiles.find(f => f.id === parseInt(srcId)) : null;
  const actualSamples = item?.pcm16?.length || 0;
  const actualPackets = item ? Math.ceil(actualSamples / 40) : 0;
  const diff = totalSmp - actualSamples;
  let note = '';
  if (!item) {
    note = 'No PCM source selected — header only will be sent.';
  } else {
    note = `PCM: "${item.name}" — ${actualSamples} samples, ${actualPackets} packets.
`;
    if (diff > 0) note += `⚠ Header claims ${diff} MORE samples than data → MD reads ${diff} samples past end into adjacent RAM.`;
    if (diff < 0) note += `⚠ Header claims ${Math.abs(diff)} FEWER samples than data → MD closes buffer early, ignores last ${Math.abs(diff)} samples.`;
    if (diff === 0) note += `✓ Header matches actual data length.`;
    if (le > totalSmp) note += `
⚠ loopEnd (${le}) > totalSamples (${totalSmp}) → MD loop pointer extends past declared length.`;
  }
  document.getElementById('expNote').textContent = note;
}

function populateExpDropdowns() {
  const slotSel = document.getElementById('expSlot');
  const pcmSel = document.getElementById('expPcmSource');
  const cfg = getHWConfig();

  slotSel.innerHTML = '';
  for (let i = 0; i < cfg.slots; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    const sid = state.slots[i];
    const item = sid ? state.sourceFiles.find(f => f.id === sid) : null;
    const name = item ? (item.customName || item.name.replace(/\.wav$/i, '').substring(0, 4).toUpperCase()) : '—';
    opt.textContent = `${String(i + 1).padStart(2, '0')}  ${name}`;
    slotSel.appendChild(opt);
  }

  pcmSel.innerHTML = '<option value="">— No PCM (header only) —</option>';
  state.sourceFiles.filter(f => f.status === 'done').forEach(item => {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = `${item.name.substring(0, 24)} (${fmtBytes(item.pcm16?.byteLength || 0)})`;
    pcmSel.appendChild(opt);
  });

  // Auto-fill from selected slot
  const firstOccupied = state.slots.findIndex(s => s !== null);
  if (firstOccupied >= 0) {
    slotSel.value = firstOccupied;
    const sid = state.slots[firstOccupied];
    if (sid) {
      const item = state.sourceFiles.find(f => f.id === sid);
      if (item) {
        pcmSel.value = sid;
        document.getElementById('expTotalSamples').value = item.pcm16?.length || 0;
        document.getElementById('expSampleRate').value = item.processedSampleRate || 44100;
        document.getElementById('expLoopStart').value = item.loopStart || 0;
        document.getElementById('expLoopEnd').value = item.loopEnd || 0;
        document.getElementById('expLoopType').value = item.hasLoop ? '0x00' : '0x7F';
      }
    }
  }
  updateExpPreview();
}

// Auto-fill fields when slot selection changes
document.getElementById('expSlot').addEventListener('change', function () {
  const sid = state.slots[parseInt(this.value)];
  if (sid) {
    const item = state.sourceFiles.find(f => f.id === sid);
    if (item && item.pcm16) {
      document.getElementById('expPcmSource').value = sid;
      document.getElementById('expTotalSamples').value = item.pcm16.length;
      document.getElementById('expSampleRate').value = item.processedSampleRate || 44100;
      document.getElementById('expLoopStart').value = item.loopStart || 0;
      document.getElementById('expLoopEnd').value = item.loopEnd || 0;
      document.getElementById('expLoopType').value = item.hasLoop ? '0x00' : '0x7F';
    }
  }
  updateExpPreview();
});

// Update preview when any field changes
['expPcmSource', 'expTotalSamples', 'expSampleRate', 'expLoopStart', 'expLoopEnd', 'expLoopType', 'expHandshake']
  .forEach(id => document.getElementById(id).addEventListener('input', updateExpPreview));

document.getElementById('btnExpPreview').addEventListener('click', updateExpPreview);

document.getElementById('btnOpenExpModal').addEventListener('click', () => {
  populateExpDropdowns();
  document.getElementById('sdsExpModal').classList.add('open');
});
document.getElementById('btnExpClose').addEventListener('click', () => {
  document.getElementById('sdsExpModal').classList.remove('open');
});

document.getElementById('btnExpSend').addEventListener('click', async () => {
  if (!state.midiOutput) { setStatus('Select a MIDI port in Settings first', false, 'warn'); return; }

  const slot = parseInt(document.getElementById('expSlot').value);
  const totalSmp = parseInt(document.getElementById('expTotalSamples').value) || 0;
  const sr = parseInt(document.getElementById('expSampleRate').value) || 44100;
  const ls = parseInt(document.getElementById('expLoopStart').value) || 0;
  const le = parseInt(document.getElementById('expLoopEnd').value) || 0;
  const loopType = parseInt(document.getElementById('expLoopType').value) || 0x7F;
  const srcId = document.getElementById('expPcmSource').value;
  const closedLoop = document.getElementById('expHandshake').value === 'closed';
  const turbo = parseInt(dom.turboSpeed.value) || 1;
  const delay = Math.round(SDS.PACKET_DELAY_MS / turbo);

  const item = srcId ? state.sourceFiles.find(f => f.id === parseInt(srcId)) : null;

  setStatus(`[LAB] Sending experiment to slot ${slot + 1}…`, true);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // 1. Send dump header with user-specified (possibly corrupted) values
  const header = buildExpHeader(slot, totalSmp, sr, ls, le, loopType);
  state.midiOutput.send(header);
  await new Promise(r => setTimeout(r, delay));

  if (closedLoop) {
    const ack = await waitForACK(slot, 0, 1000);
    setStatus(`[LAB] Header ACK: ${ack}`, false, ack === 'ack' ? 'ok' : 'warn');
    await new Promise(r => setTimeout(r, delay));
  }

  // 2. Send actual PCM data packets (if source selected)
  if (item?.pcm16) {
    const nameStr = item.customName || item.name.replace(/\.wav$/i, '');
    const packets = buildSDS(slot, item.pcm16, item.processedSampleRate || sr,
      item.processedChannels || 1, ls, le, loopType === 0x00, nameStr);
    const dataPackets = packets.filter(p => p.type === 'data');

    for (let i = 0; i < dataPackets.length; i++) {
      const pkt = dataPackets[i];
      state.midiOutput.send(pkt.data);
      if (closedLoop) {
        const ack = await waitForACK(slot, pkt.pktNum, 500);
        if (ack === 'nak') state.midiOutput.send(pkt.data);
      } else {
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // 3. Name SysEx last
  const nameStr = item?.customName || item?.name?.replace(/\.wav$/i, '') || 'EXP';
  state.midiOutput.send(buildNameSysEx(slot, nameStr));
  await new Promise(r => setTimeout(r, delay));

  setSpinner(false);
  setStatus(`[LAB] Experiment sent to slot ${slot + 1} — totalSamples=${totalSmp} ls=${ls} le=${le} type=0x${loopType.toString(16).toUpperCase()}`, false, 'ok');
});

// ---- SETTINGS MODAL ----
function openSettingsModal() {
  populateMIDIPorts();
  document.getElementById('settingsModal').classList.add('open');
}
document.getElementById('btnOpenSettings').addEventListener('click', openSettingsModal);
document.getElementById('btnCloseSettings').addEventListener('click', () => {
  document.getElementById('settingsModal').classList.remove('open');
});
// Footer gauge and midi status also open Settings
document.getElementById('footerMemGauge').addEventListener('click', openSettingsModal);
document.getElementById('footerMidiStatus').addEventListener('click', openSettingsModal);

// ============================================================
// SECTION 19: INIT
// ============================================================
initSlots();
initMIDI();
setStatus('Ready — drop WAV files to begin');