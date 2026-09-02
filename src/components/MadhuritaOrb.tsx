import React, { useRef, useEffect, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbVisualState } from './state/visual-state.js';

// Uniforms that change every frame — avoid React re-renders via useFrame
interface OrbUniforms {
  [key: string]: THREE.IUniform<any>;
  uBaseColor: { value: THREE.Color };
  uEmissionColor: { value: THREE.Color };
  uEnergyLevel: { value: number };
  uWaveformAmplitude: { value: number };
  uTime: { value: number };
  uActivityMode: { value: number }; // 0=idle, 1=listening, 2=speaking, 3=processing, 4=error, 5=connecting
  uResolution: { value: THREE.Vector2 };
}

// Photographic orb fragment shader (Part XVIII: WebGPU/WGSL with WebGL2 fallback)
const FRAGMENT_SHADER = `
uniform vec3 uBaseColor;
uniform vec3 uEmissionColor;
uniform float uEnergyLevel;
uniform float uWaveformAmplitude;
uniform float uTime;
uniform int uActivityMode;
uniform vec2 uResolution;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec2 vUv;

// Activity mode constants
#define MODE_IDLE 0
#define MODE_LISTENING 1
#define MODE_SPEAKING 2
#define MODE_PROCESSING 3
#define MODE_ERROR 4
#define MODE_CONNECTING 5

// Photographic noise for organic surface variation
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p *= 2.0;
    amplitude *= 0.5;
  }
  return value;
}

// Equator waveform: displacement along the sphere's equator (y ~ 0)
float equatorWave(vec3 pos, float amplitude, float time) {
  float latitude = asin(clamp(pos.y, -1.0, 1.0)); // -PI/2 to PI/2
  float equatorFactor = 1.0 - abs(latitude) / 1.5708; // 1 at equator, 0 at poles
  float wave = sin(pos.x * 8.0 + time * 4.0) * 0.5 + sin(pos.z * 6.0 - time * 3.0) * 0.5;
  return equatorFactor * wave * amplitude * 0.08;
}

// Fresnel for photographic rim lighting
float fresnel(vec3 viewDir, vec3 normal, float power) {
  return pow(1.0 - max(dot(viewDir, normal), 0.0), power);
}

// Subsurface scattering approximation for organic feel
vec3 subsurface(vec3 normal, vec3 lightDir, float thickness) {
  float scatter = max(dot(-lightDir, normal), 0.0);
  return vec3(1.0, 0.8, 0.6) * scatter * thickness * 0.15;
}

void main() {
  vec3 normal = normalize(vNormal);
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3)); // Simulated key light

  // Base material color with subtle surface variation
  float surfaceNoise = fbm(vUv * 3.0 + uTime * 0.1) * 0.02;
  vec3 base = uBaseColor * (1.0 + surfaceNoise);

  // Energy-driven emission intensity
  float emissionIntensity = uEnergyLevel * 0.8;

  // Equator displacement for audio reactivity
  float displacement = equatorWave(vWorldPosition, uWaveformAmplitude, uTime);

  // Apply displacement to normal for lighting (cheap normal perturbation)
  vec3 displacedNormal = normal;
  displacedNormal.x += displacement * normal.x;
  displacedNormal.z += displacement * normal.z;
  displacedNormal = normalize(displacedNormal);

  // Lighting
  float NdotL = max(dot(displacedNormal, lightDir), 0.0);
  float ambient = 0.15;
  float diffuse = NdotL * 0.6;

  // Fresnel rim
  float rim = fresnel(viewDir, displacedNormal, 3.5);

  // Activity mode specific behaviors
  vec3 modeColor = uEmissionColor;
  float modePulse = 0.0;
  float modeBreath = 0.0;

  if (uActivityMode == MODE_LISTENING) {
    // Listening: gentle pulse, cool tone
    modePulse = sin(uTime * 2.5) * 0.3 + 0.7;
    modeBreath = sin(uTime * 1.2) * 0.15 + 0.85;
    modeColor = mix(uEmissionColor, vec3(0.2, 0.6, 1.0), 0.4);
  } else if (uActivityMode == MODE_SPEAKING) {
    // Speaking: strong pulse synced to waveform
    modePulse = 0.5 + uWaveformAmplitude * 1.5;
    modeBreath = 1.0;
    modeColor = uEmissionColor;
  } else if (uActivityMode == MODE_PROCESSING) {
    // Processing: rotating/swirling thought pattern
    float swirl = sin(vUv.x * 6.28 + uTime * 1.5) * cos(vUv.y * 6.28 - uTime * 1.0) * 0.5 + 0.5;
    modePulse = 0.4 + swirl * 0.4;
    modeBreath = 0.7 + sin(uTime * 0.8) * 0.15;
    modeColor = uEmissionColor;
  } else if (uActivityMode == MODE_ERROR) {
    // Error: sharp red pulse
    modePulse = 0.3 + abs(sin(uTime * 5.0)) * 0.7;
    modeBreath = 0.5 + sin(uTime * 3.0) * 0.2;
    modeColor = vec3(1.0, 0.1, 0.1);
  } else if (uActivityMode == MODE_CONNECTING) {
    // Connecting: slow breathing cyan
    modeBreath = sin(uTime * 1.0) * 0.25 + 0.75;
    modePulse = modeBreath;
    modeColor = mix(uEmissionColor, vec3(0.0, 0.8, 1.0), 0.6);
  } else {
    // Idle: very subtle slow breath
    modeBreath = sin(uTime * 0.4) * 0.1 + 0.9;
    modePulse = modeBreath * 0.3;
    modeColor = uEmissionColor;
  }

  // Combine emission
  vec3 emission = modeColor * emissionIntensity * modePulse * rim * 2.0;

  // Subsurface glow at silhouette
  float thickness = 1.0 - abs(dot(viewDir, displacedNormal));
  vec3 sss = subsurface(displacedNormal, lightDir, thickness);

  // Final color composition
  vec3 color = base * (ambient + diffuse) + emission + sss;

  // Atmospheric perspective / depth cue
  float depth = length(vWorldPosition) * 0.01;
  color = mix(color, uBaseColor * 0.1, depth * 0.1);

  // Gamma correction for photographic output
  color = pow(color, vec3(1.0 / 2.2));

  gl_FragColor = vec4(color, 1.0);
}
`;

// Vertex shader with equator displacement
const VERTEX_SHADER = `
uniform float uTime;
uniform float uWaveformAmplitude;
uniform float uEnergyLevel;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec2 vUv;

// Equator displacement function (matches fragment)
float equatorWave(vec3 pos, float amplitude, float time) {
  float latitude = asin(clamp(pos.y, -1.0, 1.0));
  float equatorFactor = 1.0 - abs(latitude) / 1.5708;
  float wave = sin(pos.x * 8.0 + time * 4.0) * 0.5 + sin(pos.z * 6.0 - time * 3.0) * 0.5;
  return equatorFactor * wave * amplitude * 0.12; // Slightly stronger in vertex for geometry
}

void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);

  // Displace vertices along normal at equator for audio reactivity
  float displacement = equatorWave(position, uWaveformAmplitude, uTime);
  vec3 displaced = position + normal * displacement;

  // Subtle breathing scale from energy level
  float breathScale = 1.0 + uEnergyLevel * 0.05 + sin(uTime * 0.5) * 0.01;
  displaced *= breathScale;

  vWorldPosition = (modelMatrix * vec4(displaced, 1.0)).xyz;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
`;

// Activity mode to integer mapping
function activityModeToInt(mode: OrbVisualState['activityMode']): number {
  switch (mode) {
    case 'idle': return 0;
    case 'listening': return 1;
    case 'speaking': return 2;
    case 'processing': return 3;
    case 'error': return 4;
    case 'connecting': return 5;
    default: return 0;
  }
}

interface OrbMeshProps {
  visual: OrbVisualState;
  audioAnalyser?: AnalyserNode | null;
}

function OrbMesh({ visual, audioAnalyser }: OrbMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const { size } = useThree(); // Subscribe to canvas size changes for resolution uniform
  const uniformsRef = useRef<OrbUniforms>({
    uBaseColor: { value: new THREE.Color(visual.baseColor) },
    uEmissionColor: { value: new THREE.Color(visual.emissionColor) },
    uEnergyLevel: { value: visual.energyLevel },
    uWaveformAmplitude: { value: visual.waveformAmplitude },
    uTime: { value: 0 },
    uActivityMode: { value: activityModeToInt(visual.activityMode) },
    uResolution: { value: new THREE.Vector2(size.width, size.height) },
  });

  // Update uniforms from props (called from useFrame to avoid React re-renders)
  useEffect(() => {
    const u = uniformsRef.current;
    u.uBaseColor.value.set(visual.baseColor);
    u.uEmissionColor.value.set(visual.emissionColor);
    u.uEnergyLevel.value = visual.energyLevel;
    u.uWaveformAmplitude.value = visual.waveformAmplitude;
    u.uActivityMode.value = activityModeToInt(visual.activityMode);
  }, [visual.baseColor, visual.emissionColor, visual.energyLevel, visual.waveformAmplitude, visual.activityMode]);

  // Audio analyser data array (allocated once)
  const dataArrayRef = useRef<Uint8Array | null>(null);
  if (audioAnalyser && !dataArrayRef.current) {
    dataArrayRef.current = new Uint8Array(audioAnalyser.frequencyBinCount);
  }

  // Animation loop — drives time, audio reactivity, and uniform updates
  useFrame((_state, delta) => {
    const u = uniformsRef.current;

    u.uTime.value += delta;
    u.uResolution.value.set(size.width, size.height);

    // Pull live audio frequency data for equator waveform
    if (audioAnalyser && dataArrayRef.current) {
      audioAnalyser.getByteFrequencyData(dataArrayRef.current as unknown as Uint8Array<ArrayBuffer>);
      // Average low-mid frequencies (0-120Hz range roughly) for equator drive
      let sum = 0;
      const bins = Math.min(32, dataArrayRef.current.length);
      for (let i = 0; i < bins; i++) {
        sum += dataArrayRef.current[i] || 0;
      }
      const avg = sum / bins / 255; // Normalize 0-1
      // Smooth the waveform amplitude
      u.uWaveformAmplitude.value = THREE.MathUtils.lerp(u.uWaveformAmplitude.value, avg, 0.15);
    }
  });

  const material = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: uniformsRef.current,
      transparent: false,
      depthWrite: true,
    });
    return mat;
  }, []);

  // Cleanup material on unmount
  useEffect(() => {
    return () => {
      material.dispose();
    };
  }, [material]);

  return (
    <mesh
      ref={meshRef}
      geometry={new THREE.SphereGeometry(1, 64, 64)}
      material={material}
      onPointerOver={() => {}}
      onPointerOut={() => {}}
    />
  );
}

interface MadhuritaOrbProps {
  visual: OrbVisualState;
  audioAnalyser?: AnalyserNode | null;
  className?: string;
  style?: React.CSSProperties;
}

export function MadhuritaOrb({ visual, audioAnalyser = null, className = '', style = {} }: MadhuritaOrbProps) {
  // Fallback 2D indicator for when WebGL is unavailable
  const [webglError, setWebglError] = React.useState(false);

  const handleCreated = React.useCallback((state: { gl: THREE.WebGLRenderer }) => {
    // Listen for WebGL context loss so we can fall back to CSS rendering.
    state.gl.domElement.addEventListener(
      'webglcontextlost',
      (event: Event) => {
        event.preventDefault();
        setWebglError(true);
      },
      { once: true },
    );
  }, []);

  if (webglError) {
    // Photographic CSS fallback (Part XVIII fallback strategy)
    return (
      <div
        className={className}
        style={{
          ...style,
          width: '100%',
          height: '100%',
          borderRadius: '50%',
          background: `radial-gradient(circle at 35% 35%, rgba(255,255,255,0.8) 0%, ${visual.baseColor} 45%, ${visual.emissionColor} 90%)`,
          boxShadow: `0 0 50px ${visual.emissionColor}66, inset 0 0 30px rgba(255,255,255,0.4)`,
          transform: `scale(${1 + visual.waveformAmplitude * 0.15})`,
          transition: 'transform 0.1s linear, box-shadow 0.3s ease-out',
        }}
        data-testid="orb-fallback"
        role="img"
        aria-label={`Madhurita orb: ${visual.activityMode}`}
      />
    );
  }

  return (
    <div
      className={className}
      style={{
        ...style,
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        borderRadius: '50%',
      }}
      data-testid="madhurita-orb"
      role="img"
      aria-label={`Madhurita orb: ${visual.activityMode}`}
    >
      <Canvas
        camera={{ position: [0, 0, 2.8], fov: 35 }}
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: false }}
        onCreated={handleCreated}
        style={{ width: '100%', height: '100%', display: 'block' }}
      >
        <ambientLight intensity={0.3} />
        <directionalLight position={[2, 4, 1]} intensity={0.8} />
        <pointLight position={[-1, 1, 2]} intensity={0.4} color={visual.emissionColor} />
        <OrbMesh visual={visual} audioAnalyser={audioAnalyser} />
      </Canvas>
    </div>
  );
}

// Re-export for convenience
export type { OrbVisualState };