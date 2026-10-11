/**
 * Speaking detection on a local microphone, the way hark (SimpleWebRTC's detector) does it: the
 * loudest frequency bin in decibels, compared with a threshold, smoothed over a short history.
 * Only the local stream is tapped; tapping a remote WebRTC stream with Web Audio clicks on iOS.
 */
export interface SpeechMeter {
  /** 0 to 1 energy above the threshold, 0 in silence. */
  level: () => number;
  /** The loudest recent reading in dBFS, for diagnostics. */
  peakDb: () => number;
  close: () => void;
}

const THRESHOLD_DB = -50;
const CEILING_DB = -15;
const HISTORY = 6;

export function speechMeter(stream: MediaStream, context: AudioContext = new AudioContext()): SpeechMeter {
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.1;
  context.createMediaStreamSource(stream).connect(analyser);
  const bins = new Float32Array(analyser.frequencyBinCount);
  const history: number[] = [];
  let peak = -Infinity;
  if (context.state === "suspended") {
    void context.resume();
  }
  return {
    level: () => {
      const db = loudestBin(analyser, bins);
      history.push(db);
      if (history.length > HISTORY) {
        history.shift();
      }
      peak = Math.max(peak, db);
      // Speech when most recent readings cleared the threshold, like hark's speakingHistory vote
      const votes = history.filter((d) => d > THRESHOLD_DB).length;
      if (votes < Math.ceil(HISTORY / 2)) {
        return 0;
      }
      const recent = Math.max(...history);
      return Math.min(1, Math.max(0, (recent - THRESHOLD_DB) / (CEILING_DB - THRESHOLD_DB)));
    },
    peakDb: () => peak,
    close: () => {
      void context.close();
    },
  };
}

function loudestBin(analyser: AnalyserNode, bins: Float32Array): number {
  analyser.getFloatFrequencyData(bins);
  let loudest = -Infinity;
  for (const db of bins) {
    if (db > loudest && Number.isFinite(db)) {
      loudest = db;
    }
  }
  return loudest;
}

/** Pure form of the vote and scaling, for tests. */
export function levelFromHistory(history: number[]): number {
  const votes = history.filter((d) => d > THRESHOLD_DB).length;
  if (votes < Math.ceil(HISTORY / 2)) {
    return 0;
  }
  return Math.min(1, Math.max(0, (Math.max(...history) - THRESHOLD_DB) / (CEILING_DB - THRESHOLD_DB)));
}
