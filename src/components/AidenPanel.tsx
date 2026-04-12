import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Zap } from 'lucide-react';

interface AidenPanelProps {
  isAidenAnalyzing: boolean;
  aidenFeedback: string;
  cornerPhaseState: 'none' | 'braking' | 'cornering';
}

export function AidenPanel({ isAidenAnalyzing, aidenFeedback, cornerPhaseState }: AidenPanelProps) {
  return (
    <div className="bg-blue-600/10 border border-blue-500/20 rounded-2xl p-6 flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-sm font-bold text-blue-400 uppercase tracking-widest flex items-center gap-2">
          <Zap className="w-4 h-4" /> Aiden Driver Coach
        </h3>
        {isAidenAnalyzing && (
          <div className="flex gap-1">
            <motion.div animate={{ scale: [1, 1.5, 1] }} transition={{ repeat: Infinity, duration: 1 }} className="w-1 h-1 bg-blue-400 rounded-full" />
            <motion.div animate={{ scale: [1, 1.5, 1] }} transition={{ repeat: Infinity, duration: 1, delay: 0.2 }} className="w-1 h-1 bg-blue-400 rounded-full" />
            <motion.div animate={{ scale: [1, 1.5, 1] }} transition={{ repeat: Infinity, duration: 1, delay: 0.4 }} className="w-1 h-1 bg-blue-400 rounded-full" />
          </div>
        )}
      </div>

      <div className="min-h-[100px]">
        <AnimatePresence mode="wait">
          {aidenFeedback ? (
            <motion.div
              key={aidenFeedback}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="text-base font-medium leading-relaxed text-blue-100"
            >
              <div className="text-[10px] text-blue-400 uppercase font-black mb-2 tracking-tighter">Última Curva:</div>
              "{aidenFeedback}"
            </motion.div>
          ) : (
            <div className="text-white/30 italic text-sm">Aiden está observando sua pilotagem...</div>
          )}
        </AnimatePresence>
      </div>

      <div className="mt-6 pt-4 border-t border-blue-500/10">
        <div className="flex items-center justify-between text-[10px] text-blue-400/50 uppercase font-bold">
          <span>Análise de Telemetria</span>
          <span className="flex items-center gap-1">
            <div className={`w-1.5 h-1.5 rounded-full ${cornerPhaseState !== 'none' ? 'bg-blue-400 animate-pulse' : 'bg-white/10'}`} />
            {cornerPhaseState !== 'none' ? 'Detectando Curva' : 'Monitorando'}
          </span>
        </div>
      </div>
    </div>
  );
}
