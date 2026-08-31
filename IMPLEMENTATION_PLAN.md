# Rebuild MadhuritaOrb as Real-Time 3D WebGL Experience

## Architecture Decision: WebGLRenderer + MeshPhysicalMaterial

After inspecting the codebase:
- **Three.js v0.185.1** is installed
- **@react-three/fiber v9**, **@react-three/drei v10**, **@react-three/postprocessing v3** are now installed
- Browser compatibility: WebGPU is still experimental on many browsers. **WebGLRenderer** is the safest choice.
- Three.js `MeshPhysicalMaterial` provides physically-based transmission, IOR, thickness, iridescence — sufficient for cinematic glass without custom shaders.
- Custom GLSL only for the internal energy/particle/waveform effects (a ShaderMaterial inner sphere).

## Key Finding: Audio Pipeline Is Disconnected

The `LiveClient` owns `AudioStreamer` and `AudioPlayer` instances (with `getStreamer()` / `getPlayer()`), but **these are never passed to the Orb**. `HomeStage` renders `<MadhuritaOrb>` without `streamer` or `player` props.

> [!IMPORTANT]
> The audio pipeline must be plumbed from `App.tsx → HomeStage → MadhuritaOrb` so the orb reacts to **real** microphone and TTS audio.

## Proposed Changes

### Component 1: Audio Pipeline Plumbing

#### [MODIFY] [App.tsx](file:///Users/ankitsingh/Madhurita/She-is-still-alive./src/App.tsx)
- Expose `liveClientRef.current?.getStreamer()` and `liveClientRef.current?.getPlayer()` as props passed to `HomeStage`.

#### [MODIFY] [HomeStage.tsx](file:///Users/ankitsingh/Madhurita/She-is-still-alive./src/components/home/HomeStage.tsx)
- Accept `streamer` and `player` props and forward them to `<MadhuritaOrb>`.

---

### Component 2: Complete Orb Rebuild with React Three Fiber

#### [MODIFY] [MadhuritaOrb.tsx](file:///Users/ankitsingh/Madhurita/She-is-still-alive./src/components/MadhuritaOrb.tsx)

Delete entire current implementation. Replace with:

**R3F `<Canvas>` Scene Architecture:**
1. **Outer Glass Sphere** — `THREE.MeshPhysicalMaterial` with:
   - `transmission: 0.92`, `thickness: 2.2`, `ior: 1.45`
   - `roughness: 0.03`, `metalness: 0.0`
   - `iridescence: 0.15`, `iridescenceIOR: 1.3`
   - `clearcoat: 1.0`, `clearcoatRoughness: 0.05`
   - `envMapIntensity` driven by time-of-day
   - Specular highlights from directional + ambient lights
   - Subtle `emissive` glow matching voice state

2. **Inner Energy Core** — A smaller sphere with custom `ShaderMaterial`:
   - GLSL vertex/fragment shaders for volumetric nebula/energy
   - Uniforms driven by `uTime`, `uAudioVolume`, `uFrequencyBands`, `uVoiceState`
   - Internal turbulence, particle vortex, stardust noise

3. **Equator Waveform Ring** — `THREE.Line` or `THREE.TubeGeometry`:
   - 128-point ring at the sphere equator
   - Vertex positions driven every frame by `analyser.getByteTimeDomainData()`
   - Real audio, not decorative

4. **Acoustic Ripple Rings** — 3 concentric `THREE.RingGeometry` meshes:
   - Expand outward during listening/speaking
   - Alpha fades with distance
   - Scale driven by audio amplitude

5. **Environment Lighting** — Time-of-day adaptive:
   - **NIGHT**: cool indigo directional + dim ambient, low `envMapIntensity`
   - **SUNRISE**: warm peach/gold directional, medium ambient
   - **DAY**: bright cool-white directional, high ambient
   - **SUNSET**: warm amber/orange directional, warm ambient
   - All lights animated with smooth transitions

6. **Environment Map** — `@react-three/drei` `<Environment>` or procedural:
   - Generates realistic reflections on the glass sphere
   - Time-of-day aware color grading

7. **Post-Processing** — `@react-three/postprocessing`:
   - Subtle bloom (`luminanceThreshold: 0.7`)
   - Tone mapping (ACES Filmic)

8. **Contact Glow / Lake Reflection** — CSS-based glow below the R3F canvas:
   - Soft radial gradient matching orb color
   - Responds to audio amplitude

**Performance:**
- Device-aware DPR: `Math.min(window.devicePixelRatio, 2)`
- `frameloop="demand"` with `invalidate()` on state changes
- Reduced particle counts on mobile
- `prefers-reduced-motion` fallback
- Efficient uniforms — no per-frame allocations

**Voice State Mapping (from existing `LiveState` + `isThinking`):**
- `disconnected` → `idle`
- `connecting` → `processing`
- `listening` + mic audio → listening state + mic-reactive waveform
- `speaking` + TTS audio → speaking state + TTS-reactive waveform
- `isThinking=true` → thinking vortex
- error prop → error state

**Responsive:**
- Canvas fills the orb container
- `size` prop controls the container (CSS) — R3F camera framing stays consistent
- Desktop: ~340px, Tablet: ~280px, Mobile: ~220px
- Same cinematic composition at all sizes

---

### Component 3: BackgroundAtmosphere (No Changes Needed)

The photographic background and canvas-based lake reflections remain as-is. The orb's CSS contact glow creates the visual bridge.

## Verification Plan

### Automated Tests
- `npm test` — all 28 invariants pass
- `npm run build` — clean production build with 0 errors

### Manual Verification
- Visual: Desktop, tablet, mobile — orb looks like real 3D glass
- Time-of-day: Night, Sunrise, Day, Sunset — lighting + colors adapt
- Voice: Idle, Listening, Thinking, Processing, Speaking, Error
- Audio: Real microphone input drives waveform, real TTS drives speaking waveform
- Performance: Smooth 60fps on desktop, graceful degradation on mobile
