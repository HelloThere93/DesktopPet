/**
 * Microphone capture and speech playback for voice mode.
 *
 * The realtime API speaks PCM16 at 24kHz, which no browser recorder produces
 * directly — MediaRecorder gives webm/opus. So audio is taken raw from the Web
 * Audio graph, downsampled, and converted by hand. Playback is the same in
 * reverse: chunks arrive faster than they play, so they are queued and
 * scheduled back-to-back rather than started on arrival, which would overlap
 * them into noise.
 */

const RATE = 24000;

function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Nearest-neighbour resample. Speech at 24k does not need better. */
function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = input[Math.floor(i * ratio)] ?? 0;
  return out;
}

export interface MicHandle {
  stop: () => void;
  /** 0..1, for the level meter. */
  level: () => number;
}

export async function startMic(
  deviceId: string,
  onChunk: (base64: string) => void,
): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const meter = new Uint8Array(analyser.frequencyBinCount);

  // ScriptProcessor is deprecated but is the one node that works without
  // shipping a separate worklet file, and this is a small fixed-size graph.
  const processor = ctx.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const resampled = downsample(input, ctx.sampleRate, RATE);
    const pcm = floatToPcm16(resampled);
    onChunk(toBase64(new Uint8Array(pcm.buffer)));
  };

  source.connect(analyser);
  source.connect(processor);
  // ScriptProcessor only runs while connected to a destination; a zero gain
  // keeps it alive without the user hearing themselves.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(ctx.destination);

  return {
    stop() {
      processor.disconnect();
      source.disconnect();
      mute.disconnect();
      for (const t of stream.getTracks()) t.stop();
      try {
        void ctx.close().catch(() => undefined);
      } catch {
        /* The context may already be closing; teardown remains best effort. */
      }
    },
    level() {
      analyser.getByteFrequencyData(meter);
      let sum = 0;
      for (const v of meter) sum += v;
      return Math.min(1, sum / meter.length / 96);
    },
  };
}

/** Queues and schedules speech so chunks play in sequence, not on top. */
export class SpeechPlayer {
  private ctx: AudioContext | null = null;
  private nextAt = 0;
  private sources = new Set<AudioBufferSourceNode>();

  play(base64: string): void {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: RATE });
    const ctx = this.ctx;

    const bytes = fromBase64(base64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    if (!pcm.length) return;

    const buffer = ctx.createBuffer(1, pcm.length, RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = (pcm[i] ?? 0) / 0x8000;

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);

    // Schedule after whatever is already queued, never before "now".
    const startAt = Math.max(ctx.currentTime, this.nextAt);
    node.start(startAt);
    this.nextAt = startAt + buffer.duration;

    this.sources.add(node);
    node.onended = () => this.sources.delete(node);
  }

  /** Cuts playback off immediately, for interrupting mid-sentence. */
  stop(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already finished */
      }
    }
    this.sources.clear();
    this.nextAt = 0;
  }

  get speaking(): boolean {
    return this.sources.size > 0;
  }
}

export async function listMicrophones(): Promise<{ id: string; label: string }[]> {
  try {
    // Labels are blank until permission has been granted at least once.
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch {
    return [];
  }
}
