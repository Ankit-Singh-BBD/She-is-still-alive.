// ===================================================================
// EXPERIENCE INTRO - Ultra-Immersive Entry Experience
// ===================================================================
//
// First impression experience with:
// - Liquid plasma background (3-4 animated orbs morphing)
// - Scanning orb that "wakes up"
// - Staggered typography reveal
// - Glassmorphic feature cards
// - Glowing call-to-action with particle effects
// - Time-of-day + weather adaptation
// - Smooth loading states

import { motion, type Variants } from 'motion/react';
import { useEffect, useState } from 'react';
import { Sparkles, Mic, ShieldCheck, Cpu, Volume2 } from 'lucide-react';
import { useTimeOfDay, useWeatherExpression } from '../hooks/useUIState.js';

interface ExperienceIntroProps {
  onEnter: () => void;
  hasOwner: boolean;
  ownerName: string | null;
}

const containerVariants: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.15,
      delayChildren: 0.3,
    },
  },
};

const itemVariants: Variants = {
  hidden: { y: 30, opacity: 0, filter: 'blur(10px)' },
  show: {
    y: 0,
    opacity: 1,
    filter: 'blur(0px)',
    transition: {
      duration: 0.8,
      ease: [0.16, 1, 0.3, 1],
    },
  },
};

const orbPulseVariants: Variants = {
  hidden: { scale: 0, opacity: 0 },
  show: {
    scale: 1,
    opacity: 1,
    transition: {
      duration: 1.2,
      ease: 'easeOut',
    },
  },
};

export function ExperienceIntro({ onEnter, hasOwner, ownerName }: ExperienceIntroProps) {
  const { colors: timeColors, timeOfDay } = useTimeOfDay();
  const weatherExpression = useWeatherExpression();
  const [isHovered, setIsHovered] = useState(false);
  const [scanAngle, setScanAngle] = useState(0);

  // Scanning animation for the central orb
  useEffect(() => {
    let animationId: number;
    let angle = 0;

    const animate = () => {
      angle += 1.5;
      setScanAngle(angle);
      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationId);
  }, []);

  // Dynamic gradient based on time + weather
  const getBackgroundGradient = () => {
    const { mood } = weatherExpression;

    if (mood === 'hot') {
      return 'from-red-900/30 via-orange-800/20 to-amber-900/25';
    } else if (mood === 'cold') {
      return 'from-blue-900/30 via-indigo-800/20 to-violet-900/25';
    } else if (mood === 'rainy' || mood === 'stormy') {
      return 'from-slate-900/40 via-gray-800/25 to-zinc-900/30';
    }

    if (timeOfDay === 'night') {
      return 'from-indigo-950/40 via-purple-900/30 to-blue-950/35';
    } else if (timeOfDay === 'morning') {
      return 'from-orange-900/30 via-amber-800/20 to-yellow-900/25';
    } else if (timeOfDay === 'evening') {
      return 'from-pink-900/30 via-orange-800/20 to-purple-900/25';
    }

    return 'from-blue-950/35 via-cyan-900/25 to-sky-950/30';
  };

  return (
    <motion.div
      id="experience-intro"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{
        opacity: 0,
        scale: 0.96,
        filter: 'blur(20px)',
        transition: { duration: 0.8, ease: 'easeInOut' },
      }}
      transition={{ duration: 0.7 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-between p-6 sm:p-10 text-white select-none overflow-hidden bg-[#030712]"
    >
      {/* Liquid plasma background */}
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        {/* Base gradient */}
        <div className={`absolute inset-0 bg-gradient-to-br ${getBackgroundGradient()}`} />

        {/* Plasma orbs - morphing, animated */}
        <motion.div
          className="absolute w-[600px] h-[600px] rounded-full blur-3xl"
          style={{
            background: `radial-gradient(circle, ${weatherExpression.colors.primary}50, transparent 70%)`,
            top: '-15%',
            left: '-10%',
          }}
          animate={{
            x: [0, 200, 0],
            y: [0, 150, 0],
            scale: [1, 1.3, 1],
            opacity: [0.4, 0.7, 0.4],
          }}
          transition={{
            duration: 18,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />

        <motion.div
          className="absolute w-[700px] h-[700px] rounded-full blur-3xl"
          style={{
            background: `radial-gradient(circle, ${weatherExpression.colors.secondary}45, transparent 70%)`,
            bottom: '-20%',
            right: '-15%',
          }}
          animate={{
            x: [0, -180, 0],
            y: [0, -120, 0],
            scale: [1, 1.4, 1],
            opacity: [0.3, 0.6, 0.3],
          }}
          transition={{
            duration: 22,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />

        <motion.div
          className="absolute w-[500px] h-[500px] rounded-full blur-3xl"
          style={{
            background: `radial-gradient(circle, ${weatherExpression.colors.accent}40, transparent 70%)`,
            top: '40%',
            left: '50%',
          }}
          animate={{
            x: [-250, 250, -250],
            y: [-100, 100, -100],
            scale: [1, 1.5, 1],
            opacity: [0.3, 0.5, 0.3],
          }}
          transition={{
            duration: 25,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />

        {/* Grid overlay for depth */}
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: `linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px),
                              linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)`,
            backgroundSize: '60px 60px',
          }}
        />
      </div>

      {/* Top Branding Pill */}
      <motion.div
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2, duration: 0.6 }}
        className="px-4 py-1.5 rounded-full border border-white/10 bg-white/5 backdrop-blur-md flex items-center gap-2 text-xs font-medium uppercase tracking-[0.15em] text-emerald-100 z-10"
      >
        <motion.span
          className="w-2 h-2 rounded-full bg-emerald-400"
          animate={{ scale: [1, 1.2, 1], opacity: [0.8, 1, 0.8] }}
          transition={{ duration: 2, repeat: Infinity }}
          style={{ boxShadow: '0 0 8px rgba(52,211,153,0.8)' }}
        />
        <span>Live Neural Audio Connection Active</span>
      </motion.div>

      {/* Center Hero & Scanning Orb */}
      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="show"
        className="flex flex-col items-center text-center max-w-lg z-10 my-auto"
      >
        {/* Ultra-expressive scanning orb */}
        <motion.div variants={orbPulseVariants} className="relative mb-10">
          {/* Outer scanning ring */}
          <motion.div
            className="absolute inset-0 m-auto rounded-full"
            style={{
              width: 200,
              height: 200,
              border: '1.5px solid rgba(255,255,255,0.15)',
              transform: `rotate(${scanAngle}deg)`,
            }}
          >
            <div
              className="absolute top-0 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full"
              style={{
                background: weatherExpression.colors.accent,
                boxShadow: `0 0 20px ${weatherExpression.colors.accent}`,
              }}
            />
          </motion.div>

          {/* Middle ring */}
          <motion.div
            className="absolute inset-0 m-auto rounded-full"
            style={{
              width: 160,
              height: 160,
              border: '1px solid rgba(255,255,255,0.1)',
              transform: `rotate(${-scanAngle * 1.2}deg)`,
            }}
            animate={{ scale: [1, 1.1, 1] }}
            transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
          >
            <div
              className="absolute top-1/2 right-0 -translate-y-1/2 w-1.5 h-1.5 rounded-full"
              style={{
                background: weatherExpression.colors.primary,
                boxShadow: `0 0 12px ${weatherExpression.colors.primary}`,
              }}
            />
          </motion.div>

          {/* Inner expanding ring */}
          <motion.div
            className="absolute inset-0 m-auto rounded-full"
            style={{
              width: 140,
              height: 140,
              border: '1px solid rgba(255,255,255,0.08)',
            }}
            animate={{
              scale: [1, 1.4, 1],
              opacity: [0.6, 0, 0.6],
            }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeOut' }}
          />

          {/* Main orb */}
          <motion.div
            className="relative w-32 h-32 sm:w-36 sm:h-36 rounded-full"
            style={{
              background: `radial-gradient(circle at 30% 30%, ${weatherExpression.colors.primary}, ${weatherExpression.colors.secondary}, ${weatherExpression.colors.accent})`,
              boxShadow: `0 0 60px ${weatherExpression.colors.primary}80, inset 0 0 30px rgba(255,255,255,0.2)`,
            }}
            animate={{
              scale: [1, 1.08, 1],
            }}
            transition={{
              duration: 3 / weatherExpression.breathingSpeed,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
          >
            {/* Glass overlay */}
            <div className="absolute inset-0 rounded-full backdrop-blur-2xl border border-white/30 glass-inset" />

            {/* Center icon */}
            <div className="absolute inset-0 flex items-center justify-center">
              <motion.div
                className="w-12 h-12 rounded-full bg-white/95 flex items-center justify-center"
                animate={{ rotate: [0, 360] }}
                transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
                style={{ boxShadow: `0 0 20px ${weatherExpression.colors.accent}80` }}
              >
                <Sparkles className="w-5 h-5 text-purple-600" />
              </motion.div>
            </div>
          </motion.div>
        </motion.div>

        {/* Title */}
        <motion.h1
          variants={itemVariants}
          className="text-5xl sm:text-6xl font-semibold tracking-tight mb-3"
        >
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-white to-gray-300">
            Madhurita
          </span>
        </motion.h1>

        <motion.p
          variants={itemVariants}
          className="text-sm sm:text-base text-white/70 font-light leading-relaxed mb-3 max-w-md"
        >
          A personal AI that sees, feels, and understands.
        </motion.p>

        {/* Current state indicator */}
        <motion.div
          variants={itemVariants}
          className="mb-10 flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.06] border border-white/10 backdrop-blur-xl text-[11px] text-white/60"
        >
          <span className="capitalize">{timeOfDay}</span>
          <span className="opacity-50">•</span>
          <span className="capitalize">{weatherExpression.mood}</span>
          {hasOwner && ownerName && (
            <>
              <span className="opacity-50">•</span>
              <span>Owner: {ownerName}</span>
            </>
          )}
        </motion.div>

        {/* Feature Cards */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="show"
          className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 w-full mb-8 text-left"
        >
          {[
            { icon: Mic, label: 'Voice-to-Voice', desc: 'Real-Time Live', color: 'from-blue-400 to-cyan-400' },
            { icon: Volume2, label: 'Expressive', desc: 'Emotion-Driven', color: 'from-purple-400 to-pink-400' },
            { icon: ShieldCheck, label: 'Identity Memory', desc: 'Strict Isolation', color: 'from-violet-400 to-fuchsia-400' },
            { icon: Cpu, label: 'Tools & Actions', desc: 'Instant Execution', color: 'from-pink-400 to-rose-400' },
          ].map((feature, i) => (
            <motion.div
              key={i}
              variants={itemVariants}
              whileHover={{ scale: 1.04, y: -4 }}
              className="p-3.5 rounded-2xl bg-white/[0.06] border border-white/10 backdrop-blur-2xl cursor-default group relative overflow-hidden"
            >
              {/* Subtle gradient overlay on hover */}
              <div
                className={`absolute inset-0 opacity-0 group-hover:opacity-20 transition-opacity bg-gradient-to-br ${feature.color}`}
              />

              <feature.icon className="w-4 h-4 mb-1.5 text-white/80" />
              <div className="text-[11px] font-semibold text-white relative z-10">{feature.label}</div>
              <div className="text-[10px] text-white/50 relative z-10">{feature.desc}</div>
            </motion.div>
          ))}
        </motion.div>

        {/* Enter Button - Glowing with particle effects */}
        <motion.button
          id="btn-enter-experience"
          onClick={onEnter}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          variants={itemVariants}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.97 }}
          className="relative w-full sm:w-auto px-8 py-4 rounded-full text-white font-medium text-sm sm:text-base flex items-center justify-center gap-2.5 cursor-pointer overflow-hidden group"
          style={{
            background: `linear-gradient(135deg, ${weatherExpression.colors.primary}, ${weatherExpression.colors.secondary}, ${weatherExpression.colors.accent})`,
            boxShadow: `0 0 30px ${weatherExpression.colors.primary}60, 0 0 60px ${weatherExpression.colors.secondary}40`,
          }}
        >
          {/* Shimmer effect */}
          <motion.div
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)',
            }}
            animate={{ x: ['-100%', '200%'] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
          />

          {/* Glow ring on hover */}
          {isHovered && (
            <motion.div
              className="absolute inset-0 rounded-full"
              style={{
                background: `radial-gradient(circle, ${weatherExpression.colors.accent}60, transparent 70%)`,
                filter: 'blur(10px)',
              }}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1.2 }}
              exit={{ opacity: 0 }}
            />
          )}

          <span className="relative z-10">Enter the Experience</span>
          <motion.span
            className="relative z-10 w-1.5 h-1.5 rounded-full bg-white"
            animate={{
              scale: [1, 1.5, 1],
              opacity: [0.8, 1, 0.8],
            }}
            transition={{ duration: 1.5, repeat: Infinity }}
          />
        </motion.button>
      </motion.div>

      {/* Bottom Status Info */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.2, duration: 0.6 }}
        className="text-[10px] text-white/40 flex items-center gap-2 z-10 tracking-wider uppercase"
      >
        {hasOwner ? (
          <span className="flex items-center gap-1.5">
            <motion.span
              className="w-1.5 h-1.5 rounded-full bg-emerald-400"
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
            Verified Owner System
          </span>
        ) : (
          <span className="text-amber-300 flex items-center gap-1.5">
            <motion.span
              className="w-1.5 h-1.5 rounded-full bg-amber-400"
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
            Fresh System Setup Available
          </span>
        )}
      </motion.div>
    </motion.div>
  );
}
