/**
 * Her, in one fragment shader.
 *
 * ## Why GLSL by hand and not a scene graph
 *
 * The repository already depends on `three` and `@react-three/*`. The previous
 * interface used them for a full cinematic scene — water, terrain, planar
 * reflections, a post-processing stack — and the verdict on it was that it felt
 * heavy and wrong. Rebuilding a lighter version of the same thing would carry the
 * same weight. What is actually on screen here is one soft light in a deep field,
 * and that is a hundred lines of arithmetic on a full-screen triangle: no meshes,
 * no camera, no attribute buffers, no render passes, and nothing to garbage
 * collect per frame.
 *
 * ## What each part is for
 *
 * 1. **The field.** A vertical fall from `secondary` down into `primary`, warped
 *    by low-frequency noise so it never reads as a linear gradient. Linear
 *    gradients are the single clearest tell of a cheap background.
 * 2. **Aurora.** Two drifting bands of `accent` in the upper field, at very low
 *    amplitude. This is where the sense of depth comes from; without it the field
 *    is flat no matter how good the gradient is.
 * 3. **Her.** A core with slow internal motion sampled in polar coordinates (so
 *    it turns rather than slides), a thin rim, and a wide halo. `uEnergy` is the
 *    only thing that brightens and quickens her, and it traces to which of the
 *    twelve stages her cycle is in.
 * 4. **The echo.** The field mirrored about the horizon, stretched and smeared.
 *    Three lines, and the largest single contributor to the picture reading as a
 *    room rather than a texture.
 * 5. **Dust.** Sparse specks on a hashed grid, drifting up. Faint enough to be
 *    felt rather than seen.
 * 6. **Vignette, desaturation, grain.** The grain is not decoration: a near-black
 *    vertical gradient bands visibly on an 8-bit display, and sub-LSB noise is the
 *    standard fix. The desaturation is driven by `uPresence` — see below.
 *
 * ## `uPresence` is a truth channel
 *
 * When the stream goes away the last `RuntimeState` stays on screen. A
 * full-brightness room over a dead connection would be the interface lying on her
 * behalf, so a lost stream drains the picture of light and colour. Nothing is
 * fabricated and no dialog appears; the room simply reports its own staleness.
 *
 * Compositing happens in linear space and is converted back on output, which is
 * the difference between colours that mix and colours that go muddy.
 */

/**
 * Full-screen triangle from `gl_VertexID` — three vertices, no buffers.
 *
 * Ids 0,1,2 map to clip-space (-1,-1), (3,-1), (-1,3): a triangle that covers the
 * viewport with one primitive and no attribute state to bind or leak.
 */
export const VERTEX_SOURCE = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform vec3  uPrimary;
uniform vec3  uSecondary;
uniform vec3  uAccent;
uniform float uDayness;
uniform float uTurbulence;
uniform float uEnergy;
uniform float uPresence;
uniform vec2  uPointer;

out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * valueNoise(p);
    p = p * 2.02 + 7.13;
    amp *= 0.5;
  }
  return sum;
}

vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toSrgb(vec3 c)   { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

void main() {
  vec2 res = max(uRes, vec2(1.0));
  vec2 uv = gl_FragCoord.xy / res;
  float aspect = res.x / res.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float t = uTime;

  vec3 primary   = toLinear(uPrimary);
  vec3 secondary = toLinear(uSecondary);
  vec3 accent    = toLinear(uAccent);

  // 1. The field.
  float horizon = 0.40 + 0.10 * uDayness;
  float warp = 0.045 * fbm(vec2(uv.x * 2.2 - t * 0.012, uv.y * 1.4));
  float fall = smoothstep(horizon + 0.44, horizon - 0.36, uv.y + warp);
  vec3 field = mix(secondary * (0.26 + 0.44 * uDayness), primary, fall);

  // 2. Aurora.
  float drift = t * (0.014 + 0.045 * uTurbulence);
  float band1 = fbm(vec2(uv.x * 1.7 + drift, uv.y * 3.1 - drift * 0.6));
  float band2 = fbm(vec2(uv.x * 2.9 - drift * 0.7, uv.y * 2.2 + 11.0));
  float sky = smoothstep(horizon - 0.06, 1.02, uv.y);
  float aurora = sky * (0.55 * pow(band1, 2.4) + 0.35 * pow(band2, 3.0));
  field += accent * aurora * (0.14 + 0.18 * uTurbulence) * (0.40 + 0.60 * uPresence);

  // 3. Her.
  //
  // Held above the horizon and above centre, which is what leaves the lower half
  // of the field free for the transcript to sit on. She is the light in the room,
  // not a widget in the middle of a page.
  vec2 centre = vec2(0.0, 0.135) + uPointer * vec2(0.014, 0.009);
  vec2 q = p - centre;
  float d = length(q);

  float breath = 0.5 + 0.5 * sin(t * 0.42);
  float pulse  = 0.5 + 0.5 * sin(t * (1.5 + 2.6 * uEnergy));
  float radius = 0.104 * (1.0 + 0.030 * breath + 0.060 * uEnergy * pulse);

  float swirl = fbm(vec2(atan(q.y, q.x) * 1.6 + t * 0.09, d * 7.0 - t * 0.16));
  float body = radius * (1.0 + 0.10 * (swirl - 0.5));

  float core = smoothstep(body, body * 0.12, d);
  float rim  = smoothstep(body * 1.03, body * 0.82, d) - smoothstep(body * 0.88, body * 0.56, d);
  float halo = exp(-d * (7.6 - 2.2 * uEnergy)) * 0.55;

  vec3 hot = mix(accent, vec3(1.0), 0.30 + 0.32 * uEnergy);
  vec3 her = hot * core * (0.40 + 0.34 * uEnergy)
           + hot * rim  * 0.62
           + accent * halo * (0.26 + 0.34 * uEnergy);
  field += her * (0.26 + 0.74 * uPresence);

  // 4. The echo.
  vec2 mirrored = (vec2(uv.x, 2.0 * horizon - uv.y) - 0.5) * vec2(aspect, 1.0);
  vec2 qr = (mirrored - centre) * vec2(1.0, 0.62);
  float smear = 1.0 + 2.8 * max(horizon - uv.y, 0.0);
  float echo = exp(-length(qr) * (9.0 / max(smear, 0.4))) * 0.30;
  float belowHorizon = smoothstep(horizon + 0.02, horizon - 0.24, uv.y);
  field += accent * echo * belowHorizon * (0.30 + 0.70 * uPresence) * (0.55 + 0.45 * uDayness);

  // 5. Dust.
  float dust = 0.0;
  vec2 grid = vec2(uv.x * aspect, uv.y) * 9.0;
  for (int i = 0; i < 2; i++) {
    vec2 cell = grid * (1.0 + float(i) * 0.7) + vec2(0.0, -t * (0.05 + 0.03 * float(i)));
    vec2 id = floor(cell);
    float seed = hash21(id + float(i) * 31.7);
    if (seed > 0.965) {
      float twinkle = 0.5 + 0.5 * sin(t * 1.3 + seed * 40.0);
      dust += smoothstep(0.07, 0.0, length(fract(cell) - 0.5)) * twinkle;
    }
  }
  field += accent * dust * 0.26 * uPresence;

  // 6. Vignette, desaturation, grain.
  float vignette = 1.0 - 0.52 * (1.0 - 0.45 * uDayness) * pow(length(p * vec2(0.78, 1.0)), 2.1);
  field *= clamp(vignette, 0.0, 1.0);

  vec3 colour = toSrgb(field);
  float grey = dot(colour, vec3(0.299, 0.587, 0.114));
  colour = mix(vec3(grey), colour, 0.34 + 0.66 * uPresence);
  colour += (hash21(gl_FragCoord.xy + fract(t) * 91.7) - 0.5) * (0.010 + 0.008 * (1.0 - uDayness));

  fragColor = vec4(colour, 1.0);
}
`;

/** Every uniform the fragment shader declares. The renderer resolves these once. */
export const UNIFORM_NAMES = [
  'uRes',
  'uTime',
  'uPrimary',
  'uSecondary',
  'uAccent',
  'uDayness',
  'uTurbulence',
  'uEnergy',
  'uPresence',
  'uPointer',
] as const;

export type UniformName = (typeof UNIFORM_NAMES)[number];
