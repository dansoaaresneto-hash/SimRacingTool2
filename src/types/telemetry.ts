export interface TelemetryData {
  fuel: number;
  fuelCapacity: number;
  tireWear: number[]; // [FL, FR, RL, RR]
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
  // Vetor frontal do carro (linha 0 da matriz mOri do rF2).
  // Fornecido pelo telemetry_bridge.py para cálculo da centerline.
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
}
