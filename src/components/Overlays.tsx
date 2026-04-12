import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, Timer } from 'lucide-react';

interface LapSummaryOverlayProps {
  lapSummary: {
    number: number;
    time: string;
    bestTime: string;
    feedbacks: string[];
    aiSummary: string;
  } | null;
}

export function LapSummaryOverlay({ lapSummary }: LapSummaryOverlayProps) {
  return (
    <AnimatePresence>
      {lapSummary && (
        <motion.div
          initial={{ x: 400, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 400, opacity: 0 }}
          className="fixed top-40 right-8 z-[120] w-80 bg-[#1a1a1a] border border-orange-500/30 rounded-3xl shadow-2xl overflow-hidden"
        >
          <div className="bg-orange-600 p-4 flex items-center justify-between">
            <h3 className="text-sm font-black uppercase tracking-widest">Resumo da Volta #{lapSummary.number}</h3>
            <Timer className="w-4 h-4" />
          </div>
          <div className="p-6 space-y-4">
            <div className="flex justify-between items-end">
              <div>
                <div className="text-[10px] text-white/30 uppercase font-bold">Tempo</div>
                <div className="text-2xl font-mono font-bold text-orange-400">{lapSummary.time}</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-white/30 uppercase font-bold">Melhor</div>
                <div className="text-sm font-mono text-white/60">{lapSummary.bestTime}</div>
              </div>
            </div>

            {lapSummary.feedbacks.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] text-white/30 uppercase font-bold">Destaques do Aiden:</div>
                {lapSummary.feedbacks.map((f, i) => (
                  <div key={i} className="text-xs text-blue-200 bg-blue-500/10 p-2 rounded-lg border border-blue-500/20 italic">
                    "{f}"
                  </div>
                ))}
              </div>
            )}

            <div className="pt-4 border-t border-white/10">
              <div className="text-[10px] text-orange-500 uppercase font-black mb-2">Veredito do Engenheiro:</div>
              <div className="text-sm font-medium text-orange-100 leading-relaxed">
                {lapSummary.aiSummary}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface CriticalAlertOverlayProps {
  isCritical: boolean;
  isCriticalFuel: boolean;
  isCriticalTires: boolean;
}

export function CriticalAlertOverlay({ isCritical, isCriticalFuel, isCriticalTires }: CriticalAlertOverlayProps) {
  return (
    <AnimatePresence>
      {isCritical && (
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          className="fixed bottom-8 right-8 z-[110] pointer-events-none"
        >
          <div className="bg-red-600 text-white px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-4 border-2 border-white/20 animate-pulse">
            <AlertTriangle className="w-8 h-8" />
            <div>
              <div className="text-xs font-black uppercase tracking-widest opacity-80">Alerta Crítico</div>
              <div className="text-lg font-bold">
                {isCriticalFuel && isCriticalTires ? 'COMBUSTÍVEL E PNEUS CRÍTICOS' : 
                 isCriticalFuel ? 'COMBUSTÍVEL BAIXO' : 'DESGASTE DE PNEUS ELEVADO'}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
