import React from 'react';
import { motion } from 'motion/react';

export function StatCard({ icon, label, value, subValue, alert }: { 
  icon: React.ReactNode, 
  label: string, 
  value: string | number, 
  subValue?: string,
  alert?: boolean
}) {
  return (
    <div className={`bg-white/5 border ${alert ? 'border-red-500/50 bg-red-500/5' : 'border-white/10'} rounded-2xl p-6 transition-all`}>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-white/5 rounded-lg">
          {icon}
        </div>
        <span className="text-xs font-bold text-white/30 uppercase tracking-widest">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`text-3xl font-black italic tabular-nums ${alert ? 'text-red-500' : 'text-white'}`}>{value}</span>
        {subValue && <span className="text-sm font-bold text-white/20 uppercase">{subValue}</span>}
      </div>
    </div>
  );
}

export function TireStat({ label, wear, color, align = 'left' }: { label: string, wear: number, color: string, align?: 'left' | 'right' }) {
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

export function VerticalBar({ value, color, label }: { value: number, color: string, label: string }) {
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
