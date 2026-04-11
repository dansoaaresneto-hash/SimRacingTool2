import React, { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import { Fuel, Gauge, Cloud, Trophy, AlertTriangle, MessageSquare, Timer, Zap, Volume2, VolumeX, Map, FileText, X, History, Save, Clock } from 'lucide-react';
import { ai, SYSTEM_INSTRUCTION } from './lib/gemini';

interface TelemetryData {
  fuel: number;
  fuelCapacity: number;
  tireWear: number[]; // [FL, FR, RL, RR]
  tireTemp: number[];
  weather: string;
  position: number;
  gapAhead: number;
  gapBehind: number;
  lapTime: string;
  lastLapTime: string;
  bestLapTime: number;
  sectors: number[];
  trackPos: number;
  lapNumber: number;
  rpm: number;
  speed: number;
  gear: number;
  brake: number;
  throttle: number;
  steering: number;
  gLat: number;
  gLon: number;
  pos_x: number;
  pos_z: number;
  trackName: string;
  lap_dist_pct: number;
}

const AIDEN_INSTRUCTION = `Você é o Aiden, um coach de pilotagem de elite para simuladores. 
Analise os dados de telemetria desta curva e dê feedback técnico em 2-3 frases curtas em português. 
Foque em: ponto de frenagem (cedo/tarde), pressão de freio (progressiva ou brusca), ponto de aceleração (cedo/tarde), e estabilidade (G lateral). 
Seja direto como um coach profissional. Ex: Frenagem muito brusca, perde eficiência. Acelere mais cedo na saída.`;

interface FeedbackPoint {
  text: string;
  x: number;
  z: number;
  type: 'positive' | 'correction' | 'critical';
  category: 'Frenagem' | 'Aceleração' | 'Traçado';
  lap_dist_pct: number;
}

interface SessionData {
  id: string;
  timestamp: string;
  trackName: string;
  bestLap: { time: number, timeStr: string };
  totalLaps: number;
  consistency: { value: number, label: string, color: string };
  feedbacks: FeedbackPoint[];
  advice: string[];
}

export default function App() {
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [aiRecommendation, setAiRecommendation] = useState<string>("");
  const [aidenFeedback, setAidenFeedback] = useState<string>("");
  const [lapFeedbacks, setLapFeedbacks] = useState<string[]>([]);
  const [feedbackPoints, setFeedbackPoints] = useState<FeedbackPoint[]>([]);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [history, setHistory] = useState<SessionData[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionData | null>(null);
  const [sessionAdvice, setSessionAdvice] = useState<string[]>([]);
  const [isGeneratingAdvice, setIsGeneratingAdvice] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lapSummary, setLapSummary] = useState<{
    number: number;
    time: string;
    bestTime: string;
    feedbacks: string[];
    aiSummary: string;
  } | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [laps, setLaps] = useState<{ number: number, time: number, timeStr: string }[]>([]);
  const [bestSectors, setBestSectors] = useState<number[]>([Infinity, Infinity, Infinity]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isAidenAnalyzing, setIsAidenAnalyzing] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const lastAnalysisTime = useRef<number>(0);
  const lastLapNumber = useRef<number>(0);
  const audioContext = useRef<AudioContext | null>(null);
  
  // Aiden History and Detection
  const historyRef = useRef<TelemetryData[]>([]);
  const cornerPhase = useRef<'none' | 'braking' | 'cornering'>('none');
  const lastCornerTime = useRef<number>(0);
  const lastVoiceAlertTime = useRef<number>(0);

  const speak = (text: string) => {
    if (isMuted || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'pt-BR';
    utterance.rate = 1.0;
    const voices = window.speechSynthesis.getVoices();
    const ptVoice = voices.find(v => v.lang.includes('pt-BR'));
    if (ptVoice) utterance.voice = ptVoice;
    window.speechSynthesis.speak(utterance);
  };

  const playAlertSound = (frequency: number = 440, type: OscillatorType = 'sine') => {
    if (!audioContext.current) {
      audioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const ctx = audioContext.current;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(frequency, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(frequency * 0.5, ctx.currentTime + 0.2);

    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  };

  const isCriticalFuel = telemetry ? (telemetry.fuel / telemetry.fuelCapacity) < 0.15 : false;
  const isCriticalTires = telemetry ? telemetry.tireWear.some(w => w > 60) : false;
  const isCritical = isCriticalFuel || isCriticalTires;

  useEffect(() => {
    if (isCritical) {
      const interval = setInterval(() => {
        playAlertSound(isCriticalFuel ? 660 : 880, 'square');
        
        // Voice alerts every 15 seconds if critical
        const now = Date.now();
        if (now - lastVoiceAlertTime.current > 15000) {
          if (isCriticalFuel) speak("Combustível baixo, prepare para pit");
          else if (telemetry && telemetry.tireWear.some(w => w > 70)) speak("Pneus críticos, pit urgente");
          lastVoiceAlertTime.current = now;
        }
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [isCritical, isCriticalFuel, telemetry, isMuted]);

  useEffect(() => {
    // Connect to the server
    socketRef.current = io();

    socketRef.current.on("telemetry_update", (data: TelemetryData) => {
      setTelemetry(data);
      
      // Update history (last 5 seconds at ~10Hz = 50 samples)
      historyRef.current = [...historyRef.current, data].slice(-50);

      // Lap Completion Detection
      if (data.lapNumber > lastLapNumber.current && lastLapNumber.current !== 0) {
        const lapTimeStr = data.lastLapTime;
        const lapTimeNum = parseLapTime(lapTimeStr);
        
        if (lapTimeNum > 0) {
          const isBestLap = telemetry && (telemetry.bestLapTime === 0 || lapTimeNum < telemetry.bestLapTime);
          if (isBestLap) {
            speak("Volta rápida! Continue assim.");
          }
          
          // Trigger Lap Summary
          const recentFeedbacks = lapFeedbacks.slice(-2);
          generateLapSummary(
            data.lapNumber - 1,
            lapTimeStr,
            telemetry?.bestLapTime ? formatTime(telemetry.bestLapTime) : lapTimeStr,
            recentFeedbacks
          );
          setLapFeedbacks([]); // Reset for next lap

          setLaps(prev => [{ number: data.lapNumber - 1, time: lapTimeNum, timeStr: lapTimeStr }, ...prev].slice(0, 10));
          
          // Update Best Sectors (only if they are valid > 0)
          setBestSectors(prev => [
            data.sectors[0] > 0 ? Math.min(prev[0], data.sectors[0]) : prev[0],
            data.sectors[1] > 0 ? Math.min(prev[1], data.sectors[1]) : prev[1],
            data.sectors[2] > 0 ? Math.min(prev[2], data.sectors[2]) : prev[2],
          ]);
        }
      }
      lastLapNumber.current = data.lapNumber;

      // Corner Detection Logic
      const nowTime = Date.now();
      if (nowTime - lastCornerTime.current > 5000) { // Cooldown
        if (cornerPhase.current === 'none' && data.brake > 20) {
          cornerPhase.current = 'braking';
        } else if (cornerPhase.current === 'braking' && Math.abs(data.gLat) > 0.3) {
          cornerPhase.current = 'cornering';
        } else if (cornerPhase.current === 'cornering' && data.throttle > 20) {
          // Sequence complete: Braking -> Cornering -> Acceleration
          analyzeCorner(historyRef.current);
          cornerPhase.current = 'none';
          lastCornerTime.current = nowTime;
        } else if (data.speed < 10) { // Reset if stopped
          cornerPhase.current = 'none';
        }
      }
      
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
        model: "gemini-2.0-flash",
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

  async function analyzeCorner(history: TelemetryData[]) {
    if (isAidenAnalyzing || history.length < 10) return;
    setIsAidenAnalyzing(true);
    try {
      const dataStr = history.map(d => 
        `T:${d.lapTime} V:${d.speed} B:${d.brake}% A:${d.throttle}% GL:${d.gLat} S:${d.steering}`
      ).join('\n');

      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: `Analise esta sequência de curva:\n${dataStr}`,
        config: {
          systemInstruction: AIDEN_INSTRUCTION,
        },
      });

      if (response.text) {
        setAidenFeedback(response.text);
        setLapFeedbacks(prev => [...prev, response.text]);
        
        // Determine feedback type
        let type: 'positive' | 'correction' | 'critical' = 'correction';
        const lowerText = response.text.toLowerCase();
        if (lowerText.includes('excelente') || lowerText.includes('bom') || lowerText.includes('perfeito') || lowerText.includes('ótimo')) {
          type = 'positive';
        } else if (lowerText.includes('brusca') || lowerText.includes('tarde') || lowerText.includes('perde') || lowerText.includes('errada') || lowerText.includes('crítico')) {
          type = 'critical';
        }

        // Determine category
        let category: 'Frenagem' | 'Aceleração' | 'Traçado' = 'Traçado';
        if (lowerText.includes('frenagem') || lowerText.includes('freio') || lowerText.includes('brake')) {
          category = 'Frenagem';
        } else if (lowerText.includes('aceleração') || lowerText.includes('acelere') || lowerText.includes('throttle')) {
          category = 'Aceleração';
        }

        if (telemetry) {
          setFeedbackPoints(prev => [...prev, {
            text: response.text,
            x: telemetry.pos_x,
            z: telemetry.pos_z,
            type,
            category,
            lap_dist_pct: telemetry.lap_dist_pct
          }]);
        }

        speak(response.text);
      }
    } catch (error) {
      console.error("Erro no Aiden Coach:", error);
    } finally {
      setIsAidenAnalyzing(false);
    }
  }

  async function generateLapSummary(number: number, time: string, bestTime: string, feedbacks: string[]) {
    try {
      let aiSummary = "Ótimo trabalho na pista.";
      if (feedbacks.length > 0) {
        const response = await ai.models.generateContent({
          model: "gemini-2.0-flash",
          contents: `Feedbacks da volta: ${feedbacks.join(' | ')}`,
          config: {
            systemInstruction: "Você é um engenheiro de pista. Em 1 frase curta em português, resuma o desempenho desta volta com base nos feedbacks dados. Seja motivador mas técnico.",
          },
        });
        if (response.text) aiSummary = response.text;
      }

      setLapSummary({ number, time, bestTime, feedbacks, aiSummary });
      setTimeout(() => setLapSummary(null), 15000);
    } catch (error) {
      console.error("Erro no resumo da volta:", error);
    }
  }

  const getTireColor = (wear: number) => {
    if (wear < 20) return 'text-green-400';
    if (wear < 50) return 'text-yellow-400';
    return 'text-red-500';
  };

  const calculateConsistency = () => {
    if (laps.length < 2) return { value: 0, label: 'Aguardando...', color: 'text-white/30' };
    const recentTimes = laps.slice(0, 5).map(l => l.time);
    const mean = recentTimes.reduce((a, b) => a + b, 0) / recentTimes.length;
    const variance = recentTimes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recentTimes.length;
    const stdDev = Math.sqrt(variance);
    
    let label = 'Inconsistente';
    let color = 'text-red-400';
    if (stdDev < 0.3) {
      label = 'Excelente';
      color = 'text-green-400';
    } else if (stdDev < 0.8) {
      label = 'Bom';
      color = 'text-yellow-400';
    }
    
    return { value: stdDev, label, color };
  };

  const consistency = calculateConsistency();

  useEffect(() => {
    const savedHistory = localStorage.getItem('race_history');
    if (savedHistory) {
      try {
        setHistory(JSON.parse(savedHistory));
      } catch (e) {
        console.error("Erro ao carregar histórico:", e);
      }
    }
  }, []);

  async function saveSession() {
    if (isSaving || feedbackPoints.length === 0) return;
    setIsSaving(true);
    
    const bestLap = laps.length > 0 ? laps.reduce((prev, curr) => prev.time < curr.time ? prev : curr) : { time: 0, timeStr: '--:--.---' };
    
    const session: SessionData = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      trackName: telemetry?.trackName || 'Desconhecido',
      bestLap: { time: bestLap.time, timeStr: bestLap.timeStr },
      totalLaps: laps.length,
      consistency,
      feedbacks: feedbackPoints,
      advice: sessionAdvice
    };

    const newHistory = [session, ...history];
    setHistory(newHistory);
    localStorage.setItem('race_history', JSON.stringify(newHistory));
    
    // Reset current session data if desired, but maybe keep it for the modal
    setIsSaving(false);
    alert("Sessão salva com sucesso!");
  }

  async function generateSessionAdvice() {
    if (isGeneratingAdvice || feedbackPoints.length === 0) return;
    setIsGeneratingAdvice(true);
    try {
      const feedbacks = feedbackPoints.map(f => f.text).join(' | ');
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: `Com base nesses feedbacks de pilotagem desta sessão, dê 3 dicas práticas e objetivas para o piloto melhorar na próxima sessão: ${feedbacks}`,
        config: {
          systemInstruction: "Você é um coach de pilotagem de elite. Forneça 3 dicas numeradas, curtas e técnicas em português.",
        },
      });
      if (response.text) {
        const tips = response.text.split('\n').filter(t => t.trim().length > 0).slice(0, 3);
        setSessionAdvice(tips);
      }
    } catch (error) {
      console.error("Erro ao gerar conselho da sessão:", error);
    } finally {
      setIsGeneratingAdvice(false);
    }
  }

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
            <button 
              onClick={() => setIsHistoryOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 text-white/60 rounded-full text-xs font-bold transition-all"
            >
              <History className="w-4 h-4" /> Histórico
            </button>
            <button 
              onClick={() => {
                setIsReportOpen(true);
                generateSessionAdvice();
              }}
              className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded-full text-xs font-bold transition-all shadow-lg shadow-orange-600/20"
            >
              <FileText className="w-4 h-4" /> Ver Relatório
            </button>
            <button 
              onClick={() => setIsMuted(!isMuted)}
              className={`p-2 rounded-full transition-colors ${isMuted ? 'bg-red-500/10 text-red-400' : 'bg-white/5 text-white/60 hover:bg-white/10'}`}
              title={isMuted ? "Ativar Voz" : "Mudar Voz"}
            >
              {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
            </button>
            <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${telemetry ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
              <div className={`w-2 h-2 rounded-full ${telemetry ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
              {telemetry ? 'LIVE TELEMETRY' : 'DISCONNECTED'}
            </div>
          </div>
        </div>
      </header>

      {/* Real-time Telemetry Bar */}
      <div className="sticky top-16 z-40 bg-black/80 backdrop-blur-md border-b border-white/10 h-24 flex items-center px-6 gap-8">
        {/* Pedals */}
        <div className="flex gap-4 h-16">
          <VerticalBar value={telemetry?.throttle ?? 0} color="bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.3)]" label="ACC" />
          <VerticalBar value={telemetry?.brake ?? 0} color="bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]" label="BRK" />
        </div>

        {/* Gear & Speed */}
        <div className="flex-1 flex items-center justify-center gap-12">
          <div className="text-center">
            <div className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Marcha</div>
            <div className="text-5xl font-black text-orange-500 italic leading-none">
              {telemetry?.gear === 0 ? 'R' : telemetry?.gear === 1 ? 'N' : (telemetry?.gear ?? 1) - 1}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Velocidade</div>
            <div className="flex items-baseline gap-1">
              <span className="text-5xl font-black italic tabular-nums leading-none">{telemetry?.speed ?? 0}</span>
              <span className="text-sm font-bold text-white/20 uppercase">km/h</span>
            </div>
          </div>
        </div>

        {/* RPM Bar */}
        <div className="w-1/3 max-w-xs space-y-2">
          <div className="flex justify-between text-[8px] font-bold text-white/20 uppercase tracking-tighter">
            <span>RPM Monitor</span>
            <span className="text-red-500">SHIFT ZONE</span>
          </div>
          <div className="h-4 bg-white/5 rounded-full overflow-hidden flex gap-0.5 p-0.5 border border-white/10">
            {Array.from({ length: 30 }).map((_, i) => {
              const rpmPercent = ((telemetry?.rpm ?? 0) / 12000) * 100;
              const isActive = (i / 30) * 100 < rpmPercent;
              let color = 'bg-white/5';
              if (isActive) {
                if (i < 18) color = 'bg-green-500';
                else if (i < 25) color = 'bg-yellow-500';
                else color = 'bg-red-500 animate-pulse';
              }
              return <div key={i} className={`flex-1 rounded-sm transition-colors duration-75 ${color}`} />;
            })}
          </div>
        </div>
      </div>

      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Dashboard */}
        <div className="lg:col-span-8 space-y-6">
          {/* Speed & RPM Panel */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-8 relative overflow-hidden">
            <div className="flex justify-between items-end mb-4">
              <div>
                <div className="text-xs font-bold text-white/30 uppercase tracking-widest mb-1">Velocidade</div>
                <div className="flex items-baseline gap-2">
                  <span className="text-7xl font-black italic tabular-nums">{telemetry?.speed ?? 0}</span>
                  <span className="text-xl font-bold text-white/20 uppercase">km/h</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-bold text-white/30 uppercase tracking-widest mb-1">Marcha</div>
                <div className="text-6xl font-black text-orange-500 italic">{telemetry?.gear === 0 ? 'R' : telemetry?.gear === 1 ? 'N' : (telemetry?.gear ?? 1) - 1}</div>
              </div>
            </div>
            
            <div className="space-y-2">
              <div className="flex justify-between text-[10px] font-bold text-white/20 uppercase tracking-tighter">
                <span>0 RPM</span>
                <span>4000</span>
                <span>8000</span>
                <span className="text-red-500">12000</span>
              </div>
              <div className="h-4 bg-white/5 rounded-full overflow-hidden flex gap-1 p-0.5 border border-white/10">
                {Array.from({ length: 40 }).map((_, i) => {
                  const rpmPercent = ((telemetry?.rpm ?? 0) / 12000) * 100;
                  const isActive = (i / 40) * 100 < rpmPercent;
                  let color = 'bg-white/10';
                  if (isActive) {
                    if (i < 25) color = 'bg-green-500';
                    else if (i < 35) color = 'bg-yellow-500';
                    else color = 'bg-red-500 animate-pulse';
                  }
                  return <div key={i} className={`flex-1 rounded-sm transition-colors duration-75 ${color}`} />;
                })}
              </div>
            </div>
          </div>

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
                <p className="text-white/40 text-sm">Pista: {telemetry?.trackName ?? 'Carregando...'}</p>
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

            {/* Track Map */}
            <TrackMap telemetry={telemetry} feedbackPoints={feedbackPoints} />
          </div>
        </div>

        {/* Right Column: AI Assistant & Aiden Coach */}
        <div className="lg:col-span-4 space-y-6">
          {/* Race Engineer */}
          <div className="bg-orange-600/10 border border-orange-500/20 rounded-2xl p-6 flex flex-col">
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

            <div className="min-h-[80px]">
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
          </div>

          {/* Aiden Coach */}
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
                  <div className={`w-1.5 h-1.5 rounded-full ${cornerPhase.current !== 'none' ? 'bg-blue-400 animate-pulse' : 'bg-white/10'}`} />
                  {cornerPhase.current !== 'none' ? 'Detectando Curva' : 'Monitorando'}
                </span>
              </div>
            </div>
          </div>

          {/* Lap Analysis Panel */}
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
                {laps.length > 0 ? laps.map((lap, i) => {
                  const bestTime = telemetry?.bestLapTime || Math.min(...laps.map(l => l.time));
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

          {/* System Status */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <div className="text-[10px] text-white/30 uppercase tracking-widest font-bold mb-4">Status do Sistema</div>
            <div className="space-y-3">
              <div className="flex justify-between items-center text-xs">
                <span className="text-white/40">Gemini AI</span>
                <span className="text-green-400 font-mono">ONLINE</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-white/40">Aiden Coach</span>
                <span className="text-blue-400 font-mono">ACTIVE</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-white/40">Telemetria</span>
                <span className={telemetry ? "text-green-400 font-mono" : "text-red-400 font-mono"}>
                  {telemetry ? "CONNECTED" : "OFFLINE"}
                </span>
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

      {/* Critical Alert Overlay */}
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

      {/* Lap Summary Overlay */}
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
            <motion.div 
              initial={{ width: "100%" }}
              animate={{ width: 0 }}
              transition={{ duration: 15, ease: "linear" }}
              className="h-1 bg-orange-500"
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Session Report Modal */}
      <AnimatePresence>
        {isReportOpen && (
          <SessionReport 
            isOpen={isReportOpen}
            onClose={() => setIsReportOpen(false)}
            telemetry={telemetry}
            feedbackPoints={feedbackPoints}
            laps={laps}
            consistency={consistency}
            advice={sessionAdvice}
            isGenerating={isGeneratingAdvice}
            onSave={saveSession}
            isSaving={isSaving}
          />
        )}
      </AnimatePresence>

      {/* History Modal */}
      <AnimatePresence>
        {isHistoryOpen && (
          <HistoryModal 
            isOpen={isHistoryOpen}
            onClose={() => setIsHistoryOpen(false)}
            history={history}
            onSelectSession={(session) => {
              setSelectedSession(session);
              setIsHistoryOpen(false);
            }}
          />
        )}
      </AnimatePresence>

      {/* Past Session Report Modal */}
      <AnimatePresence>
        {selectedSession && (
          <SessionReport 
            isOpen={!!selectedSession}
            onClose={() => setSelectedSession(null)}
            telemetry={{ trackName: selectedSession.trackName } as any}
            feedbackPoints={selectedSession.feedbacks}
            laps={[]} // Not stored in detail yet
            consistency={selectedSession.consistency}
            advice={selectedSession.advice}
            isGenerating={false}
            isPastSession={true}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function SessionReport({ 
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
}: { 
  isOpen: boolean, 
  onClose: () => void, 
  telemetry: TelemetryData | null, 
  feedbackPoints: FeedbackPoint[], 
  laps: any[], 
  consistency: any,
  advice: string[],
  isGenerating: boolean,
  onSave?: () => void,
  isSaving?: boolean,
  isPastSession?: boolean
}) {
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

function HistoryModal({ 
  isOpen, 
  onClose, 
  history, 
  onSelectSession 
}: { 
  isOpen: boolean, 
  onClose: () => void, 
  history: SessionData[], 
  onSelectSession: (session: SessionData) => void 
}) {
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

function TrackMap({ telemetry, feedbackPoints }: { telemetry: TelemetryData | null, feedbackPoints: FeedbackPoint[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [points, setPoints] = useState<{x: number, z: number}[]>([]);
  const [isMapping, setIsMapping] = useState(false);
  const [hoveredFeedback, setHoveredFeedback] = useState<FeedbackPoint | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const trackName = telemetry?.trackName || 'unknown';
  const lastLapDist = useRef(0);

  // Helper to transform coordinates
  const getTransform = (canvas: HTMLCanvasElement, points: {x: number, z: number}[]) => {
    const xs = points.map(p => p.x);
    const zs = points.map(p => p.z);
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
    const canvas = canvasRef.current;
    if (!canvas || points.length < 2) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const transform = getTransform(canvas, points);

    // Draw track
    ctx.beginPath();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const start = transform(points[0].x, points[0].z);
    ctx.moveTo(start.x, start.y);
    for (let i = 1; i < points.length; i++) {
      const p = transform(points[i].x, points[i].z);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.stroke();

    // Draw feedback points
    feedbackPoints.forEach(fb => {
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
    if (telemetry) {
      const car = transform(telemetry.pos_x, telemetry.pos_z);
      ctx.beginPath();
      ctx.fillStyle = '#f97316'; // orange-500
      ctx.arc(car.x, car.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [points, telemetry, feedbackPoints]);

  // Animation loop for pulsing
  useEffect(() => {
    let frame: number;
    const loop = () => {
      const canvas = canvasRef.current;
      if (canvas && points.length >= 2) {
        // Trigger re-render for pulse
        setPoints(prev => [...prev]);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [points.length]);

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

      <div className="absolute bottom-4 text-[10px] font-mono text-white/20 uppercase tracking-widest">
        {trackName}
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  return `${mins}:${secs.padStart(6, '0')}`;
}

function parseLapTime(timeStr: string): number {
  if (!timeStr || timeStr === '--:--.---') return 0;
  const parts = timeStr.split(':');
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(timeStr);
}

function VerticalBar({ value, color, label }: { value: number, color: string, label: string }) {
  return (
    <div className="flex flex-col items-center gap-1 h-full">
      <div className="flex-1 w-3 bg-white/5 rounded-full overflow-hidden relative border border-white/10">
        <motion.div 
          initial={{ height: 0 }}
          animate={{ height: `${value}%` }}
          className={`absolute bottom-0 w-full ${color} transition-all duration-75`}
        />
      </div>
      <span className="text-[8px] font-bold text-white/30 uppercase">{label}</span>
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
