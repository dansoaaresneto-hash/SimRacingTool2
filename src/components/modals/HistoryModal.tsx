import React from 'react';
import { motion } from 'motion/react';
import { X, History, Map, Clock, Zap } from 'lucide-react';
import { SessionData } from '../../types/telemetry';

interface HistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  history: SessionData[];
  onSelectSession: (session: SessionData) => void;
}

export function HistoryModal({ 
  isOpen, 
  onClose, 
  history, 
  onSelectSession 
}: HistoryModalProps) {
  if (!isOpen) return null;

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
            <h2 className="text-4xl font-black uppercase tracking-tighter italic">Histórico de <span className="text-orange-500">Sessões</span></h2>
            <p className="text-white/40 font-mono text-sm uppercase tracking-widest mt-2">Suas performances salvas</p>
          </div>
          <button onClick={onClose} className="p-4 bg-white/5 hover:bg-white/10 rounded-full transition-colors">
            <X className="w-8 h-8 text-white/60" />
          </button>
        </div>

        {history.length === 0 ? (
          <div className="text-center py-24 border-2 border-dashed border-white/5 rounded-3xl">
            <History className="w-16 h-16 text-white/10 mx-auto mb-6" />
            <h3 className="text-xl font-bold text-white/40 uppercase tracking-widest">Nenhuma sessão salva ainda</h3>
            <p className="text-white/20 text-sm mt-2">Salve seus relatórios para vê-los aqui.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {history.map((session) => (
              <motion.button
                key={session.id}
                whileHover={{ scale: 1.02, translateY: -4 }}
                onClick={() => onSelectSession(session)}
                className="bg-white/5 border border-white/10 rounded-3xl p-6 text-left hover:bg-white/10 transition-all group"
              >
                <div className="flex justify-between items-start mb-6">
                  <div className="p-3 bg-orange-500/10 rounded-2xl text-orange-500 group-hover:bg-orange-500 group-hover:text-black transition-colors">
                    <Map className="w-6 h-6" />
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-bold text-white/20 uppercase tracking-widest flex items-center gap-1 justify-end">
                      <Clock className="w-3 h-3" /> {new Date(session.timestamp).toLocaleDateString()}
                    </div>
                    <div className="text-[10px] font-bold text-white/20 uppercase tracking-widest">
                      {new Date(session.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
                
                <h3 className="text-xl font-bold mb-2 truncate">{session.trackName}</h3>
                
                <div className="space-y-3 mt-6">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-bold text-white/30 uppercase">Melhor Volta</span>
                    <span className="font-mono text-sm text-orange-400">{session.bestLap.timeStr}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-bold text-white/30 uppercase">Voltas</span>
                    <span className="font-mono text-sm">{session.totalLaps}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-bold text-white/30 uppercase">Consistência</span>
                    <span className={`text-[10px] font-black uppercase ${session.consistency.color}`}>{session.consistency.label}</span>
                  </div>
                </div>

                <div className="mt-6 pt-6 border-t border-white/5 flex justify-between items-center">
                  <span className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Ver Detalhes</span>
                  <Zap className="w-4 h-4 text-orange-500 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </motion.button>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}
