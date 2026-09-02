import React from 'react';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { useRendererTier } from '../RendererAdapter.js';

/**
 * Post-processing pipeline (Part XVIII.11, XVIII.14):
 *  - Bloom for luminous orb emission and specular highlights
 *  - Tone mapping + color grading
 *  - Tier-gated (disabled on LOW / MEDIUM)
 */
export function PostProcessing(): React.JSX.Element | null {
  const { config } = useRendererTier();

  if (!config.postEnabled) {
    return null;
  }

  return (
    <EffectComposer>
      <Bloom
        intensity={0.6}
        luminanceThreshold={0.7}
        luminanceSmoothing={0.3}
        mipmapBlur
      />
    </EffectComposer>
  );
}
