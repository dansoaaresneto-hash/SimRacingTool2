import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Map, Layers, ChevronLeft, ChevronRight, Star, Clock,
  TrendingDown, TrendingUp, Minus, Activity, Target, Zap, RotateCcw
} from 'lucide-react';
import { TelemetryData, RecordedLap, LapFrame, HeatmapChannel, ZoneFeedback, AnalysisZone } from '../types/telemetry';
import { ai } from '../lib/gemini';

// ─── Constantes ────────────────────────────────────────────────────────────────

const NUM_BUCKETS = 500; // resolução do mapa
const MIN_FRAMES_FOR_LAP = 80;

const ZONE_COLORS: Record<string, string> = {
  BRAKING: '#ef4444',
  ENTRY:   '#f97316',
  APEX:    '#eab308',
  EXIT:    '#22c55e',
};

const HEATMAP_LABELS: Record<HeatmapChannel, string> = {
  speed:    'Velocidade',
  throttle: 'Acelerador',
  brake:    'Freio',
  gLat:     'G Lateral',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatLapTime(s: number): string {
  if (s <= 0) return '--:--.---';
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(3);
  return `${m}:${sec.padStart(6, '0')}`;
}

function parseLapTime(str: string): number {
  if (!str || str === '--:--.---') return 0;
  const [m, s] = str.split(':');
  return parseFloat(m) * 60 + parseFloat(s);
}

function heatColor(value: number, channel: HeatmapChannel): string {
  // value já normalizado 0-1
  if (channel === 'speed') {
    // azul → verde → amarelo → vermelho (velocidade alta = vermelho)
    const r = Math.round(value > 0.5 ? 255 : value * 2 * 255);
    const g = Math.round(value < 0.5 ? value * 2 * 255 : (1 - value) * 2 * 255);
    const b = Math.round(value < 0.3 ? (1 - value / 0.3) * 200 : 0);
    return `rgb(${r},${g},${b})`;
  }
  if (channel === 'brake') {
    // cinza → vermelho
    const r = 80 + Math.round(value * 175);
    const g = Math.round(80 * (1 - value));
    return `rgb(${r},${g},60)`;
  }
  if (channel === 'throttle') {
    // cinza → verde
    const g = 80 + Math.round(value * 175);
    const r = Math.round(80 * (1 - value));
    return `rgb(${r},${g},60)`;
  }
  // gLat: roxo (esq) → cinza → laranja (dir)
  const abs = Math.abs(value - 0.5) * 2;
  if (value < 0.5) return `rgb(${Math.round(80 + abs * 80)},60,${Math.round(60 + abs * 180)})`;
  return `rgb(${Math.round(60 + abs * 195)},${Math.round(100 * (1 - abs))},60)`;
}

// Normaliza array de LapFrames por bucket (lap_dist_pct)
function bucketize(frames: LapFrame[]): (LapFrame | null)[] {
  const buckets: { sum: LapFrame; count: number }[] = Array.from({ length: NUM_BUCKETS }, () => ({
    count: 0,
    sum: { lap_dist_pct: 0, pos_x: 0, pos_z: 0, speed: 0, throttle: 0, brake: 0, gLat: 0, steering: 0, rpm: 0, gear: 0 },
  }));

  for (const f of frames) {
    const idx = Math.min(Math.floor((f.lap_dist_pct / 100) * NUM_BUCKETS), NUM_BUCKETS - 1);
    const b = buckets[idx];
    b.count++;
    b.sum.pos_x   += f.pos_x;
    b.sum.pos_z   += f.pos_z;
    b.sum.speed    += f.speed;
    b.sum.throttle += f.throttle;
    b.sum.brake    += f.brake;
    b.sum.gLat     += f.gLat;
    b.sum.steering += f.steering;
    b.sum.rpm      += f.rpm;
    b.sum.gear     += f.gear;
    b.sum.lap_dist_pct += f.lap_dist_pct;
  }

  return buckets.map(b =>
    b.count > 0
      ? {
          lap_dist_pct: b.sum.lap_dist_pct / b.count,
          pos_x:   b.sum.pos_x   / b.count,
          pos_z:   b.sum.pos_z   / b.count,
          speed:   b.sum.speed   / b.count,
          throttle:b.sum.throttle/ b.count,
          brake:   b.sum.brake   / b.count,
          gLat:    b.sum.gLat    / b.count,
          steering:b.sum.steering/ b.count,
          rpm:     b.sum.rpm     / b.count,
          gear:    b.sum.gear    / b.count,
        }
      : null
  );
}

// Detecta a zona de uma posição na pista (heurística por inputs)
function detectZone(frame: LapFrame): AnalysisZone {
  if (frame.brake > 15) return 'BRAKING';
  if (Math.abs(frame.gLat) > 1.5 && frame.throttle < 30) return 'APEX';
  if (Math.abs(frame.gLat) > 0.8 && frame.throttle < 60) return 'ENTRY';
  return 'EXIT';
}

// ─── Componente de Canvas de Traçado ─────────────────────────────────────────

function TrackCanvas({
  myLap,
  refLap,
  channel,
  cursorPct,
  onCursorMove,
  feedbackPoints,
  activeFeedbackIdx,
  onFeedbackClick,
}: {
  myLap: (LapFrame | null)[];
  refLap: (LapFrame | null)[];
  channel: HeatmapChannel | 'racing_line';
  cursorPct: number;
  onCursorMove: (pct: number) => void;
  feedbackPoints: { pct: number; zone: AnalysisZone; text: string; severity: string }[];
  activeFeedbackIdx: number;
  onFeedbackClick: (idx: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const myBuckets  = myLap;
  const refBuckets = refLap;

  // Pré-computa transform
  const transform = useMemo(() => {
    const allPts = [...myBuckets, ...refBuckets].filter(Boolean) as LapFrame[];
    if (allPts.length < 2) return null;
    const xs = allPts.map(p => p.pos_x);
    const zs = allPts.map(p => p.pos_z);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const rangeX = maxX - minX || 1;
    const rangeZ = maxZ - minZ || 1;
    const pad = 40;
    const W = 700, H = 620;
    const scale = Math.min((W - pad * 2) / rangeX, (H - pad * 2) / rangeZ);
    const offX = (W - rangeX * scale) / 2;
    const offY = (H - rangeZ * scale) / 2;
    return {
      toCanvas: (x: number, z: number) => ({
        x: offX + (x - minX) * scale,
        y: offY + (z - minZ) * scale,
      }),
      toPct: (cx: number, cy: number) => {
        // Encontra o bucket mais próximo
        let best = 0, bestDist = Infinity;
        for (let i = 0; i < myBuckets.length; i++) {
          const b = myBuckets[i];
          if (!b) continue;
          const p = { x: offX + (b.pos_x - minX) * scale, y: offY + (b.pos_z - minZ) * scale };
          const d = Math.hypot(cx - p.x, cy - p.y);
          if (d < bestDist) { bestDist = d; best = i; }
        }
        return (best / NUM_BUCKETS) * 100;
      },
    };
  }, [myBuckets, refBuckets]);

  // Normaliza valores para heatmap
  const heatValues = useMemo(() => {
    if (channel === 'racing_line') return null;
    const vals = myBuckets.map(b => b ? b[channel] : null);
    const valid = vals.filter(v => v !== null) as number[];
    if (!valid.length) return null;
    const min = Math.min(...valid), max = Math.max(...valid);
    const range = max - min || 1;
    return vals.map(v => v !== null ? (v - min) / range : null);
  }, [myBuckets, channel]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !transform) return;
    const ctx = canvas.getContext('2d')!;
    const { toCanvas } = transform;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const drawLine = (buckets: (LapFrame | null)[], color: string, width: number, dash: number[] = []) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash(dash);
      let started = false;
      for (const b of buckets) {
        if (!b) { started = false; continue; }
        const p = toCanvas(b.pos_x, b.pos_z);
        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };

    if (channel === 'racing_line') {
      // ── Modo comparação de traçado ───────────────────────────────────────────

      // Fundo de pista (espessura)
      drawLine(myBuckets, '#1e1e1e', 18);

      // Referência (linha ideal) — tracejada verde-azul
      if (refBuckets.some(Boolean)) {
        drawLine(refBuckets, 'rgba(59,130,246,0.25)', 14);
        drawLine(refBuckets, 'rgba(59,130,246,0.7)', 2, [6, 4]);
      }

      // Minha volta — colorida por zona
      let started = false;
      for (let i = 0; i < myBuckets.length; i++) {
        const b = myBuckets[i];
        if (!b) { started = false; continue; }
        const zone = detectZone(b);
        const col = ZONE_COLORS[zone] + 'cc';
        const p = toCanvas(b.pos_x, b.pos_z);
        if (!started) {
          ctx.beginPath();
          ctx.strokeStyle = col;
          ctx.lineWidth = 4;
          ctx.lineCap = 'round';
          ctx.moveTo(p.x, p.y);
          started = true;
        } else {
          const prev = myBuckets[i - 1];
          if (prev) {
            ctx.beginPath();
            ctx.strokeStyle = col;
            ctx.lineWidth = 4;
            ctx.lineCap = 'round';
            const pp = toCanvas(prev.pos_x, prev.pos_z);
            ctx.moveTo(pp.x, pp.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
          }
        }
      }
    } else {
      // ── Modo heatmap ─────────────────────────────────────────────────────────
      drawLine(myBuckets, '#1a1a1a', 18);

      if (heatValues) {
        for (let i = 1; i < myBuckets.length; i++) {
          const a = myBuckets[i - 1], b2 = myBuckets[i];
          const va = heatValues[i - 1], vb = heatValues[i];
          if (!a || !b2 || va === null || vb === null) continue;
          const pa = toCanvas(a.pos_x, a.pos_z);
          const pb = toCanvas(b2.pos_x, b2.pos_z);
          ctx.beginPath();
          ctx.strokeStyle = heatColor((va + vb) / 2, channel);
          ctx.lineWidth = 7;
          ctx.lineCap = 'round';
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
      }
    }

    // ── Cursor de posição ──────────────────────────────────────────────────────
    const cursorIdx = Math.min(Math.floor((cursorPct / 100) * NUM_BUCKETS), NUM_BUCKETS - 1);
    const cursorBucket = myBuckets[cursorIdx];
    if (cursorBucket) {
      const cp = toCanvas(cursorBucket.pos_x, cursorBucket.pos_z);
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.arc(cp.x, cp.y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = '#ffffff';
      ctx.arc(cp.x, cp.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // ── Pins de feedback ───────────────────────────────────────────────────────
    feedbackPoints.forEach((fp, i) => {
      const idx = Math.min(Math.floor((fp.pct / 100) * NUM_BUCKETS), NUM_BUCKETS - 1);
      const b = myBuckets[idx];
      if (!b) return;
      const p = toCanvas(b.pos_x, b.pos_z);
      const isActive = i === activeFeedbackIdx;
      const col = ZONE_COLORS[fp.zone];

      ctx.beginPath();
      ctx.fillStyle = isActive ? col : col + '99';
      ctx.arc(p.x, p.y, isActive ? 9 : 6, 0, Math.PI * 2);
      ctx.fill();
      if (isActive) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    });

    // ── Linha de largada ───────────────────────────────────────────────────────
    const startB = myBuckets[0];
    if (startB) {
      const sp = toCanvas(startB.pos_x, startB.pos_z);
      ctx.beginPath();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [myBuckets, refBuckets, channel, heatValues, transform, cursorPct, feedbackPoints, activeFeedbackIdx]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!transform || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = canvasRef.current.width  / rect.width;
    const sy = canvasRef.current.height / rect.height;
    const cx = (e.clientX - rect.left) * sx;
    const cy = (e.clientY - rect.top)  * sy;
    onCursorMove(transform.toPct(cx, cy));
  }, [transform, onCursorMove]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!transform || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = canvasRef.current.width  / rect.width;
    const sy = canvasRef.current.height / rect.height;
    const cx = (e.clientX - rect.left) * sx;
    const cy = (e.clientY - rect.top)  * sy;
    const pct = transform.toPct(cx, cy);
    // Encontra feedback mais próximo
    let best = -1, bestDist = 8; // 8% de tolerância
    feedbackPoints.forEach((fp, i) => {
      const d = Math.abs(fp.pct - pct);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    if (best >= 0) onFeedbackClick(best);
  }, [transform, feedbackPoints, onFeedbackClick]);

  return (
    <canvas
      ref={canvasRef}
      width={700}
      height={620}
      onMouseMove={handleMouseMove}
      onClick={handleClick}
      className="w-full h-full object-contain cursor-crosshair"
    />
  );
}

// ─── Componente Principal ─────────────────────────────────────────────────────

interface TrackAnalysisProps {
  telemetry: TelemetryData | null;
  laps: { number: number; time: number; timeStr: string }[];
  onClose: () => void;
}

export function TrackAnalysis({ telemetry, laps, onClose }: TrackAnalysisProps) {
  // Estado de gravação de voltas
  const [recordedLaps, setRecordedLaps]   = useState<RecordedLap[]>([]);
  const [refLapIdx, setRefLapIdx]         = useState<number | null>(null);
  const [myLapIdx, setMyLapIdx]           = useState<number | null>(null);
  const [isRecording, setIsRecording]     = useState(true);

  // Estado da UI de análise
  const [channel, setChannel]             = useState<HeatmapChannel | 'racing_line'>('racing_line');
  const [cursorPct, setCursorPct]         = useState(0);
  const [activeFeedbackIdx, setActiveFeedbackIdx] = useState(0);
  const [zoneFeedbacks, setZoneFeedbacks] = useState<ZoneFeedback[]>([]);
  const [isAnalyzing, setIsAnalyzing]     = useState(false);
  const [activeZone, setActiveZone]       = useState<AnalysisZone | null>(null);

  // Buffer de gravação
  const currentFrames = useRef<LapFrame[]>([]);
  const lastLapNum    = useRef(-1);
  const lastDistRef   = useRef(-1);
  const recStarted    = useRef(false);

  // ── Grava frames da telemetria em tempo real ──────────────────────────────
  useEffect(() => {
    if (!telemetry || !isRecording) return;
    const { pos_x, pos_z, speed, throttle, brake, gLat, steering, rpm, gear, lap_dist_pct, inPits, lapNumber } = telemetry;

    if (inPits) return;

    const crossedFinish = lastDistRef.current > 90 && lap_dist_pct < 10;

    if (crossedFinish && recStarted.current && currentFrames.current.length > MIN_FRAMES_FOR_LAP) {
      // Volta completa — salva
      const lapTimeNum = parseLapTime(telemetry.lastLapTime);
      if (lapTimeNum > 0) {
        const newLap: RecordedLap = {
          lapNumber: lapNumber - 1,
          lapTime: lapTimeNum,
          lapTimeStr: telemetry.lastLapTime,
          trackName: telemetry.trackName,
          frames: [...currentFrames.current],
          sectors: [...telemetry.sectors],
          isReference: false,
        };
        setRecordedLaps(prev => {
          const updated = [...prev, newLap];
          // Auto-seleciona: ref = mais rápida, minha = última
          const fastestIdx = updated.reduce((bi, l, i) => l.lapTime < updated[bi].lapTime ? i : bi, 0);
          setRefLapIdx(fastestIdx);
          setMyLapIdx(updated.length - 1);
          return updated;
        });
      }
      currentFrames.current = [];
      recStarted.current = false;
    }

    if (crossedFinish || lastDistRef.current < 0) {
      recStarted.current = true;
      currentFrames.current = [];
    }

    lastDistRef.current = lap_dist_pct;
    lastLapNum.current  = lapNumber;

    if (!recStarted.current) return;

    currentFrames.current.push({ lap_dist_pct, pos_x, pos_z, speed, throttle, brake, gLat, steering, rpm, gear });
  }, [telemetry, isRecording]);

  // ── Voltas preparadas para o canvas ──────────────────────────────────────
  const myBuckets  = useMemo(() => myLapIdx  !== null ? bucketize(recordedLaps[myLapIdx].frames)  : [], [recordedLaps, myLapIdx]);
  const refBuckets = useMemo(() => refLapIdx !== null ? bucketize(recordedLaps[refLapIdx].frames) : [], [recordedLaps, refLapIdx]);

  // ── Frame atual sob o cursor ──────────────────────────────────────────────
  const cursorFrame = useMemo(() => {
    const idx = Math.min(Math.floor((cursorPct / 100) * NUM_BUCKETS), NUM_BUCKETS - 1);
    return myBuckets[idx] ?? null;
  }, [myBuckets, cursorPct]);

  const cursorRefFrame = useMemo(() => {
    const idx = Math.min(Math.floor((cursorPct / 100) * NUM_BUCKETS), NUM_BUCKETS - 1);
    return refBuckets[idx] ?? null;
  }, [refBuckets, cursorPct]);

  // ── Pins de feedback no mapa ──────────────────────────────────────────────
  const feedbackPins = useMemo(() =>
    zoneFeedbacks.map(zf => {
      // Encontra o bucket de maior freio / g lateral / etc. para a zona
      const targetChannel: Record<AnalysisZone, keyof LapFrame> = {
        BRAKING: 'brake', ENTRY: 'gLat', APEX: 'gLat', EXIT: 'throttle',
      };
      const ch = targetChannel[zf.zone];
      let best = 0, bestVal = -Infinity;
      myBuckets.forEach((b, i) => {
        if (!b) return;
        const zone = detectZone(b);
        if (zone !== zf.zone) return;
        const v = Math.abs(b[ch] as number);
        if (v > bestVal) { bestVal = v; best = i; }
      });
      return { pct: (best / NUM_BUCKETS) * 100, zone: zf.zone, text: zf.text, severity: zf.severity };
    }),
    [zoneFeedbacks, myBuckets]
  );

  // ── Delta de setores ──────────────────────────────────────────────────────
  const sectorDeltas = useMemo(() => {
    if (myLapIdx === null || refLapIdx === null) return [];
    const my  = recordedLaps[myLapIdx].sectors;
    const ref = recordedLaps[refLapIdx].sectors;
    return [0, 1, 2].map(i => my[i] > 0 && ref[i] > 0 ? my[i] - ref[i] : null);
  }, [recordedLaps, myLapIdx, refLapIdx]);

  const totalDelta = useMemo(() => {
    if (myLapIdx === null || refLapIdx === null) return null;
    return recordedLaps[myLapIdx].lapTime - recordedLaps[refLapIdx].lapTime;
  }, [recordedLaps, myLapIdx, refLapIdx]);

  // ── Análise de IA por zona ─────────────────────────────────────────────────
  async function analyzeZones() {
    if (!myBuckets.length || !refBuckets.length || isAnalyzing) return;
    setIsAnalyzing(true);
    setZoneFeedbacks([]);

    const zones: AnalysisZone[] = ['BRAKING', 'ENTRY', 'APEX', 'EXIT'];
    const results: ZoneFeedback[] = [];

    for (const zone of zones) {
      const myFrames  = myBuckets.filter(b => b && detectZone(b) === zone) as LapFrame[];
      const refFrames = refBuckets.filter(b => b && detectZone(b) === zone) as LapFrame[];
      if (!myFrames.length || !refFrames.length) continue;

      const avg = (arr: LapFrame[], key: keyof LapFrame) =>
        arr.reduce((s, f) => s + (f[key] as number), 0) / arr.length;

      const myStats  = { speed: avg(myFrames, 'speed'),  brake: avg(myFrames, 'brake'),  throttle: avg(myFrames, 'throttle'),  gLat: avg(myFrames, 'gLat') };
      const refStats = { speed: avg(refFrames, 'speed'), brake: avg(refFrames, 'brake'), throttle: avg(refFrames, 'throttle'), gLat: avg(refFrames, 'gLat') };

      const myLap  = myLapIdx  !== null ? recordedLaps[myLapIdx]  : null;
      const refLap = refLapIdx !== null ? recordedLaps[refLapIdx] : null;
      const lapDelta = myLap && refLap ? (myLap.lapTime - refLap.lapTime).toFixed(3) : '?';

      const prompt = `Zona: ${zone}
Minha telemetria:  velocidade média ${myStats.speed.toFixed(1)}km/h | freio ${myStats.brake.toFixed(0)}% | acelerador ${myStats.throttle.toFixed(0)}% | G lateral ${myStats.gLat.toFixed(2)}g
Referência:        velocidade média ${refStats.speed.toFixed(1)}km/h | freio ${refStats.brake.toFixed(0)}% | acelerador ${refStats.throttle.toFixed(0)}% | G lateral ${refStats.gLat.toFixed(2)}g
Delta de volta: ${lapDelta}s

Em 2 frases diretas em português, diga o que devo corrigir nessa zona específica de curva (${zone}). Foque no erro principal. Seja técnico e objetivo.`;

      try {
        const res = await ai.models.generateContent({
          model: 'gemini-2.0-flash',
          contents: prompt,
          config: {
            systemInstruction: `Você é o Aiden, coach de pilotagem de simuladores. Analise diferenças de telemetria entre o piloto e uma referência e dê feedback técnico em português, 2 frases máximo, direto ao ponto.`,
          },
        });

        const text = res.text?.trim() ?? '';
        const speedDiff = myStats.speed - refStats.speed;
        const delta = myLap && refLap ? (myLap.lapTime - refLap.lapTime) / 4 : 0;
        const severity: ZoneFeedback['severity'] =
          Math.abs(delta) < 0.05 ? 'positive' :
          Math.abs(delta) < 0.2  ? 'warning'  : 'critical';

        results.push({ zone, delta, text, severity });
      } catch (err) {
        results.push({ zone, delta: 0, text: 'Erro na análise desta zona.', severity: 'warning' });
      }
    }

    setZoneFeedbacks(results);
    if (results.length > 0) setActiveFeedbackIdx(0);
    setIsAnalyzing(false);
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────
  const deltaColor = (d: number | null) => {
    if (d === null) return 'text-white/30';
    if (d < -0.05) return 'text-green-400';
    if (d > 0.2)   return 'text-red-400';
    return 'text-yellow-400';
  };

  const deltaStr = (d: number | null) => {
    if (d === null) return '---';
    return (d > 0 ? '+' : '') + d.toFixed(3) + 's';
  };

  const zoneColor = (severity: string) => ({
    positive: 'border-green-500/40 bg-green-500/5',
    warning:  'border-yellow-500/40 bg-yellow-500/5',
    critical: 'border-red-500/40 bg-red-500/5',
  }[severity] ?? 'border-white/10 bg-white/5');

  const zoneTextColor = (severity: string) => ({
    positive: 'text-green-400',
    warning:  'text-yellow-400',
    critical: 'text-red-400',
  }[severity] ?? 'text-white/60');

  const noLaps = recordedLaps.length < 2;

  return (
    <div className="fixed inset-0 z-[150] bg-[#080808] flex flex-col overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-white/5 bg-black/60 backdrop-blur-md px-6 h-16 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-all"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-orange-500" />
            <span className="text-sm font-black uppercase tracking-widest">Análise de Traçado</span>
          </div>
          {telemetry?.trackName && (
            <span className="text-xs text-white/30 font-mono">· {telemetry.trackName}</span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Gravação */}
          <button
            onClick={() => setIsRecording(r => !r)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest transition-all border ${
              isRecording
                ? 'bg-red-500/10 border-red-500/30 text-red-400'
                : 'bg-white/5 border-white/10 text-white/40'
            }`}
          >
            <div className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-white/20'}`} />
            {isRecording ? 'Gravando' : 'Pausado'}
          </button>

          {/* Contador de voltas */}
          <div className="text-[11px] font-bold text-white/30 uppercase tracking-widest">
            {recordedLaps.length} volta{recordedLaps.length !== 1 ? 's' : ''}
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* ── Painel esquerdo: Feedbacks ───────────────────────────────────── */}
        <div className="w-[300px] shrink-0 border-r border-white/5 flex flex-col overflow-hidden">

          {/* Seletor de voltas */}
          <div className="p-4 border-b border-white/5 space-y-2">
            <div className="text-[9px] font-bold text-white/25 uppercase tracking-widest mb-2">Comparar Voltas</div>

            <div className="space-y-1.5">
              {/* Minha volta */}
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-orange-500 shrink-0" />
                <span className="text-[10px] text-white/40 w-12 shrink-0">Minha</span>
                <select
                  value={myLapIdx ?? ''}
                  onChange={e => setMyLapIdx(Number(e.target.value))}
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-white font-mono focus:outline-none focus:border-orange-500/50"
                >
                  {recordedLaps.map((l, i) => (
                    <option key={i} value={i}>#{l.lapNumber} — {l.lapTimeStr}</option>
                  ))}
                </select>
              </div>
              {/* Referência */}
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-blue-400 shrink-0" />
                <span className="text-[10px] text-white/40 w-12 shrink-0">Ref</span>
                <select
                  value={refLapIdx ?? ''}
                  onChange={e => setRefLapIdx(Number(e.target.value))}
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-white font-mono focus:outline-none focus:border-blue-500/50"
                >
                  {recordedLaps.map((l, i) => (
                    <option key={i} value={i}>#{l.lapNumber} — {l.lapTimeStr}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Delta total + setores */}
          <div className="p-4 border-b border-white/5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[9px] font-bold text-white/25 uppercase tracking-widest">Delta Total</span>
              <span className={`text-lg font-black font-mono ${deltaColor(totalDelta)}`}>
                {deltaStr(totalDelta)}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {[0, 1, 2].map(i => (
                <div key={i} className="bg-white/5 rounded-lg p-2 border border-white/5 text-center">
                  <div className="text-[8px] text-white/25 font-bold uppercase mb-1">S{i + 1}</div>
                  <div className={`text-xs font-mono font-bold ${deltaColor(sectorDeltas[i] ?? null)}`}>
                    {deltaStr(sectorDeltas[i] ?? null)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Botão de análise */}
          <div className="p-4 border-b border-white/5">
            <button
              onClick={analyzeZones}
              disabled={noLaps || isAnalyzing || myLapIdx === refLapIdx}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-30 disabled:cursor-not-allowed text-[11px] font-bold uppercase tracking-widest transition-all shadow-lg shadow-orange-600/20"
            >
              {isAnalyzing ? (
                <>
                  <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Analisando zonas...
                </>
              ) : (
                <>
                  <Target className="w-4 h-4" />
                  Analisar com IA
                </>
              )}
            </button>
            {noLaps && (
              <p className="text-[9px] text-white/20 text-center mt-2">
                Complete 2+ voltas para comparar
              </p>
            )}
          </div>

          {/* Lista de feedbacks por zona */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
            {zoneFeedbacks.length === 0 && !isAnalyzing && (
              <div className="text-center py-12">
                <Target className="w-8 h-8 text-white/10 mx-auto mb-3" />
                <p className="text-xs text-white/20 italic">
                  {noLaps
                    ? 'Aguardando voltas gravadas...'
                    : 'Clique em "Analisar com IA" para obter feedback por zona'}
                </p>
              </div>
            )}

            {isAnalyzing && (
              <div className="space-y-2">
                {(['BRAKING', 'ENTRY', 'APEX', 'EXIT'] as AnalysisZone[]).map(z => (
                  <div key={z} className="rounded-xl border border-white/5 p-3 animate-pulse">
                    <div className="h-3 bg-white/10 rounded w-16 mb-2" />
                    <div className="h-2 bg-white/5 rounded w-full mb-1" />
                    <div className="h-2 bg-white/5 rounded w-3/4" />
                  </div>
                ))}
              </div>
            )}

            <AnimatePresence>
              {zoneFeedbacks.map((zf, i) => (
                <motion.div
                  key={zf.zone}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.1 }}
                  onClick={() => setActiveFeedbackIdx(i)}
                  className={`rounded-xl border p-3 cursor-pointer transition-all ${
                    i === activeFeedbackIdx
                      ? zoneColor(zf.severity) + ' ring-1 ring-white/10'
                      : 'border-white/5 bg-white/2 hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ background: ZONE_COLORS[zf.zone] }}
                      />
                      <span
                        className="text-[10px] font-black uppercase tracking-widest"
                        style={{ color: ZONE_COLORS[zf.zone] }}
                      >
                        {zf.zone}
                      </span>
                    </div>
                    <span className={`text-[11px] font-mono font-bold ${zoneTextColor(zf.severity)}`}>
                      {zf.delta !== 0 ? deltaStr(zf.delta) : ''}
                    </span>
                  </div>
                  <p className="text-[11px] text-white/70 leading-relaxed">{zf.text}</p>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>

        {/* ── Centro: Mapa ──────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Toolbar de canais */}
          <div className="px-6 py-3 border-b border-white/5 flex items-center gap-2">
            {(['racing_line', 'speed', 'throttle', 'brake', 'gLat'] as const).map(ch => (
              <button
                key={ch}
                onClick={() => setChannel(ch)}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all border ${
                  channel === ch
                    ? 'bg-orange-500/20 border-orange-500/40 text-orange-400'
                    : 'bg-white/3 border-white/5 text-white/30 hover:text-white/60'
                }`}
              >
                {ch === 'racing_line' ? 'Traçado' : HEATMAP_LABELS[ch]}
              </button>
            ))}

            <div className="ml-auto flex items-center gap-3">
              {/* Legenda de zonas (só no modo traçado) */}
              {channel === 'racing_line' && (
                <div className="flex items-center gap-3">
                  {Object.entries(ZONE_COLORS).map(([z, c]) => (
                    <div key={z} className="flex items-center gap-1">
                      <div className="w-2 h-2 rounded-full" style={{ background: c }} />
                      <span className="text-[9px] text-white/30 font-bold">{z}</span>
                    </div>
                  ))}
                  <div className="flex items-center gap-1">
                    <div className="w-4 border-t-2 border-dashed border-blue-400/60" />
                    <span className="text-[9px] text-white/30 font-bold">REF</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Canvas */}
          <div className="flex-1 relative bg-[#0a0a0a]">
            {myBuckets.length > 10 ? (
              <TrackCanvas
                myLap={myBuckets}
                refLap={refBuckets}
                channel={channel}
                cursorPct={cursorPct}
                onCursorMove={setCursorPct}
                feedbackPoints={feedbackPins}
                activeFeedbackIdx={activeFeedbackIdx}
                onFeedbackClick={setActiveFeedbackIdx}
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                <Map className="w-12 h-12 text-white/10" />
                <div className="text-center">
                  <p className="text-white/30 text-sm font-bold">Aguardando dados de volta</p>
                  <p className="text-white/15 text-xs mt-1">
                    {isRecording ? 'Gravando — complete uma volta para ver o traçado' : 'Gravação pausada'}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Barra de progresso da pista */}
          <div className="px-6 py-3 border-t border-white/5 bg-black/30">
            <div
              className="h-1 bg-white/5 rounded-full cursor-pointer relative"
              onClick={e => {
                const rect = e.currentTarget.getBoundingClientRect();
                setCursorPct(((e.clientX - rect.left) / rect.width) * 100);
              }}
            >
              <div
                className="absolute top-0 left-0 h-full bg-orange-500/50 rounded-full"
                style={{ width: `${cursorPct}%` }}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-orange-500 rounded-full shadow-lg"
                style={{ left: `calc(${cursorPct}% - 6px)` }}
              />
            </div>
            <div className="flex justify-between text-[9px] text-white/20 mt-1">
              <span>S/F</span>
              <span>{cursorPct.toFixed(1)}%</span>
              <span>S/F</span>
            </div>
          </div>
        </div>

        {/* ── Painel direito: Telemetria do cursor ─────────────────────────── */}
        <div className="w-[220px] shrink-0 border-l border-white/5 flex flex-col overflow-y-auto">
          <div className="p-4 border-b border-white/5">
            <div className="text-[9px] font-bold text-white/25 uppercase tracking-widest mb-3">
              No cursor — {cursorPct.toFixed(1)}%
            </div>

            {cursorFrame ? (
              <div className="space-y-2">
                {[
                  { label: 'Velocidade', my: cursorFrame.speed.toFixed(0) + ' km/h', ref: cursorRefFrame?.speed.toFixed(0) + ' km/h', delta: cursorRefFrame ? cursorFrame.speed - cursorRefFrame.speed : null, unit: 'km/h', higherBetter: true },
                  { label: 'Acelerador', my: cursorFrame.throttle.toFixed(0) + '%',  ref: cursorRefFrame?.throttle.toFixed(0) + '%',  delta: cursorRefFrame ? cursorFrame.throttle - cursorRefFrame.throttle : null, unit: '%', higherBetter: true },
                  { label: 'Freio',      my: cursorFrame.brake.toFixed(0) + '%',     ref: cursorRefFrame?.brake.toFixed(0) + '%',     delta: cursorRefFrame ? cursorFrame.brake - cursorRefFrame.brake : null, unit: '%', higherBetter: false },
                  { label: 'G Lateral', my: cursorFrame.gLat.toFixed(2) + 'g',      ref: cursorRefFrame?.gLat.toFixed(2) + 'g',      delta: null, unit: 'g', higherBetter: false },
                  { label: 'Marcha',    my: String(Math.max(0, cursorFrame.gear - 1)), ref: cursorRefFrame ? String(Math.max(0, cursorRefFrame.gear - 1)) : '-', delta: null, unit: '', higherBetter: false },
                ].map(row => (
                  <div key={row.label} className="bg-white/3 rounded-lg p-2.5 border border-white/5">
                    <div className="text-[8px] text-white/25 uppercase font-bold mb-1">{row.label}</div>
                    <div className="flex items-end justify-between">
                      <span className="text-sm font-mono font-bold text-white">{row.my}</span>
                      {row.delta !== null && (
                        <span className={`text-[10px] font-mono font-bold ${
                          Math.abs(row.delta) < 1 ? 'text-white/30' :
                          (row.delta > 0) === row.higherBetter ? 'text-green-400' : 'text-red-400'
                        }`}>
                          {row.delta > 0 ? '+' : ''}{row.delta.toFixed(row.unit === 'g' ? 2 : 0)}{row.unit}
                        </span>
                      )}
                    </div>
                    {refLapIdx !== null && row.ref && (
                      <div className="text-[8px] text-white/20 mt-0.5">ref: {row.ref}</div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-white/20 italic">Passe o cursor sobre o mapa</p>
            )}
          </div>

          {/* Lista de voltas gravadas */}
          <div className="p-4 flex-1">
            <div className="text-[9px] font-bold text-white/25 uppercase tracking-widest mb-3">
              Voltas Gravadas
            </div>
            <div className="space-y-1.5">
              {recordedLaps.length === 0 && (
                <p className="text-[10px] text-white/20 italic">Nenhuma volta completa ainda</p>
              )}
              {recordedLaps.map((l, i) => {
                const isMy  = i === myLapIdx;
                const isRef = i === refLapIdx;
                const isBest = recordedLaps.every(other => other.lapTime >= l.lapTime);
                return (
                  <div
                    key={i}
                    className={`rounded-lg border px-2.5 py-2 flex items-center justify-between text-[10px] transition-all ${
                      isMy ? 'border-orange-500/30 bg-orange-500/5' :
                      isRef ? 'border-blue-500/30 bg-blue-500/5' :
                      'border-white/5 bg-white/3'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      {isBest && <Star className="w-2.5 h-2.5 text-yellow-400" />}
                      <span className="text-white/40 font-mono">#{l.lapNumber}</span>
                    </div>
                    <span className="font-mono font-bold text-white">{l.lapTimeStr}</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setMyLapIdx(i)}
                        className={`px-1.5 py-0.5 rounded text-[8px] font-bold ${isMy ? 'bg-orange-500/30 text-orange-400' : 'bg-white/5 text-white/20 hover:text-white/50'}`}
                      >MY</button>
                      <button
                        onClick={() => setRefLapIdx(i)}
                        className={`px-1.5 py-0.5 rounded text-[8px] font-bold ${isRef ? 'bg-blue-500/30 text-blue-400' : 'bg-white/5 text-white/20 hover:text-white/50'}`}
                      >REF</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
