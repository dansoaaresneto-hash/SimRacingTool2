import React, { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import { Fuel, Gauge, Cloud, Trophy, AlertTriangle, MessageSquare, Timer, Zap } from 'lucide-react';
import { ai, SYSTEM_INSTRUCTION } from './lib/gemini';

interface TelemetryData {
  fuel: number;
  fuelCapacity: number;
  tireWear: number[]; // [FL, FR, RL, RR]
  weather: string;
  position: number;
  gapAhead: number;
  gapBehind: number;
  lapTime: string;
  lastLapTime: string;
  rpm: number;
  speed: number;
  gear: number;
}

export default function App() {
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [aiRecommendation, setAiRecommendation] = useState<string>("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const lastAnalysisTime = useRef<number>(0);

  useEffect(() => {
    // Connect to the server
    socketRef.current = io();

    socketRef.current.on("telemetry_update", (data: TelemetryData) => {
      setTelemetry(data);
      
      // Analyze every 10 seconds or on critical events
      const now = Date.now();
      if (now - lastAnalysisTime.current > 10000) {
        analyzeTelemetry(data);
        lastAnalysisTime.current = now;
      }
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  async function analyzeTelemetry(data: TelemetryData) {
    if (isAnalyzing) return;
    setIsAnalyzing(true);
    try {
      const prompt = `
        Dados Atuais:
        Combustível: ${data.fuel.toFixed(2)}L / ${data.fuelCapacity}L
        Desgaste Pneus: FL:${data.tireWear[0]}%, FR:${data.tireWear[1]}%, RL:${data.tireWear[2]}%, RR:${data.tireWear[3]}%
        Clima: ${data.weather}
        Posição: ${data.position}
        Gap Frente: ${data.gapAhead}s
        Gap Trás: ${data.gapBehind}s
        Última Volta: ${data.lastLapTime}
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
        },
      });

      if (response.text) {
        setAiRecommendation(response.text);
      }
    } catch (error) {
      console.error("Erro na análise da IA:", error);
    } finally {
      setIsAnalyzing(false);
    }
  }

  const getTireColor = (wear: number) => {
    if (wear < 20) return 'text-green-400';
    if (wear < 50) return 'text-yellow-400';
    return 'text-red-500';
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-orange-500/30">
      {/* Header */}
      <header className="border-b border-white/10 bg-black/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-orange-600 rounded flex items-center justify-center">
              <Zap className="w-5 h-5 text-white" fill="currentColor" />
            </div>
            <h1 className="text-xl font-bold tracking-tighter uppercase">RaceMind <span className="text-orange-500">AI</span></h1>
          </div>
          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${telemetry ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
              <div className={`w-2 h-2 rounded-full ${telemetry ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
              {telemetry ? 'LIVE TELEMETRY' : 'DISCONNECTED'}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Dashboard */}
        <div className="lg:col-span-8 space-y-6">
          {/* Main Gauges */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard 
              icon={<Fuel className="text-orange-500" />} 
              label="Combustível" 
              value={telemetry ? `${telemetry.fuel.toFixed(1)}L` : '--'} 
              subValue={telemetry ? `${((telemetry.fuel / telemetry.fuelCapacity) * 100).toFixed(0)}%` : ''}
              alert={telemetry && telemetry.fuel < 10}
            />
            <StatCard 
              icon={<Timer className="text-blue-400" />} 
              label="Última Volta" 
              value={telemetry ? telemetry.lastLapTime : '--:--.---'} 
            />
            <StatCard 
              icon={<Trophy className="text-yellow-500" />} 
              label="Posição" 
              value={telemetry ? `P${telemetry.position}` : '--'} 
            />
          </div>

          {/* Tires & Weather */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
              <h3 className="text-sm font-medium text-white/50 uppercase tracking-wider mb-6 flex items-center gap-2">
                <Gauge className="w-4 h-4" /> Desgaste de Pneus
              </h3>
              <div className="grid grid-cols-2 gap-8 relative">
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-24 border-2 border-white/20 rounded-lg" />
                <div className="space-y-8">
                  <TireStat label="FL" wear={telemetry?.tireWear[0] ?? 0} color={getTireColor(telemetry?.tireWear[0] ?? 0)} />
                  <TireStat label="RL" wear={telemetry?.tireWear[2] ?? 0} color={getTireColor(telemetry?.tireWear[2] ?? 0)} />
                </div>
                <div className="space-y-8 text-right">
                  <TireStat label="FR" wear={telemetry?.tireWear[1] ?? 0} color={getTireColor(telemetry?.tireWear[1] ?? 0)} align="right" />
                  <TireStat label="RR" wear={telemetry?.tireWear[3] ?? 0} color={getTireColor(telemetry?.tireWear[3] ?? 0)} align="right" />
                </div>
              </div>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-6 flex flex-col justify-between">
              <div>
                <h3 className="text-sm font-medium text-white/50 uppercase tracking-wider mb-6 flex items-center gap-2">
                  <Cloud className="w-4 h-4" /> Condições
                </h3>
                <div className="text-4xl font-bold mb-2">{telemetry?.weather ?? 'Estável'}</div>
                <p className="text-white/40 text-sm">Pista seca. Temperatura: 24°C</p>
              </div>
              <div className="mt-8 space-y-4">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-white/40">Gap à Frente</span>
                  <span className="font-mono text-green-400">-{telemetry?.gapAhead ?? '0.000'}s</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-white/40">Gap Atrás</span>
                  <span className="font-mono text-red-400">+{telemetry?.gapBehind ?? '0.000'}s</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: AI Assistant */}
        <div className="lg:col-span-4">
          <div className="bg-orange-600/10 border border-orange-500/20 rounded-2xl p-6 h-full flex flex-col">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-sm font-bold text-orange-500 uppercase tracking-widest flex items-center gap-2">
                <MessageSquare className="w-4 h-4" /> Engenheiro de IA
              </h3>
              {isAnalyzing && (
                <div className="flex gap-1">
                  <motion.div animate={{ scale: [1, 1.5, 1] }} transition={{ repeat: Infinity, duration: 1 }} className="w-1 h-1 bg-orange-500 rounded-full" />
                  <motion.div animate={{ scale: [1, 1.5, 1] }} transition={{ repeat: Infinity, duration: 1, delay: 0.2 }} className="w-1 h-1 bg-orange-500 rounded-full" />
                  <motion.div animate={{ scale: [1, 1.5, 1] }} transition={{ repeat: Infinity, duration: 1, delay: 0.4 }} className="w-1 h-1 bg-orange-500 rounded-full" />
                </div>
              )}
            </div>

            <div className="flex-1">
              <AnimatePresence mode="wait">
                {aiRecommendation ? (
                  <motion.div
                    key={aiRecommendation}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="text-lg font-medium leading-relaxed text-orange-100 italic"
                  >
                    "{aiRecommendation}"
                  </motion.div>
                ) : (
                  <div className="text-white/30 italic">Aguardando dados para análise...</div>
                )}
              </AnimatePresence>
            </div>

            <div className="mt-8 pt-6 border-t border-orange-500/10">
              <div className="text-[10px] text-orange-500/50 uppercase tracking-widest font-bold mb-2">Status do Sistema</div>
              <div className="text-xs text-orange-200/70">
                Monitorando combustível, pneus e gaps. Gemini 3 Flash ativo.
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Instructions Overlay if no telemetry */}
      {!telemetry && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-[#1a1a1a] border border-white/10 rounded-3xl p-8 shadow-2xl">
            <div className="w-16 h-16 bg-orange-600 rounded-2xl flex items-center justify-center mb-6 mx-auto">
              <AlertTriangle className="w-8 h-8 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-center mb-4">Aguardando Conexão</h2>
            <p className="text-white/60 text-center mb-8">
              Para usar o assistente, você precisa executar o script de ponte no seu PC local onde o jogo está rodando.
            </p>
            <div className="space-y-4">
              <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                <div className="text-xs font-bold text-orange-500 uppercase mb-2">Passo 1</div>
                <div className="text-sm">Instale as dependências: <code className="bg-black px-2 py-0.5 rounded text-orange-400">pip install socketio-client pyRfactor2SharedMemory</code></div>
              </div>
              <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                <div className="text-xs font-bold text-orange-500 uppercase mb-2">Passo 2</div>
                <div className="text-sm">Execute o arquivo <code className="bg-black px-2 py-0.5 rounded text-orange-400">telemetry_bridge.py</code> que está na raiz deste projeto.</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, subValue, alert }: { icon: React.ReactNode, label: string, value: string, subValue?: string, alert?: boolean }) {
  return (
    <div className={`bg-white/5 border ${alert ? 'border-red-500/50 animate-pulse' : 'border-white/10'} rounded-2xl p-6 transition-colors`}>
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <span className="text-xs font-bold text-white/40 uppercase tracking-widest">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums">{value}</span>
        {subValue && <span className="text-sm text-white/30">{subValue}</span>}
      </div>
    </div>
  );
}

function TireStat({ label, wear, color, align = 'left' }: { label: string, wear: number, color: string, align?: 'left' | 'right' }) {
  return (
    <div className={align === 'right' ? 'text-right' : 'text-left'}>
      <div className="text-[10px] font-bold text-white/30 mb-1">{label}</div>
      <div className={`text-2xl font-mono font-bold ${color}`}>{wear}%</div>
      <div className="w-full h-1 bg-white/10 rounded-full mt-2 overflow-hidden">
        <motion.div 
          initial={{ width: 0 }}
          animate={{ width: `${100 - wear}%` }}
          className={`h-full ${color.replace('text', 'bg')}`}
        />
      </div>
    </div>
  );
}
