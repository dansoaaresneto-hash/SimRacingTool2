import React, { useEffect, useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Map, RefreshCw, CheckCircle } from 'lucide-react';
import { TelemetryData, FeedbackPoint } from '../types/telemetry';

// ─── Tipos ────────────────────────────────────────────────────────────────────
interface TrackPoint {
  x: number;
  z: number;
  lapDist: number; // 0-100% — usado para filtrar pitlane
}

interface SavedTrack {
  trackName: string;
  points: TrackPoint[];
  savedAt: string;
}

// ─── Constantes ───────────────────────────────────────────────────────────────
// Pontos só são gravados quando lap_dist_pct está entre esses limites.
// O pitlane normalmente fica "fora" do circuito (dist < 0 ou > 100 no rF2),
// mas como recebemos 0-100, filtramos pelo flag inPits enviado pelo bridge.
const MIN_POINT_DIST_METERS = 3; // distância mínima entre pontos gravados (m)
const STORAGE_KEY_PREFIX = 'racemind_track_'; // chave no localStorage

// ─── Helpers ──────────────────────────────────────────────────────────────────
function storageKey(trackName: string) {
  // Normaliza o nome para evitar caracteres inválidos como chave
  return STORAGE_KEY_PREFIX + trackName.toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
}

function loadTrack(trackName: string): TrackPoint[] | null {
  try {
    const raw = localStorage.getItem(storageKey(trackName));
    if (!raw) return null;
    const saved: SavedTrack = JSON.parse(raw);
    if (saved.trackName !== trackName || !saved.points?.length) return null;
    return saved.points;
  } catch {
    return null;
  }
}

function saveTrack(trackName: string, points: TrackPoint[]) {
  try {
    const saved: SavedTrack = {
      trackName,
      points,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(storageKey(trackName), JSON.stringify(saved));
  } catch (e) {
    console.error('[TrackMap] Erro ao salvar:', e);
  }
}

function distance2D(a: TrackPoint, b: TrackPoint) {
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.z - b.z, 2));
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

  // Estado do mapa
  const [points, setPoints]       = useState<TrackPoint[]>([]);
  const [status, setStatus]       = useState<'idle' | 'mapping' | 'done'>('idle');
  const [trackName, setTrackName] = useState<string>('');
  const [mappingProgress, setMappingProgress] = useState(0);

  // Hover
  const [hoveredFeedback, setHoveredFeedback] = useState<FeedbackPoint | null>(null);
  const [mousePos, setMousePos]               = useState({ x: 0, y: 0 });

  // Refs para o loop de animação (sem re-render)
  const telemetryRef      = useRef(telemetry);
  const feedbackRef       = useRef(feedbackPoints);
  const pointsRef         = useRef(points);
  const statusRef         = useRef(status);

  useEffect(() => { telemetryRef.current = telemetry; },      [telemetry]);
  useEffect(() => { feedbackRef.current = feedbackPoints; },  [feedbackPoints]);
  useEffect(() => { pointsRef.current = points; },            [points]);
  useEffect(() => { statusRef.current = status; },            [status]);

  // Tracking state para evitar incluir pitlane
  const lastLapDist    = useRef(-1);
  const mappingPoints  = useRef<TrackPoint[]>([]); // buffer durante mapeamento
  const lapStarted     = useRef(false);            // só grava após cruzar a linha pela 1ª vez

  // ── Carrega mapa salvo quando o nome da pista muda ──────────────────────────
  useEffect(() => {
    const name = telemetry?.trackName;
    if (!name || name === trackName) return;

    setTrackName(name);
    const saved = loadTrack(name);
    if (saved && saved.length > 20) {
      setPoints(saved);
      setStatus('done');
      mappingPoints.current = [];
      lapStarted.current = false;
      lastLapDist.current = -1;
    } else {
      // Pista nova ou sem mapa salvo → inicia mapeamento
      setPoints([]);
      setStatus('mapping');
      mappingPoints.current = [];
      lapStarted.current = false;
      lastLapDist.current = -1;
      setMappingProgress(0);
    }
  }, [telemetry?.trackName]);

  // ── Lógica de mapeamento inteligente ────────────────────────────────────────
  useEffect(() => {
    if (!telemetry || status !== 'mapping') return;

    const { pos_x, pos_z, lap_dist_pct, inPits } = telemetry;

    // 1. Aguarda o carro cruzar a linha de largada (dist passa de >95 para <5)
    //    para começar a gravar, evitando pitlane inicial.
    if (!lapStarted.current) {
      if (lastLapDist.current > 90 && lap_dist_pct < 10) {
        lapStarted.current = true;
        mappingPoints.current = [];
      }
      lastLapDist.current = lap_dist_pct;
      return;
    }

    // 2. Não grava enquanto estiver no pitlane
    if (inPits) {
      lastLapDist.current = lap_dist_pct;
      return;
    }

    // 3. Adiciona ponto se moveu o suficiente
    const newPoint: TrackPoint = { x: pos_x, z: pos_z, lapDist: lap_dist_pct };
    const buf = mappingPoints.current;
    if (buf.length === 0 || distance2D(newPoint, buf[buf.length - 1]) > MIN_POINT_DIST_METERS) {
      buf.push(newPoint);
      setMappingProgress(Math.round(lap_dist_pct));
    }

    // 4. Detecta volta completa: dist volta de >95% para <5%
    if (lastLapDist.current > 90 && lap_dist_pct < 10 && buf.length > 50) {
      // Volta completa! Salva o mapa
      const finalPoints = [...buf];
      saveTrack(telemetry.trackName, finalPoints);
      setPoints(finalPoints);
      setStatus('done');
      mappingPoints.current = [];
    }

    lastLapDist.current = lap_dist_pct;
  }, [telemetry, status]);

  // ── Remap manual ────────────────────────────────────────────────────────────
  const startRemap = useCallback(() => {
    if (!trackName) return;
    localStorage.removeItem(storageKey(trackName));
    setPoints([]);
    setStatus('mapping');
    mappingPoints.current = [];
    lapStarted.current = false;
    lastLapDist.current = -1;
    setMappingProgress(0);
  }, [trackName]);

  // ── Transform canvas coords ─────────────────────────────────────────────────
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

  // ── Mouse hover em feedback points ─────────────────────────────────────────
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const pts = pointsRef.current;
    if (!canvas || pts.length < 2) return;

    const rect = canvasRef.current!.getBoundingClientRect();
    const canvasX = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const canvasY = (e.clientY - rect.top)  * (canvas.height / rect.height);
    setMousePos({ x: e.clientX, y: e.clientY });

    const transform = getTransform(canvas, pts);
    if (!transform) return;

    let found: FeedbackPoint | null = null;
    for (const fb of feedbackRef.current) {
      const pos = transform(fb.x, fb.z);
      if (Math.sqrt(Math.pow(canvasX - pos.x, 2) + Math.pow(canvasY - pos.y, 2)) < 15) {
        found = fb;
        break;
      }
    }
    setHoveredFeedback(found);
  };

  // ── Loop de renderização ────────────────────────────────────────────────────
  useEffect(() => {
    let frame: number;

    const draw = () => {
      const canvas = canvasRef.current;
      const pts    = pointsRef.current;
      const tel    = telemetryRef.current;
      const fbs    = feedbackRef.current;

      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          // Durante mapeamento, desenha o buffer ao vivo
          const drawPts = statusRef.current === 'mapping' && mappingPoints.current.length > 1
            ? mappingPoints.current
            : pts;

          const transform = getTransform(canvas, drawPts);

          if (transform && drawPts.length >= 2) {
            // ── Trilha da pista ──
            ctx.beginPath();
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 8;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            const s = transform(drawPts[0].x, drawPts[0].z);
            ctx.moveTo(s.x, s.y);
            for (let i = 1; i < drawPts.length; i++) {
              const p = transform(drawPts[i].x, drawPts[i].z);
              ctx.lineTo(p.x, p.y);
            }
            // Fecha a pista se mapeamento concluído
            if (statusRef.current === 'done') ctx.closePath();
            ctx.stroke();

            // ── Linha de largada ──
            if (statusRef.current === 'done' && drawPts.length > 0) {
              const startP = transform(drawPts[0].x, drawPts[0].z);
              ctx.beginPath();
              ctx.strokeStyle = '#ffffff';
              ctx.lineWidth = 3;
              ctx.arc(startP.x, startP.y, 6, 0, Math.PI * 2);
              ctx.stroke();
            }

            // ── Feedback points ──
            const now = Date.now();
            fbs.forEach(fb => {
              const pos   = transform(fb.x, fb.z);
              const color = fb.type === 'positive' ? '#22c55e' : fb.type === 'critical' ? '#ef4444' : '#f97316';
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
            if (tel && transform) {
              const car = transform(tel.pos_x, tel.pos_z);
              // Sombra
              ctx.beginPath();
              ctx.fillStyle = 'rgba(0,0,0,0.4)';
              ctx.ellipse(car.x + 1, car.y + 2, 6, 4, 0, 0, Math.PI * 2);
              ctx.fill();
              // Carro
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

  // ── UI ──────────────────────────────────────────────────────────────────────
  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-6 relative overflow-hidden flex flex-col items-center justify-center min-h-[300px] col-span-2 md:col-span-1">
      {/* Header */}
      <div className="absolute top-4 left-6 right-6 flex items-center justify-between">
        <div className="text-[10px] font-bold text-white/30 uppercase tracking-widest flex items-center gap-2">
          <Map className="w-3 h-3" />
          {trackName || 'Aguardando pista...'}
        </div>

        <div className="flex items-center gap-3">
          {/* Status badge */}
          {status === 'mapping' && (
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 bg-orange-500 rounded-full animate-pulse" />
              <span className="text-[10px] font-bold text-orange-400 uppercase tracking-tighter">
                {lapStarted.current
                  ? `Mapeando ${mappingProgress}%`
                  : 'Aguardando volta...'}
              </span>
            </div>
          )}
          {status === 'done' && (
            <div className="flex items-center gap-1 text-green-400/60">
              <CheckCircle className="w-3 h-3" />
              <span className="text-[10px] font-bold uppercase tracking-tighter">Salvo</span>
            </div>
          )}

          {/* Botão remap */}
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

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={400}
        height={400}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredFeedback(null)}
        className="w-full max-w-[280px] aspect-square opacity-90 cursor-crosshair mt-4"
      />

      {/* Tooltip de feedback */}
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

      {/* Instrução inicial se não há pista */}
      {status === 'idle' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-white/20 text-xs text-center uppercase tracking-widest">
            Entre na pista para<br />iniciar o mapeamento
          </p>
        </div>
      )}

      {/* Instrução de mapeamento */}
      {status === 'mapping' && !lapStarted.current && (
        <div className="absolute bottom-4 left-0 right-0 flex justify-center">
          <p className="text-[10px] text-white/20 uppercase tracking-widest text-center">
            Complete uma volta para salvar o mapa
          </p>
        </div>
      )}
    </div>
  );
}
