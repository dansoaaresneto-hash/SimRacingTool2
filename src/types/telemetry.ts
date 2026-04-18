export interface TelemetryData {
  fuel: number;
  fuelCapacity: number;
  tireWear: number[];
  tireTemp: number[];
  weather: string;
  position: number;
  gapAhead: number;
  gapBehind: number;
  lapTime: string;
  lastLapTime: string;
  bestLapTime: number;
  sectors: number[];
  trackPos: number;
  lapNumber: number;
  rpm: number;
  speed: number;
  gear: number;
  brake: number;
  throttle: number;
  steering: number;
  gLat: number;
  gLon: number;
  pos_x: number;
  pos_z: number;
  ori_x?: number;
  ori_z?: number;
  trackName: string;
  lap_dist_pct: number;
  place?: number;
  inPits?: boolean;
  trackTemp?: number;
  ambientTemp?: number;
}

export interface FeedbackPoint {
  text: string;
  x: number;
  z: number;
  type: 'positive' | 'correction' | 'critical';
  category: 'Frenagem' | 'Aceleração' | 'Traçado';
  lap_dist_pct: number;
}

export interface SessionData {
  id: string;
  timestamp: string;
  trackName: string;
  bestLap: { time: number, timeStr: string };
  totalLaps: number;
  consistency: { value: number, label: string, color: string };
  feedbacks: FeedbackPoint[];
  advice: string[];
  recordedLaps?: RecordedLap[];
}

// ── Tipos para o módulo de Análise de Traçado ─────────────────────────────────

export interface LapFrame {
  lap_dist_pct: number;  // 0-100
  pos_x: number;
  pos_z: number;
  speed: number;         // km/h
  throttle: number;      // 0-100
  brake: number;         // 0-100
  gLat: number;
  steering: number;
  rpm: number;
  gear: number;
}

export interface RecordedLap {
  lapNumber: number;
  lapTime: number;       // segundos
  lapTimeStr: string;
  trackName: string;
  frames: LapFrame[];
  sectors: number[];     // [s1, s2, s3] em segundos
  isReference: boolean;
}

export type HeatmapChannel = 'speed' | 'throttle' | 'brake' | 'gLat';

export type AnalysisZone = 'BRAKING' | 'ENTRY' | 'APEX' | 'EXIT';

export interface ZoneFeedback {
  zone: AnalysisZone;
  delta: number;         // segundos (positivo = mais lento que referência)
  text: string;
  severity: 'positive' | 'warning' | 'critical';
}
