// ===================================================================
// ANIMATED BUTTON - Consistent button with hover/tap animations
// ===================================================================

import { motion, HTMLMotionProps } from 'motion/react';
import { ReactNode } from 'react';

interface AnimatedButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  loading?: boolean;
  className?: string;
}

export function AnimatedButton({
  children,
  variant = 'primary',
  size = 'md',
  icon,
  loading = false,
  className = '',
  ...motionProps
}: AnimatedButtonProps) {
  const sizeClass = {
    sm: 'px-3 py-1.5 text-xs rounded-lg',
    md: 'px-4 py-2.5 text-sm rounded-xl',
    lg: 'px-6 py-3.5 text-base rounded-2xl',
  }[size];

  const variantClass = {
    primary: 'bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 text-white font-medium shadow-lg hover:shadow-xl',
    secondary: 'glass text-white font-medium hover:bg-white/15',
    ghost: 'bg-transparent text-white/70 hover:text-white hover:bg-white/10',
    danger: 'bg-rose-500/20 text-rose-200 border border-rose-500/40 hover:bg-rose-500/30',
  }[variant];

  return (
    <motion.button
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      className={`${sizeClass} ${variantClass} flex items-center justify-center gap-2 transition-all ${className}`}
      disabled={loading}
      {...motionProps}
    >
      {loading ? (
        <motion.div
          className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full"
          animate={{ rotate: 360 }}
          transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
        />
      ) : (
        <>
          {icon}
          {children}
        </>
      )}
    </motion.button>
  );
}
