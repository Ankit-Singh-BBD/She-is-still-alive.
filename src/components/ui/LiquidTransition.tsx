// ===================================================================
// LIQUID TRANSITION - Wrapper for smooth open/close animations
// ===================================================================

import { motion, AnimatePresence } from 'motion/react';
import { ReactNode } from 'react';

interface LiquidTransitionProps {
  children: ReactNode;
  isOpen: boolean;
  mode?: 'blur' | 'scale' | 'slide';
  duration?: number;
  className?: string;
}

export function LiquidTransition({
  children,
  isOpen,
  mode = 'blur',
  duration = 0.5,
  className = '',
}: LiquidTransitionProps) {
  const variants = {
    blur: {
      initial: { scale: 0.95, opacity: 0, filter: 'blur(20px)' },
      animate: { scale: 1, opacity: 1, filter: 'blur(0px)' },
      exit: { scale: 0.9, opacity: 0, filter: 'blur(20px)' },
    },
    scale: {
      initial: { scale: 0, opacity: 0 },
      animate: { scale: 1, opacity: 1 },
      exit: { scale: 0.8, opacity: 0 },
    },
    slide: {
      initial: { y: 50, opacity: 0 },
      animate: { y: 0, opacity: 1 },
      exit: { y: -50, opacity: 0 },
    },
  };

  return (
    <AnimatePresence mode="wait">
      {isOpen && (
        <motion.div
          initial={variants[mode].initial}
          animate={variants[mode].animate}
          exit={variants[mode].exit}
          transition={{ duration, ease: 'easeOut' }}
          className={className}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
