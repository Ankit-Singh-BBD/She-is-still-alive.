// ===================================================================
// GLASS CARD - Reusable glassmorphic card component
// ===================================================================

import { motion, HTMLMotionProps } from 'motion/react';
import { ReactNode } from 'react';

interface GlassCardProps extends Omit<HTMLMotionProps<'div'>, 'children'> {
  children: ReactNode;
  variant?: 'default' | 'panel' | 'inset';
  hover?: boolean;
  glow?: boolean;
  className?: string;
}

export function GlassCard({
  children,
  variant = 'default',
  hover = false,
  glow = false,
  className = '',
  ...motionProps
}: GlassCardProps) {
  const baseClass = 'rounded-[1.75rem] border border-white/15';

  const variantClass = {
    default: 'bg-white/[0.08] backdrop-blur-xl',
    panel: 'glass-panel',
    inset: 'bg-white/[0.06] backdrop-blur-2xl glass-inset',
  }[variant];

  const hoverClass = hover ? 'glass-hover cursor-pointer' : '';
  const glowClass = glow ? 'shadow-2xl shadow-black/30' : '';

  return (
    <motion.div
      className={`${baseClass} ${variantClass} ${hoverClass} ${glowClass} ${className}`}
      {...motionProps}
    >
      {children}
    </motion.div>
  );
}
