import { motion } from 'motion/react';
import { Sparkles, Mic, ShieldCheck, Cpu } from 'lucide-react';

interface ExperienceIntroProps {
  onEnter: () => void;
  hasOwner: boolean;
  ownerName: string | null;
}

export function ExperienceIntro({ onEnter, hasOwner, ownerName }: ExperienceIntroProps) {
  return (
    <motion.div
      id="experience-intro"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.7 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-between p-8 sm:p-12 bg-[#030712] text-white select-none overflow-hidden"
    >
      {/* Background ambient light orbs - Vibrant Palette */}
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] bg-purple-600/20 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] bg-blue-600/20 rounded-full blur-[150px]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.05)_0%,transparent_70%)]" />
      </div>

      {/* Top Branding Pill */}
      <motion.div
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2, duration: 0.6 }}
        className="px-4 py-1.5 rounded-full border border-white/10 bg-white/5 backdrop-blur-md flex items-center gap-2 text-xs font-medium uppercase tracking-[0.15em] text-emerald-100 z-10"
      >
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
        Live Neural Audio Connection Active
      </motion.div>

      {/* Center Hero & Interactive Orb Preview */}
      <div className="flex flex-col items-center text-center max-w-lg z-10 my-auto">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.8, ease: 'easeOut' }}
          className="relative mb-8"
        >
          {/* Animated Glow Rings */}
          <div className="absolute inset-0 m-auto w-36 h-36 rounded-full bg-gradient-to-r from-blue-500/30 via-purple-500/30 to-pink-500/30 animate-ping opacity-40" />
          <div className="relative w-28 h-28 sm:w-32 sm:h-32 rounded-full bg-gradient-to-tr from-blue-500 via-purple-500 to-pink-500 p-[2px] shadow-[0_0_40px_rgba(168,85,247,0.4)] flex items-center justify-center">
            <div className="w-full h-full rounded-full bg-[#030712]/90 backdrop-blur-xl flex flex-col items-center justify-center">
              <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center shadow-[0_0_12px_rgba(255,255,255,0.8)]">
                <Sparkles className="w-4 h-4 text-purple-600" />
              </div>
            </div>
          </div>
        </motion.div>

        <motion.h1
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.6 }}
          className="text-4xl sm:text-5xl font-semibold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white via-white to-gray-400 mb-3"
        >
          Madhurita
        </motion.h1>

        <motion.p
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.6 }}
          className="text-sm sm:text-base text-white/70 font-light leading-relaxed mb-8 max-w-md"
        >
          Personal AI assistant with identity-scoped memory, verified owner authorization, and real-time natural voice conversation.
        </motion.p>

        {/* Feature Badges */}
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.6, duration: 0.6 }}
          className="grid grid-cols-3 gap-2 sm:gap-3 w-full mb-8 text-left"
        >
          <div className="p-3.5 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-xl">
            <Mic className="w-4 h-4 text-blue-400 mb-1.5" />
            <div className="text-[11px] font-semibold text-white">Voice-to-Voice</div>
            <div className="text-[10px] text-white/50">Real-Time Live</div>
          </div>
          <div className="p-3.5 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-xl">
            <ShieldCheck className="w-4 h-4 text-purple-400 mb-1.5" />
            <div className="text-[11px] font-semibold text-white">Identity Memory</div>
            <div className="text-[10px] text-white/50">Strict Isolation</div>
          </div>
          <div className="p-3.5 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-xl">
            <Cpu className="w-4 h-4 text-pink-400 mb-1.5" />
            <div className="text-[11px] font-semibold text-white">Tools & Actions</div>
            <div className="text-[10px] text-white/50">Instant Execution</div>
          </div>
        </motion.div>

        {/* Enter Button */}
        <motion.button
          id="btn-enter-experience"
          onClick={onEnter}
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.97 }}
          transition={{ delay: 0.7, duration: 0.4 }}
          className="w-full sm:w-auto px-8 py-3.5 rounded-full bg-gradient-to-tr from-blue-500 via-purple-500 to-pink-500 text-white font-medium text-sm sm:text-base shadow-[0_0_30px_rgba(168,85,247,0.4)] hover:shadow-[0_0_45px_rgba(168,85,247,0.6)] transition-all flex items-center justify-center gap-2.5 cursor-pointer"
        >
          <span>Enter the Experience</span>
          <span className="w-1.5 h-1.5 rounded-full bg-white animate-ping" />
        </motion.button>
      </div>

      {/* Bottom Status Info */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.9, duration: 0.5 }}
        className="text-xs text-white/40 flex items-center gap-2 z-10 tracking-wider uppercase text-[10px]"
      >
        {hasOwner ? (
          <span>Verified Owner System • {ownerName ? `Owner: ${ownerName}` : 'Configured'}</span>
        ) : (
          <span className="text-amber-300">Fresh System Setup Available</span>
        )}
      </motion.div>
    </motion.div>
  );
}
