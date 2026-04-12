import React from 'react';
import { motion } from 'motion/react';
import { Timer } from 'lucide-react';
import { TelemetryData } from '../types/telemetry';

interface LapAnalysisPanelProps {
  telemetry: TelemetryData | null;
  laps: { number: number, time: number, timeStr: string }[];
  bestSectors: number[];
  consistency: { label: string, color: string };
}

export function LapAnalysisPanel({ telemetry, laps, bestSectors, consistency }: LapAnalysisPanelProps) {
  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-white/50 uppercase tracking-widest flex items-center gap-2">
          <Timer className="w-4 h-4" /> Análise de Voltas
        </h3>
        <div className="text-right">
          <div className="text-[10px] text-white/30 uppercase font-bold">Consistência</div>
          <div className={`text-sm font-bold ${consistency.color}`}>{consistency.label}</div>
        </div>
      </div>

      {/* Best Sectors */}
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map(i => (
          <div key={i} className="bg-white/5 rounded-xl p-3 border border-white/5">
            <div className="text-[8px] text-white/30 uppercase font-bold mb-1">Best S{i+1}</div>
            <div className="text-sm font-mono font-bold text-purple-400">
              {bestSectors[i] === Infinity ? '--.---' : bestSectors[i].toFixed(3)}
            </div>
          </div>
        ))}
      </div>

      {/* Lap Table */}
      <div className="space-y-2">
        <div className="grid grid-cols-3 text-[10px] font-bold text-white/20 uppercase px-2">
          <span>Volta</span>
          <span className="text-center">Tempo</span>
          <span className="text-right">Gap</span>
        </div>
        <div className="space-y-1 max-h-[240px] overflow-y-auto pr-1 custom-scrollbar">
          {laps.length > 0 ? laps.map((lap) => {
            const bestTimeInLaps = laps.length > 0 ? Math.min(...laps.map(l => l.time)) : Infinity;
            const bestTime = telemetry?.bestLapTime && telemetry.bestLapTime > 0 ? Math.min(telemetry.bestLapTime, bestTimeInLaps) : bestTimeInLaps;
            const gap = lap.time - bestTime;
            const isBest = gap <= 0;
            const isWithin1Percent = gap / bestTime < 0.01;
            
            let colorClass = "text-red-400";
            if (isBest) colorClass = "text-green-400";
            else if (isWithin1Percent) colorClass = "text-yellow-400";

            return (
              <motion.div 
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                key={lap.number} 
                className="grid grid-cols-3 items-center bg-white/5 rounded-lg p-2 text-xs border border-white/5"
              >
                <span className="text-white/40 font-bold">#{lap.number}</span>
                <span className={`text-center font-mono font-bold ${colorClass}`}>{lap.timeStr}</span>
                <span className={`text-right font-mono ${gap > 0 ? 'text-white/30' : 'text-green-400'}`}>
                  {gap > 0 ? `+${gap.toFixed(3)}` : 'BEST'}
                </span>
              </motion.div>
            );
          }) : (
            <div className="text-center py-8 text-white/20 italic text-xs">Nenhuma volta registrada</div>
          )}
        </div>
      </div>
    </div>
  );
}
