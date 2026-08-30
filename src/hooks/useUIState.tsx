// ===================================================================
// UI STATE HOOK - React Context for Real-time Backend State
// ===================================================================
//
// Provides unified state to all components via React Context.
// Single source of truth for awareness, emotions, world state.

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { stateSyncService, UIState } from '../services/stateSync.js';

interface UIStateContextValue {
  state: UIState | null;
  isLoading: boolean;
}

const UIStateContext = createContext<UIStateContextValue>({
  state: null,
  isLoading: true,
});

/**
 * Provider component - wraps the entire app.
 */
export function UIStateProvider({
  children,
  authToken,
  userId,
}: {
  children: ReactNode;
  authToken?: string;
  userId?: string;
}) {
  const [state, setState] = useState<UIState | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Subscribe to state changes
    const unsubscribe = stateSyncService.subscribe((newState) => {
      setState(newState);
      setIsLoading(false);
    });

    // Start syncing
    stateSyncService.start(authToken, userId);

    // Cleanup on unmount
    return () => {
      unsubscribe();
      stateSyncService.stop();
    };
  }, [authToken, userId]);

  return (
    <UIStateContext.Provider value={{ state, isLoading }}>
      {children}
    </UIStateContext.Provider>
  );
}

/**
 * Hook to access full UI state.
 */
export function useUIState(): UIStateContextValue {
  return useContext(UIStateContext);
}

/**
 * Hook to access awareness state.
 */
export function useAwareness() {
  const { state } = useUIState();
  return state?.awareness || null;
}

/**
 * Hook to access emotions state.
 */
export function useEmotions() {
  const { state } = useUIState();
  return state?.emotions || {
    engagement: 50,
    focus: 50,
    confidence: 50,
    state: 'calm' as const,
    recentActivity: [],
  };
}

/**
 * Hook to access world state (time, weather, season).
 */
export function useWorldState() {
  const { state } = useUIState();
  return state?.worldState || null;
}

/**
 * Hook to access a specific state value by path.
 * Example: useStateValue('awareness.presence.totalActive')
 */
export function useStateValue<T = any>(path: string): T | undefined {
  const { state } = useUIState();

  if (!state) return undefined;

  const parts = path.split('.');
  let value: any = state;

  for (const part of parts) {
    value = value?.[part];
    if (value === undefined) return undefined;
  }

  return value as T;
}

/**
 * Hook to access time-of-day and get matching colors.
 */
export function useTimeOfDay() {
  const worldState = useWorldState();

  const timeOfDay = worldState?.timeOfDay || 'evening';

  // Return color palette based on time
  const colors = {
    morning: {
      primary: '#FFA500', // Orange
      secondary: '#FFD700', // Gold
      accent: '#FF8C00', // Dark orange
      bg: 'from-orange-500/20 via-amber-400/15 to-yellow-500/10',
    },
    afternoon: {
      primary: '#3B82F6', // Blue
      secondary: '#60A5FA', // Light blue
      accent: '#93C5FD', // Sky blue
      bg: 'from-blue-500/20 via-sky-400/15 to-cyan-500/10',
    },
    evening: {
      primary: '#F97316', // Orange
      secondary: '#FB923C', // Light orange
      accent: '#FDBA74', // Peach
      bg: 'from-orange-600/25 via-pink-500/20 to-purple-600/15',
    },
    night: {
      primary: '#6366F1', // Indigo
      secondary: '#8B5CF6', // Violet
      accent: '#A78BFA', // Purple
      bg: 'from-indigo-600/30 via-purple-500/25 to-violet-600/20',
    },
  };

  return {
    timeOfDay,
    istHour: worldState?.istHour || 20,
    colors: colors[timeOfDay],
  };
}

/**
 * Hook to access weather expression.
 */
export function useWeatherExpression() {
  const worldState = useWorldState();

  return worldState?.expression || {
    mood: 'pleasant' as const,
    intensity: 50,
    colors: {
      primary: '#60A5FA',
      secondary: '#C084FC',
      accent: '#F472B6',
    },
    particleBehavior: 'floating' as const,
    breathingSpeed: 1.0,
    description: 'Feeling balanced',
  };
}
