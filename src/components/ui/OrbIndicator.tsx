// ===================================================================
// ORB INDICATOR - Mini orb for status displays
// ===================================================================

import { motion } from 'motion/react';

interface OrbIndicatorProps {
  state?: 'active' | 'idle' | 'processing' | 'error';
  size?: 'xs' | 'sm' | 'md';
  pulse?: boolean;
  className?: string;
}

export function OrbIndicator({
  state = 'idle',
  size = 'sm',
  pulse = false,
  className = '',
}: OrbIndicatorProps) {
  const sizeClass = {
    xs: 'w-2 h-2',
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
  }[size];

  const colorClass = {
    active: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]',
    idle: 'bg-slate-400 shadow-[0_0_4px_rgba(148,163,184,0.5)]',
    processing: 'bg-indigo-400 shadow-[0_0_8px_rgba(99,102,241,0.7)]',
    error: 'bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.7)]',
  }[state];

  const pulseClass = pulse ? 'animate-pulse' : '';

  return (
    <motion.div
      className={`${sizeClass} ${colorClass} ${pulseClass} rounded-full ${className}`}
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.3 }}
    />
  );
}
