import React, { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import { Fuel, Gauge, Cloud, Trophy, AlertTriangle, MessageSquare, Timer, Zap, Volume2, VolumeX, FileText, History, Clock, Activity, X } from 'lucide-react';
import { ai, SYSTEM_INSTRUCTION } from './lib/gemini';

// Types
import { TelemetryData, FeedbackPoint, SessionData, RecordedLap, LapFrame } from './types/telemetry';

// Components
import { TrackMap } from './components/TrackMap';
import { TrackAnalysis } from './components/TrackAnalysis';
import { StatCard, TireStat, VerticalBar } from './components/ui/DashboardUI';
import { SessionReport } from './components/modals/SessionReport';
import { HistoryModal } from './components/modals/HistoryModal';
import { AidenPanel } from './components/AidenPanel';
import { LapAnalysisPanel } from './components/LapAnalysisPanel';
import { LapSummaryOverlay, CriticalAlertOverlay } from './components/Overlays';

const AIDEN_INSTRUCTION = `Você é o Aiden, um coach de pilotagem de elite para simuladores. 
Analise os dados de telemetria desta curva e dê feedback técnico em 2-3 frases curtas em português. 
Foque em: ponto de frenagem (cedo/tarde), pressão de freio (progressiva ou brusca), ponto de aceleração (cedo/tarde), e estabilidade (G lateral). 
Seja direto como um coach profissional. Ex: Frenagem muito brusca, perde eficiência. Acelere mais cedo na saída.`;

export default function App() {
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [aiRecommendation, setAiRecommendation] = useState<string>("");
  const [aidenFeedback, setAidenFeedback] = useState<string>("");
  const [lapFeedbacks, setLapFeedbacks] = useState<string[]>([]);
  const [feedbackPoints, setFeedbackPoints] = useState<FeedbackPoint[]>([]);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isTrackAnalysisOpen, setIsTrackAnalysisOpen] = useState(false);
  const [history, setHistory] = useState<SessionData[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionData | null>(null);
  const [sessionAdvice, setSessionAdvice] = useState<string[]>([]);
  const [isGeneratingAdvice, setIsGeneratingAdvice] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showConnectionGuide, setShowConnectionGuide] = useState(true);
  const [cornerPhaseState, setCornerPhaseState] = useState<'none' | 'braking' | 'cornering'>('none');
  const [lapSummary, setLapSummary] = useState<{
    number: number;
    time: string;
    bestTime: string;
    feedbacks: string[];
    aiSummary: string;
  } | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const audioEnabledRef = useRef(false);
  const [laps, setLaps] = useState<{ number: number, time: number, timeStr: string }[]>([]);
  const [bestSectors, setBestSectors] = useState<number[]>([Infinity, Infinity, Infinity]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const isAnalyzingRef = useRef(false);
  const lapFeedbacksRef = useRef<string[]>([]);
  const telemetryRef = useRef<TelemetryData | null>(null);
  const [isAidenAnalyzing, setIsAidenAnalyzing] = useState(false);
  const [recordedLaps, setRecordedLaps] = useState<RecordedLap[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const lastAnalysisTime = useRef<number>(0);
  const lastLapNumber = useRef<number>(0);
  const audioContext = useRef<AudioContext | null>(null);
  
  // Aiden History and Detection
  const historyRef = useRef<TelemetryData[]>([]);
  const currentLapFrames = useRef<LapFrame[]>([]);
  const lastDistPct = useRef<number>(-1);
  const isRecordingLap = useRef<boolean>(false);
  const cornerPhase = useRef<'none' | 'braking' | 'cornering'>('none');
  const lastCornerTime = useRef<number>(0);
  const lastVoiceAlertTime = useRef<number>(0);

  const MIN_FRAMES_FOR_LAP = 80;

  // ── Azure Neural TTS ──────────────────────────────────────────────────────
  // Substitua AZURE_TTS_KEY pela sua chave do portal.azure.com
  // Vozes disponíveis pt-BR: FranciscaNeural (F), AntonioNeural (M), BrendaNeural (F)
  const AZURE_TTS_KEY    = "3gWxFXdNXGQYoZAa8CzHwcsWr7qYFD7NVvDm1YR8VNvs2SGHdKuGJQQJ99CCACZoyfiXJ3w3AAAYACOGiVfZ";
  const AZURE_TTS_REGION = "brazilsouth"; // ajuste se usar outra região
  const AZURE_TTS_VOICE  = "pt-BR-AntonioNeural";
  const azureAudioRef = useRef<HTMLAudioElement | null>(null);

  const speak = async (text: string) => {
    if (isMuted || !audioEnabledRef.current) return;
    try {
      // Initialize audio context if not already
      if (!audioContext.current) {
        audioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (audioContext.current.state === 'suspended') {
        await audioContext.current.resume();
      }

      const AZURE_KEY = AZURE_TTS_KEY; // Using the provided key
      
      if (AZURE_KEY && AZURE_KEY.length > 20) {
        try {
          if (azureAudioRef.current) {
            azureAudioRef.current.pause();
            azureAudioRef.current = null;
          }

          // 1. Sintetizar voz diretamente (Azure permite passar a chave no cabeçalho Ocp-Apim-Subscription-Key)
          const ssml = `<speak version='1.0' xml:lang='pt-BR'>
            <voice name='${AZURE_TTS_VOICE}'>
              <prosody rate='1.05' pitch='0%'>${text}</prosody>
            </voice>
          </speak>`;
          
          const audioRes = await fetch(
            `https://${AZURE_TTS_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
            {
              method: "POST",
              headers: {
                "Ocp-Apim-Subscription-Key": AZURE_KEY,
                "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
                "User-Agent": "RaceMindAI"
              },
              body: ssml,
            }
          );

          if (audioRes.ok) {
            const blob = await audioRes.blob();
            const url  = URL.createObjectURL(blob);
            const audio = new Audio(url);
            azureAudioRef.current = audio;
            
            // Garantir que o volume esteja no máximo
            audio.volume = 1;
            
            await audio.play();
            audio.onended = () => {
              URL.revokeObjectURL(url);
              azureAudioRef.current = null;
            };
            return;
          } else {
            const errorText = await audioRes.text();
            console.warn(`Azure TTS status error: ${audioRes.status}`, errorText);
          }
        } catch (azErr) {
          console.error("Azure TTS direct call failed:", azErr);
        }
      }

      // Fallback para voz do navegador
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel(); // Cancel current to avoid queue lag
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'pt-BR';
        u.rate = 1.1;
        window.speechSynthesis.speak(u);
      }
    } catch (err) {
      console.error("[TTS Error]", err);
    }
  };
  // ─────────────────────────────────────────────────────────────────────────

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

  // tireWear = % de vida RESTANTE (100=novo, 0=destruído). Alerta abaixo de 25%.
  const isCriticalFuel = telemetry ? (telemetry.fuel / telemetry.fuelCapacity) < 0.15 : false;
  const isCriticalTires = telemetry ? telemetry.tireWear.some(w => w < 25) : false;
  const isCritical = isCriticalFuel || isCriticalTires;

  useEffect(() => {
    if (isCritical) {
      const interval = setInterval(() => {
        playAlertSound(isCriticalFuel ? 660 : 880, 'square');
        
        // Voice alerts every 15 seconds if critical
        const now = Date.now();
        if (now - lastVoiceAlertTime.current > 15000) {
          if (isCriticalFuel) speak("Combustível baixo, prepare para pit");
          else if (telemetry && telemetry.tireWear.some(w => w < 30)) speak("Pneus críticos, pit urgente");
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
      telemetryRef.current = data;
      
      // Update history (last 5 seconds at ~10Hz = 50 samples)
      historyRef.current = [...historyRef.current, data].slice(-50);

      // Background Lap Recording Logic
      if (!data.inPits) {
        const crossedFinish = lastDistPct.current > 90 && data.lap_dist_pct < 10;
        
        if (crossedFinish && isRecordingLap.current && currentLapFrames.current.length > MIN_FRAMES_FOR_LAP) {
          const lapTimeNum = parseLapTime(data.lastLapTime);
          if (lapTimeNum > 0) {
            const newLap: RecordedLap = {
              lapNumber: data.lapNumber - 1,
              lapTime: lapTimeNum,
              lapTimeStr: data.lastLapTime,
              trackName: data.trackName,
              frames: [...currentLapFrames.current],
              sectors: [...data.sectors],
              isReference: false,
            };
            setRecordedLaps(prev => {
              const updated = [...prev, newLap];
              // Keep only last 20 laps in memory to avoid lag
              return updated.slice(-20);
            });
          }
          currentLapFrames.current = [];
          isRecordingLap.current = false;
        }

        if (crossedFinish || lastDistPct.current < 0) {
          isRecordingLap.current = true;
          currentLapFrames.current = [];
        }

        if (isRecordingLap.current) {
          currentLapFrames.current.push({
            lap_dist_pct: data.lap_dist_pct,
            pos_x: data.pos_x,
            pos_z: data.pos_z,
            speed: data.speed,
            throttle: data.throttle,
            brake: data.brake,
            gLat: data.gLat,
            steering: data.steering,
            rpm: data.rpm,
            gear: data.gear
          });
        }
      }
      lastDistPct.current = data.lap_dist_pct;

      // Lap Completion Detection for HUD/Dashboard
      if (data.lapNumber > lastLapNumber.current && lastLapNumber.current !== 0) {
        const lapTimeStr = data.lastLapTime;
        const lapTimeNum = parseLapTime(lapTimeStr);
        
        if (lapTimeNum > 0) {
          // Use refs to determine if best lap and generate summary without triggering reconnection
          const currentBest = telemetryRef.current?.bestLapTime ?? 0;
          const isBestLap = currentBest === 0 || lapTimeNum < currentBest;
          
          if (isBestLap) {
            speak("Volta rápida! Continue assim.");
          }

          // Trigger Lap Summary
          const recentFeedbacks = [...lapFeedbacksRef.current].slice(-2);
          generateLapSummary(
            data.lapNumber - 1,
            lapTimeStr,
            currentBest > 0 ? formatTime(currentBest) : lapTimeStr,
            recentFeedbacks
          );
          
          // Reset lap feedbacks
          lapFeedbacksRef.current = [];
          setLapFeedbacks([]);

          setLaps(prev => [{ number: data.lapNumber - 1, time: lapTimeNum, timeStr: lapTimeStr }, ...prev].slice(0, 10));
          
          // Best sectors update
          setBestSectors(prev => [
            data.sectors[0] > 0 ? Math.min(prev[0], data.sectors[0]) : prev[0],
            data.sectors[1] > 0 ? Math.min(prev[1], data.sectors[1]) : prev[1],
            data.sectors[2] > 0 ? Math.min(prev[2], data.sectors[2]) : prev[2],
          ]);
        }
      }
      lastLapNumber.current = data.lapNumber;

      // Corner Detection Logic (Improved)
      const nowTime = Date.now();
      if (nowTime - lastCornerTime.current > 4000) { // Slightly shorter cooldown
        // Trigger braking phase
        if (cornerPhase.current === 'none' && (data.brake > 15 || (data.throttle < 5 && data.speed > 50))) {
          cornerPhase.current = 'braking';
          setCornerPhaseState('braking');
        } 
        // Trigger cornering phase (Lateral G load)
        else if (cornerPhase.current === 'braking' && Math.abs(data.gLat) > 0.25) {
          cornerPhase.current = 'cornering';
          setCornerPhaseState('cornering');
        } 
        // Detection of Apex/Exit (Back on throttle)
        else if (cornerPhase.current === 'cornering' && data.throttle > 25) {
          analyzeCorner(historyRef.current);
          cornerPhase.current = 'none';
          setCornerPhaseState('none');
          lastCornerTime.current = nowTime;
        } 
        // Reset if we slowed down too much or straightened up without throttle
        else if (data.speed < 20 || (cornerPhase.current !== 'none' && Math.abs(data.gLat) < 0.1 && data.throttle < 10)) {
          cornerPhase.current = 'none';
          setCornerPhaseState('none');
        }
      }
      
      // Periodic AI Analysis (every 10 seconds)
      const now = Date.now();
      if (now - lastAnalysisTime.current > 10000) {
        if (!isAnalyzingRef.current) {
          analyzeTelemetry(data);
          lastAnalysisTime.current = now;
        }
      }
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  async function analyzeTelemetry(data: TelemetryData) {
    setIsAnalyzing(true);
    isAnalyzingRef.current = true;
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: `Dados: Velocidade ${data.speed}km/h, RPM ${data.rpm}, Marcha ${data.gear}, Combustível ${data.fuel}L, Pneus ${data.tireWear.join('/')}, Clima ${data.weather}`,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
        },
      });
      if (response.text) {
        setAiRecommendation(response.text);
        speak(response.text);
      }
    } catch (error) {
      console.error("Erro na análise da IA:", error);
    } finally {
      setIsAnalyzing(false);
      isAnalyzingRef.current = false;
    }
  }

  async function analyzeCorner(cornerData: TelemetryData[]) {
    if (cornerData.length < 10 || isAidenAnalyzing || isAnalyzingRef.current) return;
    setIsAidenAnalyzing(true);
    isAnalyzingRef.current = true;
    try {
      const summary = cornerData.map(d => 
        `T:${d.throttle}% B:${d.brake}% S:${d.speed} G:${d.gLat}`
      ).join(' | ');

      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: `Sequência de curva: ${summary}`,
        config: {
          systemInstruction: AIDEN_INSTRUCTION,
        },
      });

      if (response.text) {
        setAidenFeedback(response.text);
        setLapFeedbacks(prev => [...prev, response.text]);
        lapFeedbacksRef.current.push(response.text);
        
        // Categorize feedback for report
        let category: 'Frenagem' | 'Aceleração' | 'Traçado' = 'Traçado';
        let type: 'positive' | 'correction' | 'critical' = 'correction';
        
        const textLow = response.text.toLowerCase();
        if (textLow.includes('freio') || textLow.includes('frenagem')) category = 'Frenagem';
        else if (textLow.includes('acelera') || textLow.includes('saída')) category = 'Aceleração';
        
        if (textLow.includes('ótimo') || textLow.includes('perfeito') || textLow.includes('bom')) type = 'positive';
        else if (textLow.includes('brusca') || textLow.includes('tarde') || textLow.includes('perde')) type = 'critical';

        if (telemetryRef.current) {
          setFeedbackPoints(prev => [...prev, {
            text: response.text,
            x: telemetryRef.current!.pos_x,
            z: telemetryRef.current!.pos_z,
            type,
            category,
            lap_dist_pct: telemetryRef.current!.lap_dist_pct
          }]);
        }

        speak(response.text);
      }
    } catch (error) {
      console.error("Erro no Aiden Coach:", error);
    } finally {
      setIsAidenAnalyzing(false);
      isAnalyzingRef.current = false;
    }
  }

  async function generateLapSummary(number: number, time: string, bestTime: string, feedbacks: string[]) {
    if (isAnalyzingRef.current) return;
    setIsAnalyzing(true);
    isAnalyzingRef.current = true;
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
        if (response.text) {
          aiSummary = response.text;
          speak(aiSummary);
        }
      }

      setLapSummary({ number, time, bestTime, feedbacks, aiSummary });
      setTimeout(() => setLapSummary(null), 15000);
    } catch (error) {
      console.error("Erro no resumo da volta:", error);
    } finally {
      setIsAnalyzing(false);
      isAnalyzingRef.current = false;
    }
  }

  const getTireColor = (wear: number) => {
    // Logic fixed: wear is remaining percentage (100 = new, 0 = worn)
    if (wear > 80) return 'text-green-400';
    if (wear > 50) return 'text-yellow-400';
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

  const handleTestVoice = () => {
    // Se o usuário clicou no botão de teste, ele quer ouvir a voz.
    // Ativamos os mecanismos de áudio se estiverem desligados.
    if (!audioEnabledRef.current) {
      audioEnabledRef.current = true;
      setAudioEnabled(true);
    }
    
    const testMessages = [
      "Aiden pronto para o coach. Tudo em ordem com o rádio.",
      "Sistema de telemetria ativo. Vamos buscar o limite.",
      "Pneu aquecido, motor em ordem. Pode acelerar.",
      "Rádio checado. Boa sorte na pista."
    ];
    const msg = testMessages[Math.floor(Math.random() * testMessages.length)];
    speak(msg);
  };

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
      advice: sessionAdvice,
      recordedLaps: recordedLaps
    };

    const newHistory = [session, ...history];
    setHistory(newHistory);
    localStorage.setItem('race_history', JSON.stringify(newHistory));
    
    // Simulate generation of advice if not already there
    if (sessionAdvice.length === 0) {
      await generateSessionAdvice();
    }
    
    setIsSaving(false);
  }

  async function generateSessionAdvice() {
    if (isGeneratingAdvice || feedbackPoints.length === 0) return;
    setIsGeneratingAdvice(true);
    try {
      const feedbackSummary = feedbackPoints.map(f => f.text).join(' | ');
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: `Feedbacks da sessão: ${feedbackSummary}`,
        config: {
          systemInstruction: "Com base nesses feedbacks de pilotagem desta sessão, dê 3 dicas práticas e objetivas para o piloto melhorar na próxima sessão. Responda em português, cada dica em uma nova linha.",
        },
      });
      if (response.text) {
        const tips = response.text.split('\n').filter(t => t.trim().length > 0).slice(0, 3);
        setSessionAdvice(tips);
      }
    } catch (error) {
      console.error("Erro ao gerar conselhos:", error);
    } finally {
      setIsGeneratingAdvice(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-orange-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-black/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-orange-600 rounded-2xl flex items-center justify-center shadow-lg shadow-orange-600/20">
              <Zap className="w-7 h-7 text-white" fill="currentColor" />
            </div>
            <div>
              <h1 className="text-2xl font-black italic tracking-tighter uppercase leading-none">RaceMind <span className="text-orange-500">AI</span></h1>
              <div className="flex items-center gap-2 mt-1">
                <div className={`w-2 h-2 rounded-full ${telemetry ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest">
                  {telemetry ? `Live: ${telemetry.trackName}` : 'Offline'}
                </span>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setIsTrackAnalysisOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-orange-600/10 hover:bg-orange-600/20 border border-orange-600/20 rounded-xl text-xs font-bold uppercase tracking-widest transition-all text-orange-400"
            >
              <Activity className="w-4 h-4" /> Análise de Traçado
            </button>
            <button 
              onClick={() => setIsHistoryOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs font-bold uppercase tracking-widest transition-all border border-white/5"
            >
              <History className="w-4 h-4" /> Histórico
            </button>
            <button 
              onClick={() => {
                setIsReportOpen(true);
                if (sessionAdvice.length === 0) generateSessionAdvice();
              }}
              className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-xl text-xs font-bold uppercase tracking-widest transition-all shadow-lg shadow-orange-600/20"
            >
              <FileText className="w-4 h-4" /> Ver Relatório
            </button>
            <button 
              onClick={handleTestVoice}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600/10 hover:bg-blue-600/20 border border-blue-600/20 rounded-xl text-xs font-bold uppercase tracking-widest transition-all text-blue-400"
              title="Testar rádio do Aiden"
            >
              <MessageSquare className="w-4 h-4" /> 
              <span className="hidden md:inline">Testar Rádio</span>
            </button>
            <button 
              onClick={() => setIsMuted(!isMuted)}
              className="p-3 bg-white/5 hover:bg-white/10 rounded-xl transition-colors border border-white/5"
            >
              {isMuted ? <VolumeX className="w-5 h-5 text-red-400" /> : <Volume2 className="w-5 h-5 text-blue-400" />}
            </button>
          </div>
        </div>
      </header>

      {/* Top Bar: Live Telemetry */}
      <div className="bg-black/30 border-b border-white/5 py-3 px-6">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-2">
              <Cloud className="w-4 h-4 text-blue-400" />
              <span className="text-xs font-bold text-white/60 uppercase">{telemetry?.weather ?? '---'}</span>
            </div>
            <div className="flex items-center gap-2">
              <Timer className="w-4 h-4 text-orange-500" />
              <span className="text-xs font-mono font-bold text-orange-500">{telemetry?.lapTime ?? '--:--.---'}</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Shift Zone</div>
            <div className="h-4 bg-white/5 rounded-full overflow-hidden flex gap-0.5 p-0.5 border border-white/10 w-48">
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
                <div className="text-6xl font-black text-orange-500 italic">
                  {telemetry?.gear === -1 ? 'R' : telemetry?.gear === 0 ? 'N' : telemetry?.gear ?? 'N'}
                </div>
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
              <h3 className="text-sm font-medium text-white/50 uppercase tracking-wider mb-6 flex items-center gap-2">
                <MessageSquare className="w-4 h-4" /> Engenheiro de Pista (IA)
              </h3>
              <div className="flex-1 flex items-center justify-center">
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
          </div>
        </div>

        {/* Right Column: Analysis & Map */}
        <div className="lg:col-span-4 space-y-6">
          <TrackMap telemetry={telemetry} feedbackPoints={feedbackPoints} />

          <AidenPanel 
            isAidenAnalyzing={isAidenAnalyzing} 
            aidenFeedback={aidenFeedback} 
            cornerPhaseState={cornerPhaseState} 
          />

          <LapAnalysisPanel 
            telemetry={telemetry} 
            laps={laps} 
            bestSectors={bestSectors} 
            consistency={consistency} 
          />

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
      {!telemetry && showConnectionGuide && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-[#1a1a1a] border border-white/10 rounded-3xl p-8 shadow-2xl relative">
            <button 
              onClick={() => setShowConnectionGuide(false)}
              className="absolute top-4 right-4 p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors"
            >
              <X className="w-5 h-5 text-white/40" />
            </button>
            <div className="w-16 h-16 bg-orange-600 rounded-2xl flex items-center justify-center mb-6 mx-auto shadow-lg shadow-orange-600/30">
              <Zap className="w-8 h-8 text-white" fill="currentColor" />
            </div>
            <h2 className="text-2xl font-black uppercase tracking-tighter text-center italic">Conecte sua <span className="text-orange-500">Telemetria</span></h2>
            <p className="text-white/40 text-center text-sm mt-3 leading-relaxed font-medium px-4">
              Aguardando sinal do simulador. Configure seu PC para o coach Aiden assumir o rádio.
            </p>
            
            <div className="space-y-4 mt-8">
              <div className="p-4 bg-white/5 rounded-2x border border-white/10">
                <div className="text-[10px] font-black uppercase tracking-[0.2em] text-orange-500 mb-2">1. Ponte Python</div>
                <p className="text-xs text-white/50 leading-relaxed font-medium">Execute <code className="bg-black/40 px-2 py-0.5 rounded text-orange-400">python telemetry_bridge.py</code> no PC onde o jogo está rodando.</p>
              </div>
              <div className="p-4 bg-white/5 rounded-2xl border border-white/10">
                <div className="text-[10px] font-black uppercase tracking-[0.2em] text-orange-500 mb-2">2. Ativar Coach</div>
                <button 
                  onClick={() => {
                    audioEnabledRef.current = true;
                    setAudioEnabled(true);
                    handleTestVoice();
                  }}
                  className="w-full flex items-center justify-center gap-2 py-3 bg-orange-600 hover:bg-orange-500 rounded-xl text-xs font-black uppercase tracking-widest transition-all shadow-lg shadow-orange-600/20"
                >
                  <Volume2 className="w-4 h-4 text-white" /> Habilitar Coaching por Voz
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Persistent Audio Activation if not enabled */}
      {!audioEnabled && telemetry && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[200]">
          <motion.button 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            whileHover={{ scale: 1.05 }}
            onClick={() => {
              audioEnabledRef.current = true;
              setAudioEnabled(true);
              handleTestVoice();
            }}
            className="flex items-center gap-3 px-8 py-4 bg-orange-600 rounded-full shadow-[0_20px_50px_rgba(234,88,12,0.4)] text-sm font-black uppercase tracking-widest hover:bg-orange-500 transition-all border-4 border-black ring-4 ring-orange-600/30 group"
          >
            <Volume2 className="w-5 h-5 group-hover:animate-pulse" />
            Ativar Coach (Clique Aqui)
          </motion.button>
        </div>
      )}

      <CriticalAlertOverlay 
        isCritical={isCritical} 
        isCriticalFuel={isCriticalFuel} 
        isCriticalTires={isCriticalTires} 
      />

      <LapSummaryOverlay lapSummary={lapSummary} />

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

      <HistoryModal 
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
        history={history}
        onSelectSession={(session) => {
          setSelectedSession(session);
          if (session.recordedLaps) setRecordedLaps(session.recordedLaps);
          setIsHistoryOpen(false);
        }}
      />

      {selectedSession && (
        <SessionReport 
          isOpen={!!selectedSession}
          onClose={() => setSelectedSession(null)}
          telemetry={{ trackName: selectedSession.trackName } as any}
          feedbackPoints={selectedSession.feedbacks}
          laps={[]}
          consistency={selectedSession.consistency}
          advice={selectedSession.advice}
          isGenerating={false}
          isPastSession={true}
          onExploreTrack={() => {
            setIsTrackAnalysisOpen(true);
            setSelectedSession(null);
          }}
        />
      )}

      <AnimatePresence>
        {isTrackAnalysisOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <TrackAnalysis
              telemetry={telemetry}
              laps={laps}
              recordedLaps={recordedLaps}
              setRecordedLaps={setRecordedLaps}
              onClose={() => setIsTrackAnalysisOpen(false)}
            />
          </motion.div>
        )}
      </AnimatePresence>
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
