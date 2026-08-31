// ===================================================================
// FEATURES FOOTER — 5 Frosted Glass Feature Cards (Section 7)
// ===================================================================
//
// 100% Faithful to madhurita-ui-reference.png:
//   - Voice First: Talk naturally with Madhurita
//   - Smart & Proactive: Understands. Remembers. Acts.
//   - Private & Secure: Your Data. Your Control.
//   - Cross Device: Seamless everywhere.
//   - Always Evolving: Learning and Improving.

import React from 'react';
import { motion } from 'motion/react';
import { Mic, Lightbulb, Lock, Smartphone, Flower2 } from 'lucide-react';

interface FeatureCard {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  glowColor: string;
}

export function FeaturesFooter() {
  const features: FeatureCard[] = [
    {
      icon: <Mic className="w-4 h-4 text-sky-400" />,
      title: 'Voice First',
      subtitle: 'Talk naturally with Madhurita',
      glowColor: 'rgba(56, 189, 248, 0.15)',
    },
    {
      icon: <Lightbulb className="w-4 h-4 text-amber-400" />,
      title: 'Smart & Proactive',
      subtitle: 'Understands. Remembers. Acts.',
      glowColor: 'rgba(251, 191, 36, 0.15)',
    },
    {
      icon: <Lock className="w-4 h-4 text-emerald-400" />,
      title: 'Private & Secure',
      subtitle: 'Your Data. Your Control.',
      glowColor: 'rgba(52, 211, 153, 0.15)',
    },
    {
      icon: <Smartphone className="w-4 h-4 text-indigo-400" />,
      title: 'Cross Device',
      subtitle: 'Seamless everywhere.',
      glowColor: 'rgba(129, 140, 248, 0.15)',
    },
    {
      icon: <Flower2 className="w-4 h-4 text-rose-400" />,
      title: 'Always Evolving',
      subtitle: 'Learning and Improving.',
      glowColor: 'rgba(244, 63, 94, 0.15)',
    },
  ];

  return (
    <motion.footer
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.6, duration: 0.5 }}
      className="hidden xl:grid grid-cols-5 gap-3.5 px-6 py-3 shrink-0 relative z-10 w-full max-w-7xl mx-auto"
    >
      {features.map((f, i) => (
        <motion.div
          key={f.title}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.65 + i * 0.05, duration: 0.4 }}
          whileHover={{ y: -2, transition: { duration: 0.2 } }}
          className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl glass-panel border border-white/10 hover:border-white/20 transition-all duration-200 cursor-default group"
          style={{
            boxShadow: `0 8px 24px -6px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.12)`,
          }}
        >
          <div
            className="w-8 h-8 rounded-xl bg-white/[0.06] border border-white/10 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform duration-200"
            style={{ boxShadow: `0 0 14px ${f.glowColor}` }}
          >
            {f.icon}
          </div>
          <div className="min-w-0">
            <h4 className="text-[12px] font-semibold text-white/90 truncate leading-tight group-hover:text-white transition-colors">
              {f.title}
            </h4>
            <p className="text-[10px] text-white/50 truncate leading-tight mt-0.5">
              {f.subtitle}
            </p>
          </div>
        </motion.div>
      ))}
    </motion.footer>
  );
}
