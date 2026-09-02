import React from 'react';

declare module '@react-three/postprocessing' {
  export interface EffectComposerProps {
    enabled?: boolean;
    children?: React.ReactNode;
    depthBuffer?: boolean;
    enableNormalPass?: boolean;
    stencilBuffer?: boolean;
    autoClear?: boolean;
    resolutionScale?: number;
    multisampling?: number;
    renderPriority?: number;
  }

  export const EffectComposer: React.FC<EffectComposerProps>;

  export interface BloomProps {
    intensity?: number;
    luminanceThreshold?: number;
    luminanceSmoothing?: number;
    mipmapBlur?: boolean;
    radius?: number;
    levels?: number;
    opacity?: number;
  }

  export const Bloom: React.FC<BloomProps>;
}
