import React from 'react';
import { motion } from 'motion/react';
import { X, Trophy, Timer, Zap, Map, MessageSquare, Save } from 'lucide-react';
import { TelemetryData, FeedbackPoint } from '../../types/telemetry';
import { StatCard } from '../ui/DashboardUI';
import { TrackMap } from '../TrackMap';

interface SessionReportProps {
  isOpen: boolean;
  onClose: () => void;
  telemetry: TelemetryData | null;
  feedbackPoints: FeedbackPoint[];
  laps: any[];
  consistency: any;
  advice: string[];
  isGenerating: boolean;
  onSave?: () => void;
  isSaving?: boolean;
  isPastSession?: boolean;
}

export function SessionReport({ 
  isOpen, 
  onClose, 
  telemetry, 
  feedbackPoints, 
  laps, 
  consistency,
  advice,
  isGenerating,
  onSave,
  isSaving,
  isPastSession = false
}: SessionReportProps) {
  if (!isOpen) return null;

  const bestLap = laps.length > 0 ? laps.reduce((prev, curr) => prev.time < curr.time ? prev : curr) : null;
  
  const grouped = feedbackPoints.reduce((acc, fb) => {
    acc[fb.category] = (acc[fb.category] || []);
    acc[fb.category].push(fb);
    return acc;
  }, {} as Record<string, FeedbackPoint[]>);

  const sortedCategories = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length);

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-xl overflow-y-auto p-6 md:p-12"
    >
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-between items-center mb-12">
          <div>
            <h2 className="text-4xl font-black uppercase tracking-tighter italic">Relatório de <span className="text-orange-500">{isPastSession ? 'Histórico' : 'Sessão'}</span></h2>
            <p className="text-white/40 font-mono text-sm uppercase tracking-widest mt-2">{telemetry?.trackName || 'Circuito Desconhecido'}</p>
          </div>
          <div className="flex items-center gap-4">
            {!isPastSession && onSave && (
              <button 
                onClick={onSave}
                disabled={isSaving || feedbackPoints.length === 0}
                className="flex items-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-full text-sm font-bold transition-all shadow-lg shadow-green-600/20"
              >
                {isSaving ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
                Salvar Sessão
              </button>
            )}
            <button onClick={onClose} className="p-4 bg-white/5 hover:bg-white/10 rounded-full transition-colors">
              <X className="w-8 h-8 text-white/60" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <StatCard icon={<Trophy className="w-4 h-4 text-yellow-500" />} label="Melhor Volta" value={bestLap?.timeStr || '--:--.---'} />
          <StatCard icon={<Timer className="w-4 h-4 text-blue-500" />} label="Total de Voltas" value={isPastSession ? 'N/A' : laps.length.toString()} />
          <StatCard icon={<Zap className="w-4 h-4 text-orange-500" />} label="Consistência" value={consistency.label} subValue={`±${consistency.value.toFixed(3)}s`} alert={consistency.label === 'Inconsistente'} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
          <div className="space-y-6">
            <h3 className="text-lg font-bold uppercase tracking-widest flex items-center gap-2">
              <Map className="w-5 h-5 text-orange-500" /> Mapa de Calor de Feedback
            </h3>
            <div className="bg-white/5 border border-white/10 rounded-3xl p-4 aspect-square flex items-center justify-center overflow-hidden">
               <TrackMap telemetry={telemetry} feedbackPoints={feedbackPoints} />
            </div>
          </div>

          <div className="space-y-8">
            <h3 className="text-lg font-bold uppercase tracking-widest flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-orange-500" /> Análise por Categoria
            </h3>
            <div className="space-y-6">
              {sortedCategories.length > 0 ? sortedCategories.map(cat => (
                <div key={cat} className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <div className="flex justify-between items-center mb-4">
                    <h4 className="font-bold text-orange-500 uppercase tracking-wider">{cat}</h4>
                    <span className="text-xs font-mono text-white/30">{grouped[cat].length} ocorrências</span>
                  </div>
                  <div className="space-y-3">
                    {grouped[cat].slice(0, 3).map((fb, i) => (
                      <div key={i} className="text-sm text-white/70 flex gap-3">
                        <span className="text-orange-500/50">•</span>
                        <span>{fb.text}</span>
                      </div>
                    ))}
                    {grouped[cat].length > 3 && <p className="text-[10px] text-white/20 uppercase italic">+ {grouped[cat].length - 3} outros feedbacks</p>}
                  </div>
                </div>
              )) : (
                <div className="text-center py-12 text-white/20 uppercase text-xs tracking-widest">
                  Nenhum feedback registrado nesta sessão
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-12 bg-orange-500/10 border border-orange-500/20 rounded-3xl p-8">
          <h3 className="text-xl font-bold uppercase tracking-tighter italic mb-6 flex items-center gap-3">
            <Zap className="w-6 h-6 text-orange-500" fill="currentColor" /> Conselho da Sessão
          </h3>
          {isGenerating ? (
            <div className="flex items-center gap-3 text-orange-500/50 animate-pulse">
              <div className="w-2 h-2 bg-orange-500 rounded-full" />
              <span className="text-sm font-bold uppercase tracking-widest">Aiden está analisando sua sessão...</span>
            </div>
          ) : advice.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              {advice.map((tip, i) => (
                <div key={i} className="space-y-2">
                  <div className="text-4xl font-black text-orange-500/20">0{i+1}</div>
                  <p className="text-white/80 text-sm leading-relaxed">{tip.replace(/^\d+\.\s*/, '')}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-orange-500/40 text-sm italic">
              Continue pilotando para receber conselhos estratégicos.
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
