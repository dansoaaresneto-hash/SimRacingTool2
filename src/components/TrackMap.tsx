import React, { useEffect, useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Map, RefreshCw, CheckCircle } from 'lucide-react';
import { TelemetryData, FeedbackPoint } from '../types/telemetry';

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface TrackPoint {
  x: number;
  z: number;
}

interface Bucket {
  sumX: number;
  sumZ: number;
  count: number;
}

interface SavedTrack {
  trackName: string;
  centerline: TrackPoint[];
  lapsAccumulated: number;
  savedAt: string;
}

// ─── Constantes ───────────────────────────────────────────────────────────────

// 500 buckets = 1 ponto a cada 0.2% da volta.
// Para Le Mans (~13.6 km) = ~27m por bucket.
const NUM_BUCKETS = 500;

// Voltas para convergência da centerline.
// Com 3+ voltas a média já estabiliza bem.
const LAPS_TO_CONVERGE = 3;

// Mínimo de amostras por bucket para o ponto ser válido.
const MIN_SAMPLES_PER_BUCKET = 2;

const STORAGE_KEY_PREFIX = 'racemind_track_v2_';

// ─── Helpers de storage ───────────────────────────────────────────────────────

function storageKey(trackName: string) {
  return STORAGE_KEY_PREFIX + trackName.toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
}

function loadTrack(trackName: string): SavedTrack | null {
  try {
    const raw = localStorage.getItem(storageKey(trackName));
    if (!raw) return null;
    const saved: SavedTrack = JSON.parse(raw);
    if (saved.trackName !== trackName || !saved.centerline?.length) return null;
    return saved;
  } catch {
    return null;
  }
}

function saveTrack(data: SavedTrack) {
  try {
    localStorage.setItem(storageKey(data.trackName), JSON.stringify(data));
  } catch (e) {
    console.error('[TrackMap] Erro ao salvar:', e);
  }
}

// ─── Algoritmo de centerline ──────────────────────────────────────────────────

function bucketsToPoints(buckets: Bucket[]): TrackPoint[] {
  return buckets
    .map(b => b.count >= MIN_SAMPLES_PER_BUCKET
      ? { x: b.sumX / b.count, z: b.sumZ / b.count }
      : null)
    .filter((p): p is TrackPoint => p !== null);
}

// Suavização com média móvel circular (janela w em cada direção).
function smoothPoints(pts: TrackPoint[], w = 5): TrackPoint[] {
  if (pts.length < w * 2) return pts;
  return pts.map((_, i) => {
    let sx = 0, sz = 0, count = 0;
    for (let j = i - w; j <= i + w; j++) {
      const idx = (j + pts.length) % pts.length;
      sx += pts[idx].x;
      sz += pts[idx].z;
      count++;
    }
    return { x: sx / count, z: sz / count };
  });
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function TrackMap({
  telemetry,
  feedbackPoints,
}: {
  telemetry: TelemetryData | null;
  feedbackPoints: FeedbackPoint[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [centerline, setCenterline]   = useState<TrackPoint[]>([]);
  const [status, setStatus]           = useState<'idle' | 'mapping' | 'done'>('idle');
  const [trackName, setTrackName]     = useState<string>('');
  const [lapsAccumulated, setLapsAcc] = useState(0);
  const [mappingProgress, setMappingProgress] = useState(0);

  const [hoveredFeedback, setHoveredFeedback] = useState<FeedbackPoint | null>(null);
  const [mousePos, setMousePos]               = useState({ x: 0, y: 0 });

  // Refs para o loop de animação (zero re-renders)
  const telemetryRef  = useRef(telemetry);
  const feedbackRef   = useRef(feedbackPoints);
  const centerlineRef = useRef(centerline);
  const statusRef     = useRef(status);

  useEffect(() => { telemetryRef.current = telemetry; },     [telemetry]);
  useEffect(() => { feedbackRef.current = feedbackPoints; }, [feedbackPoints]);
  useEffect(() => { centerlineRef.current = centerline; },   [centerline]);
  useEffect(() => { statusRef.current = status; },           [status]);

  // ── Acumulador interno (mutado diretamente, sem trigger de render) ────────────
  //
  // Estratégia: dividir a pista em NUM_BUCKETS fatias por lap_dist_pct.
  // Cada frame soma pos_x/pos_z no bucket correspondente.
  // A cada volta completa, recalcula a centerline como média de cada bucket.
  // Com múltiplas voltas a média converge para o centro real da pista.
  //
  const bucketsRef    = useRef<Bucket[]>([]);
  const lapsAccRef    = useRef(0);
  const lastDistRef   = useRef(-1);
  const lapActiveRef  = useRef(false);

  function resetBuckets() {
    bucketsRef.current = Array.from({ length: NUM_BUCKETS }, () => ({
      sumX: 0, sumZ: 0, count: 0,
    }));
    lapsAccRef.current  = 0;
    lastDistRef.current = -1;
    lapActiveRef.current = false;
  }

  // ── Carrega mapa salvo quando a pista muda ────────────────────────────────────
  useEffect(() => {
    const name = telemetry?.trackName;
    if (!name || name === trackName) return;

    setTrackName(name);
    const saved = loadTrack(name);

    if (saved && saved.lapsAccumulated >= LAPS_TO_CONVERGE) {
      // Mapa completo — usa direto
      setCenterline(saved.centerline);
      setLapsAcc(saved.lapsAccumulated);
      setStatus('done');
      resetBuckets();
    } else {
      // Mapa parcial ou inexistente — continua mapeando
      setCenterline(saved?.centerline ?? []);
      setLapsAcc(saved?.lapsAccumulated ?? 0);
      setStatus('mapping');
      setMappingProgress(0);
      resetBuckets();

      // Reconstrói buckets a partir do mapa parcial salvo
      // para não perder progresso entre sessões
      if (saved && saved.lapsAccumulated > 0) {
        lapsAccRef.current = saved.lapsAccumulated;
        const weight = saved.lapsAccumulated * MIN_SAMPLES_PER_BUCKET;
        saved.centerline.forEach((pt, i) => {
          const idx = Math.round(i * NUM_BUCKETS / saved.centerline.length) % NUM_BUCKETS;
          const b = bucketsRef.current[idx];
          if (b) { b.sumX = pt.x * weight; b.sumZ = pt.z * weight; b.count = weight; }
        });
      }
    }
  }, [telemetry?.trackName]);

  // ── Lógica de acumulação por frame ───────────────────────────────────────────
  useEffect(() => {
    if (!telemetry || status !== 'mapping') return;

    const { pos_x, pos_z, lap_dist_pct, inPits } = telemetry;
    const lastDist = lastDistRef.current;

    // Detecta cruzamento da linha de largada
    const crossedFinish = lastDist > 90 && lap_dist_pct < 10;

    if (crossedFinish && lapActiveRef.current) {
      // ── Volta completa: recalcula e salva a centerline ──
      const lapsNow = lapsAccRef.current + 1;
      lapsAccRef.current = lapsNow;
      setLapsAcc(lapsNow);
      lapActiveRef.current = false;

      const pts = smoothPoints(bucketsToPoints(bucketsRef.current));

      if (pts.length > 30) {
        setCenterline(pts);
        centerlineRef.current = pts;

        saveTrack({
          trackName: telemetry.trackName,
          centerline: pts,
          lapsAccumulated: lapsNow,
          savedAt: new Date().toISOString(),
        });

        if (lapsNow >= LAPS_TO_CONVERGE) {
          setStatus('done');
        }
      }
    }

    // Inicia nova volta
    if (crossedFinish || lastDist < 0) {
      lapActiveRef.current = true;
    }

    lastDistRef.current = lap_dist_pct;

    if (!lapActiveRef.current || inPits) return;

    // ── Acumula posição com correção de racing line ───────────────────────────
    //
    // PROBLEMA: o piloto anda na racing line, não no centro da pista.
    // SOLUÇÃO: usar o vetor perpendicular ao heading + G lateral como proxy
    //          do deslocamento lateral. Subtraindo esse offset da posição real,
    //          aproximamos a posição de volta ao centro da pista.
    //
    // ori_x, ori_z = vetor frontal do carro (linha 0 da matriz mOri do rF2).
    //                Fornecido pelo telemetry_bridge.py com o campo ori_x/ori_z.
    //
    // Perpendicular ao heading (giro 90° anti-horário): perpX = -ori_z, perpZ = ori_x
    //
    // gLat > 0 = aceleração lateral para esquerda (carro desviando para direita)
    // gLat < 0 = aceleração lateral para direita (carro desviando para esquerda)
    //
    // CORRECTION_SCALE = fator empírico conservador. A média de voltas complementa
    // o que a correção instantânea não resolve completamente.
    //
    const ori_x = (telemetry as any).ori_x ?? 0;
    const ori_z = (telemetry as any).ori_z ?? 0;
    const gLat  = telemetry.gLat ?? 0;

    const CORRECTION_SCALE = 1.0; // metros por G lateral

    const perpX = -ori_z;
    const perpZ =  ori_x;

    const corrected_x = pos_x - gLat * perpX * CORRECTION_SCALE;
    const corrected_z = pos_z - gLat * perpZ * CORRECTION_SCALE;

    // Índice do bucket
    const bucketIdx = Math.min(
      Math.floor((lap_dist_pct / 100) * NUM_BUCKETS),
      NUM_BUCKETS - 1
    );

    const b = bucketsRef.current[bucketIdx];
    b.sumX += corrected_x;
    b.sumZ += corrected_z;
    b.count++;

    setMappingProgress(Math.round(lap_dist_pct));
  }, [telemetry, status]);

  // ── Remap manual ──────────────────────────────────────────────────────────────
  const startRemap = useCallback(() => {
    if (!trackName) return;
    localStorage.removeItem(storageKey(trackName));
    setCenterline([]);
    setLapsAcc(0);
    setStatus('mapping');
    setMappingProgress(0);
    resetBuckets();
  }, [trackName]);

  // ── Transform canvas coords ───────────────────────────────────────────────────
  const getTransform = useCallback(
    (canvas: HTMLCanvasElement, pts: TrackPoint[]) => {
      if (pts.length < 2) return null;
      const xs = pts.map(p => p.x);
      const zs = pts.map(p => p.z);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minZ = Math.min(...zs), maxZ = Math.max(...zs);
      const rangeX = maxX - minX || 1;
      const rangeZ = maxZ - minZ || 1;
      const padding = 30;
      const scale = Math.min(
        (canvas.width  - padding * 2) / rangeX,
        (canvas.height - padding * 2) / rangeZ
      );
      const offsetX = (canvas.width  - rangeX * scale) / 2;
      const offsetY = (canvas.height - rangeZ * scale) / 2;
      return (x: number, z: number) => ({
        x: offsetX + (x - minX) * scale,
        y: offsetY + (z - minZ) * scale,
      });
    },
    []
  );

  // ── Mouse hover ───────────────────────────────────────────────────────────────
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const pts = centerlineRef.current;
    if (!canvas || pts.length < 2) return;

    const rect = canvas.getBoundingClientRect();
    const canvasX = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const canvasY = (e.clientY - rect.top)  * (canvas.height / rect.height);
    setMousePos({ x: e.clientX, y: e.clientY });

    const transform = getTransform(canvas, pts);
    if (!transform) return;

    let found: FeedbackPoint | null = null;
    for (const fb of feedbackRef.current) {
      const pos = transform(fb.x, fb.z);
      if (Math.sqrt((canvasX - pos.x) ** 2 + (canvasY - pos.y) ** 2) < 15) {
        found = fb;
        break;
      }
    }
    setHoveredFeedback(found);
  };

  // ── Loop de renderização ──────────────────────────────────────────────────────
  useEffect(() => {
    let frame: number;

    const draw = () => {
      const canvas = canvasRef.current;
      const pts    = centerlineRef.current;
      const tel    = telemetryRef.current;
      const fbs    = feedbackRef.current;
      const st     = statusRef.current;

      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          const transform = getTransform(canvas, pts);

          if (transform && pts.length >= 2) {

            // ── Sombra da pista ──
            ctx.beginPath();
            ctx.strokeStyle = '#1a1a1a';
            ctx.lineWidth = 10;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            const s0 = transform(pts[0].x, pts[0].z);
            ctx.moveTo(s0.x, s0.y);
            for (let i = 1; i < pts.length; i++) {
              const p = transform(pts[i].x, pts[i].z);
              ctx.lineTo(p.x, p.y);
            }
            if (st === 'done') ctx.closePath();
            ctx.stroke();

            // ── Pista principal ──
            ctx.beginPath();
            ctx.strokeStyle = '#2d2d2d';
            ctx.lineWidth = 7;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.moveTo(s0.x, s0.y);
            for (let i = 1; i < pts.length; i++) {
              const p = transform(pts[i].x, pts[i].z);
              ctx.lineTo(p.x, p.y);
            }
            if (st === 'done') ctx.closePath();
            ctx.stroke();

            // ── Centerline tracejada (só quando concluído) ──
            if (st === 'done') {
              ctx.beginPath();
              ctx.strokeStyle = 'rgba(255,255,255,0.06)';
              ctx.lineWidth = 1;
              ctx.setLineDash([4, 8]);
              ctx.moveTo(s0.x, s0.y);
              for (let i = 1; i < pts.length; i++) {
                const p = transform(pts[i].x, pts[i].z);
                ctx.lineTo(p.x, p.y);
              }
              ctx.closePath();
              ctx.stroke();
              ctx.setLineDash([]);
            }

            // ── Linha de largada ──
            const startP = transform(pts[0].x, pts[0].z);
            ctx.beginPath();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.arc(startP.x, startP.y, 5, 0, Math.PI * 2);
            ctx.stroke();

            // ── Feedback points ──
            const now = Date.now();
            fbs.forEach(fb => {
              const pos   = transform(fb.x, fb.z);
              const color = fb.type === 'positive' ? '#22c55e'
                          : fb.type === 'critical' ? '#ef4444'
                          : '#f97316';
              const pulse = 1 + Math.sin(now / 200) * 0.2;

              ctx.beginPath();
              ctx.fillStyle = color;
              ctx.globalAlpha = 0.4;
              ctx.arc(pos.x, pos.y, 10 * pulse, 0, Math.PI * 2);
              ctx.fill();

              ctx.beginPath();
              ctx.globalAlpha = 1;
              ctx.fillStyle = color;
              ctx.arc(pos.x, pos.y, 4, 0, Math.PI * 2);
              ctx.fill();
              ctx.strokeStyle = 'white';
              ctx.lineWidth = 1;
              ctx.stroke();
            });
            ctx.globalAlpha = 1;

            // ── Carro ──
            if (tel) {
              const car = transform(tel.pos_x, tel.pos_z);
              ctx.beginPath();
              ctx.fillStyle = 'rgba(0,0,0,0.4)';
              ctx.ellipse(car.x + 1, car.y + 2, 6, 4, 0, 0, Math.PI * 2);
              ctx.fill();
              ctx.beginPath();
              ctx.fillStyle = '#f97316';
              ctx.arc(car.x, car.y, 5, 0, Math.PI * 2);
              ctx.fill();
              ctx.strokeStyle = 'white';
              ctx.lineWidth = 2;
              ctx.stroke();
            }
          }
        }
      }

      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [getTransform]);

  // ── UI ────────────────────────────────────────────────────────────────────────
  const lapsNeeded = Math.max(0, LAPS_TO_CONVERGE - lapsAccumulated);
  const convergePct = Math.min(100, Math.round((lapsAccumulated / LAPS_TO_CONVERGE) * 100));

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-6 relative overflow-hidden flex flex-col items-center justify-center min-h-[300px] col-span-2 md:col-span-1">
      {/* Header */}
      <div className="absolute top-4 left-6 right-6 flex items-center justify-between">
        <div className="text-[10px] font-bold text-white/30 uppercase tracking-widest flex items-center gap-2">
          <Map className="w-3 h-3" />
          {trackName || 'Aguardando pista...'}
        </div>

        <div className="flex items-center gap-3">
          {status === 'mapping' && (
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 bg-orange-500 rounded-full animate-pulse" />
              <span className="text-[10px] font-bold text-orange-400 uppercase tracking-tighter">
                {lapsAccumulated === 0
                  ? `Mapeando ${mappingProgress}%`
                  : `Volta ${lapsAccumulated}/${LAPS_TO_CONVERGE} — refinando`}
              </span>
            </div>
          )}
          {status === 'done' && (
            <div className="flex items-center gap-1 text-green-400/60">
              <CheckCircle className="w-3 h-3" />
              <span className="text-[10px] font-bold uppercase tracking-tighter">
                Centerline ({lapsAccumulated} voltas)
              </span>
            </div>
          )}
          {trackName && status === 'done' && (
            <button
              onClick={startRemap}
              title="Remapear pista"
              className="p-1 rounded-full text-white/20 hover:text-orange-400 hover:bg-white/5 transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Barra de convergência */}
      {status === 'mapping' && lapsAccumulated > 0 && (
        <div className="absolute top-12 left-6 right-6">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] text-white/20 uppercase tracking-widest">
              Precisão da centerline
            </span>
            <span className="text-[9px] text-white/30">{convergePct}%</span>
          </div>
          <div className="h-[2px] bg-white/5 rounded-full overflow-hidden">
            <div
              className="h-full bg-orange-500/60 rounded-full transition-all duration-500"
              style={{ width: `${convergePct}%` }}
            />
          </div>
          {lapsNeeded > 0 && (
            <p className="text-[9px] text-white/15 mt-1 text-right">
              +{lapsNeeded} volta{lapsNeeded !== 1 ? 's' : ''} para convergir
            </p>
          )}
        </div>
      )}

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={400}
        height={400}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredFeedback(null)}
        className="w-full max-w-[280px] aspect-square opacity-90 cursor-crosshair mt-4"
      />

      {/* Tooltip */}
      <AnimatePresence>
        {hoveredFeedback && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            style={{ left: mousePos.x + 15, top: mousePos.y - 40 }}
            className="fixed z-[200] pointer-events-none bg-black/90 border border-white/20 p-3 rounded-xl shadow-2xl max-w-[200px]"
          >
            <div className={`text-[8px] font-black uppercase mb-1 ${
              hoveredFeedback.type === 'positive' ? 'text-green-400' :
              hoveredFeedback.type === 'critical' ? 'text-red-400' : 'text-orange-400'
            }`}>
              {hoveredFeedback.category}
            </div>
            <div className="text-xs text-white/90 italic leading-snug">
              "{hoveredFeedback.text}"
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {status === 'idle' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-white/20 text-xs text-center uppercase tracking-widest">
            Entre na pista para<br />iniciar o mapeamento
          </p>
        </div>
      )}

      {status === 'mapping' && lapsAccumulated === 0 && (
        <div className="absolute bottom-4 left-0 right-0 flex justify-center">
          <p className="text-[10px] text-white/20 uppercase tracking-widest text-center">
            Complete {LAPS_TO_CONVERGE} voltas para calibrar a centerline
          </p>
        </div>
      )}
    </div>
  );
}
