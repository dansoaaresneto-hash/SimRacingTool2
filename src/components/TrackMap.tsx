import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Map } from 'lucide-react';
import { TelemetryData, FeedbackPoint } from '../types/telemetry';

export function TrackMap({ telemetry, feedbackPoints }: { telemetry: TelemetryData | null, feedbackPoints: FeedbackPoint[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [points, setPoints] = useState<{x: number, z: number}[]>([]);
  const [isMapping, setIsMapping] = useState(false);
  const [hoveredFeedback, setHoveredFeedback] = useState<FeedbackPoint | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const trackName = telemetry?.trackName || 'unknown';
  const lastLapDist = useRef(0);

  // Refs for animation loop to avoid React state updates
  const telemetryRef = useRef(telemetry);
  const feedbackPointsRef = useRef(feedbackPoints);
  const pointsRef = useRef(points);

  useEffect(() => { telemetryRef.current = telemetry; }, [telemetry]);
  useEffect(() => { feedbackPointsRef.current = feedbackPoints; }, [feedbackPoints]);
  useEffect(() => { pointsRef.current = points; }, [points]);

  // Helper to transform coordinates
  const getTransform = (canvas: HTMLCanvasElement, trackPoints: {x: number, z: number}[]) => {
    const xs = trackPoints.map(p => p.x);
    const zs = trackPoints.map(p => p.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);

    const rangeX = maxX - minX;
    const rangeZ = maxZ - minZ;
    const padding = 40;
    
    const scale = Math.min(
      (canvas.width - padding * 2) / (rangeX || 1), 
      (canvas.height - padding * 2) / (rangeZ || 1)
    );

    const offsetX = (canvas.width - rangeX * scale) / 2;
    const offsetY = (canvas.height - rangeZ * scale) / 2;

    return (x: number, z: number) => ({
      x: offsetX + (x - minX) * scale,
      y: offsetY + (z - minZ) * scale
    });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || points.length < 2) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Scale mouse coordinates to canvas internal resolution
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const canvasX = x * scaleX;
    const canvasY = y * scaleY;

    setMousePos({ x: e.clientX, y: e.clientY });

    const transform = getTransform(canvas, points);
    
    let found = null;
    for (const fb of feedbackPoints) {
      const pos = transform(fb.x, fb.z);
      const dist = Math.sqrt(Math.pow(canvasX - pos.x, 2) + Math.pow(canvasY - pos.y, 2));
      if (dist < 15) {
        found = fb;
        break;
      }
    }
    setHoveredFeedback(found);
  };

  useEffect(() => {
    const saved = localStorage.getItem(`trackmap_${trackName}`);
    if (saved) {
      try {
        setPoints(JSON.parse(saved));
        setIsMapping(false);
      } catch (e) {
        console.error("Erro ao carregar mapa:", e);
        setIsMapping(true);
      }
    } else {
      setPoints([]);
      setIsMapping(true);
    }
  }, [trackName]);

  useEffect(() => {
    if (!telemetry || !isMapping) return;

    const { pos_x, pos_z, lap_dist_pct } = telemetry;
    
    // Record point if moved significantly or first point
    setPoints(prev => {
      if (prev.length === 0) return [{ x: pos_x, z: pos_z }];
      const last = prev[prev.length - 1];
      const dist = Math.sqrt(Math.pow(pos_x - last.x, 2) + Math.pow(pos_z - last.z, 2));
      if (dist > 2) return [...prev, { x: pos_x, z: pos_z }];
      return prev;
    });

    // Detect lap completion to stop mapping
    if (lap_dist_pct < 5 && lastLapDist.current > 95 && points.length > 50) {
      setIsMapping(false);
      localStorage.setItem(`trackmap_${trackName}`, JSON.stringify(points));
    }
    lastLapDist.current = lap_dist_pct;
  }, [telemetry, isMapping, trackName, points.length]);

  useEffect(() => {
    let frame: number;
    
    const loop = () => {
      const canvas = canvasRef.current;
      const currentPoints = pointsRef.current;
      const currentTelemetry = telemetryRef.current;
      const currentFeedbackPoints = feedbackPointsRef.current;

      if (canvas && currentPoints.length >= 2) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          // Clear
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          const transform = getTransform(canvas, currentPoints);

          // Draw track
          ctx.beginPath();
          ctx.strokeStyle = '#222';
          ctx.lineWidth = 6;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';

          const start = transform(currentPoints[0].x, currentPoints[0].z);
          ctx.moveTo(start.x, start.y);
          for (let i = 1; i < currentPoints.length; i++) {
            const p = transform(currentPoints[i].x, currentPoints[i].z);
            ctx.lineTo(p.x, p.y);
          }
          ctx.closePath();
          ctx.stroke();

          // Draw feedback points
          currentFeedbackPoints.forEach(fb => {
            const pos = transform(fb.x, fb.z);
            const color = fb.type === 'positive' ? '#22c55e' : fb.type === 'critical' ? '#ef4444' : '#f97316';
            
            // Pulsing effect using timestamp
            const pulse = 1 + Math.sin(Date.now() / 200) * 0.2;
            
            ctx.beginPath();
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.6;
            ctx.arc(pos.x, pos.y, 8 * pulse, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.beginPath();
            ctx.globalAlpha = 1.0;
            ctx.fillStyle = color;
            ctx.arc(pos.x, pos.y, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 1;
            ctx.stroke();
          });
          ctx.globalAlpha = 1.0;

          // Draw car position
          if (currentTelemetry) {
            const car = transform(currentTelemetry.pos_x, currentTelemetry.pos_z);
            ctx.beginPath();
            ctx.fillStyle = '#f97316'; // orange-500
            ctx.arc(car.x, car.y, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-6 relative overflow-hidden flex flex-col items-center justify-center min-h-[300px]">
      <div className="absolute top-4 left-6 text-[10px] font-bold text-white/30 uppercase tracking-widest flex items-center gap-2">
        <Map className="w-3 h-3" /> Mapa do Circuito
      </div>
      {isMapping && (
        <div className="absolute top-4 right-6 flex items-center gap-2">
          <div className="w-2 h-2 bg-orange-500 rounded-full animate-pulse" />
          <span className="text-[10px] font-bold text-orange-500 uppercase tracking-tighter">Mapeando pista...</span>
        </div>
      )}
      <canvas 
        ref={canvasRef} 
        width={400} 
        height={400} 
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredFeedback(null)}
        className="w-full max-w-[280px] aspect-square opacity-80 cursor-crosshair" 
      />
      
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
              Feedback do Aiden
            </div>
            <div className="text-xs text-white/90 italic leading-snug">
              "{hoveredFeedback.text}"
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
