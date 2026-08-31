// ===================================================================
// useStage HOOK - Current active stage (single source of truth)
// ===================================================================

import { useState, useCallback, useMemo } from 'react';
import { StageKey } from '../utils/stage.js';
import { STAGES, getStage } from '../utils/stage.js';

export type { StageKey };

export interface UseStageResult {
  activeStage: StageKey;
  previousStage: StageKey | null;
  setStage: (key: StageKey) => void;
  goHome: () => void;
  isActive: (key: StageKey) => boolean;
  activePanel: ReturnType<typeof getStage>['panel'];
}

export function useStage(initial: StageKey = 'home'): UseStageResult {
  const [activeStage, setActiveStage] = useState<StageKey>(initial);
  const [previousStage, setPreviousStage] = useState<StageKey | null>(null);

  const setStage = useCallback((key: StageKey) => {
    setActiveStage((prev) => {
      if (prev === key) return prev;
      setPreviousStage(prev);
      return key;
    });
  }, []);

  const goHome = useCallback(() => {
    setActiveStage((prev) => {
      if (prev === 'home') return prev;
      setPreviousStage(prev);
      return 'home';
    });
  }, []);

  const isActive = useCallback(
    (key: StageKey) => activeStage === key,
    [activeStage],
  );

  const activePanel = useMemo(() => {
    const meta = getStage(activeStage);
    return meta.panel;
  }, [activeStage]);

  return {
    activeStage,
    previousStage,
    setStage,
    goHome,
    isActive,
    activePanel,
  };
}

export { STAGES };
