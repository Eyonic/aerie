// Contains a port of AMD FidelityFX Super Resolution 1.0
// (https://github.com/GPUOpen-Effects/FidelityFX-FSR)
// Copyright (c) 2021 Advanced Micro Devices, Inc.
// Licensed under the MIT License (see THIRD_PARTY_NOTICES.md).
// SPDX-License-Identifier: MIT
//
// Client-side GPU video upscaling (1080p → 2K) — AMD FidelityFX Super
// Resolution 1.0 (EASU upscale + RCAS sharpen) ported to WebGL2 GLSL.
// The server keeps streaming the original bits untouched; every decoded
// <video> frame is re-rendered by the VIEWER's own GPU onto a 2560×1440
// canvas. Desktop-only by design (phone GPUs + WebViews don't keep up).

const TARGET_W = 2560;
const TARGET_H = 1440;
const RCAS_SHARPNESS = 0.2; // FSR scale: 0 = sharpest; 0.2 is AMD's film default

const VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// EASU — edge-adaptive spatial upsampling. Faithful port of FsrEasuF from
// AMD's ffx_fsr1.h (MIT): 12-tap kernel, gradient-derived elliptical filter,
// clamped to the nearest-4 min/max so it never rings.
const EASU_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uSrc;
uniform vec2 uSrcSize;
in vec2 vUv;
out vec4 outColor;

vec3 tap(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(uSrcSize) - 1);
  return texelFetch(uSrc, p, 0).rgb;
}
float lum(vec3 c) { return c.g + 0.5 * (c.r + c.b); }

void setDir(inout vec2 dir, inout float len, float w,
            float lA, float lB, float lC, float lD, float lE) {
  float lenX = max(abs(lD - lC), abs(lC - lB));
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) / max(lenX, 1.0 / 32768.0), 0.0, 1.0);
  len += lenX * lenX * w;
  float lenY = max(abs(lE - lC), abs(lC - lA));
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) / max(lenY, 1.0 / 32768.0), 0.0, 1.0);
  len += lenY * lenY * w;
}

void acc(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len,
         float lob, float clp, vec3 c) {
  vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x))) * len;
  float d2 = min(dot(v, v), clp);
  float wB = 0.4 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB; wA *= wA;
  wB = 1.5625 * wB - 0.5625;
  float w = wB * wA;
  aC += c * w; aW += w;
}

void main() {
  vec2 pp = vUv * uSrcSize - 0.5;
  vec2 fp = floor(pp);
  pp -= fp;
  ivec2 q = ivec2(fp);
  //    b c        the 12-tap footprint around the sample point
  //  e f g h
  //  i j k l
  //    n o
  vec3 b = tap(q + ivec2(0, -1)), c = tap(q + ivec2(1, -1));
  vec3 e = tap(q + ivec2(-1, 0)), f = tap(q), g = tap(q + ivec2(1, 0)), h = tap(q + ivec2(2, 0));
  vec3 i = tap(q + ivec2(-1, 1)), j = tap(q + ivec2(0, 1)), k = tap(q + ivec2(1, 1)), l = tap(q + ivec2(2, 1));
  vec3 n = tap(q + ivec2(0, 2)), o = tap(q + ivec2(1, 2));
  float bL = lum(b), cL = lum(c), eL = lum(e), fL = lum(f), gL = lum(g), hL = lum(h);
  float iL = lum(i), jL = lum(j), kL = lum(k), lL = lum(l), nL = lum(n), oL = lum(o);
  vec2 dir = vec2(0.0);
  float len = 0.0;
  setDir(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  setDir(dir, len,        pp.x  * (1.0 - pp.y), cL, fL, gL, hL, kL);
  setDir(dir, len, (1.0 - pp.x) *        pp.y , fL, iL, jL, kL, nL);
  setDir(dir, len,        pp.x  *        pp.y , gL, jL, kL, lL, oL);
  float dirR = dot(dir, dir);
  bool zro = dirR < (1.0 / 32768.0);
  dirR = zro ? 1.0 : inversesqrt(dirR);
  dir.x = zro ? 1.0 : dir.x;
  dir *= dirR;
  len = len * 0.5;
  len *= len;
  float stretch = dot(dir, dir) / max(max(abs(dir.x), abs(dir.y)), 1.0 / 32768.0);
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  float clp = 1.0 / lob;
  vec3 min4 = min(min(f, g), min(j, k));
  vec3 max4 = max(max(f, g), max(j, k));
  vec3 aC = vec3(0.0);
  float aW = 0.0;
  acc(aC, aW, vec2( 0.0, -1.0) - pp, dir, len2, lob, clp, b);
  acc(aC, aW, vec2( 1.0, -1.0) - pp, dir, len2, lob, clp, c);
  acc(aC, aW, vec2(-1.0,  1.0) - pp, dir, len2, lob, clp, i);
  acc(aC, aW, vec2( 0.0,  1.0) - pp, dir, len2, lob, clp, j);
  acc(aC, aW, vec2( 0.0,  0.0) - pp, dir, len2, lob, clp, f);
  acc(aC, aW, vec2(-1.0,  0.0) - pp, dir, len2, lob, clp, e);
  acc(aC, aW, vec2( 1.0,  1.0) - pp, dir, len2, lob, clp, k);
  acc(aC, aW, vec2( 2.0,  1.0) - pp, dir, len2, lob, clp, l);
  acc(aC, aW, vec2( 2.0,  0.0) - pp, dir, len2, lob, clp, h);
  acc(aC, aW, vec2( 1.0,  0.0) - pp, dir, len2, lob, clp, g);
  acc(aC, aW, vec2( 1.0,  2.0) - pp, dir, len2, lob, clp, o);
  acc(aC, aW, vec2( 0.0,  2.0) - pp, dir, len2, lob, clp, n);
  vec3 pix = abs(aW) < 1e-5 ? f : min(max4, max(min4, aC / aW));
  outColor = vec4(pix, 1.0);
}`;

// RCAS — robust contrast-adaptive sharpening (FsrRcasF, denoise path omitted).
const RCAS_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uSrc;
uniform float uSharp; // = exp2(-sharpness)
in vec2 vUv;
out vec4 outColor;

vec3 tap(ivec2 p) {
  ivec2 sz = textureSize(uSrc, 0);
  p = clamp(p, ivec2(0), sz - 1);
  return texelFetch(uSrc, p, 0).rgb;
}

void main() {
  // Flip Y here (final pass): video frames upload with row 0 = top, but the
  // canvas displays row 0 at the bottom — without this the picture is
  // upside down. EASU stays an identity mapping, so one flip is exactly right.
  ivec2 sp = ivec2(vec2(vUv.x, 1.0 - vUv.y) * vec2(textureSize(uSrc, 0)));
  vec3 b = tap(sp + ivec2(0, -1));
  vec3 d = tap(sp + ivec2(-1, 0));
  vec3 e = tap(sp);
  vec3 f = tap(sp + ivec2(1, 0));
  vec3 h = tap(sp + ivec2(0, 1));
  vec3 mn4 = min(min(b, d), min(f, h));
  vec3 mx4 = max(max(b, d), max(f, h));
  vec3 hitMin = mn4 / (4.0 * mx4 + 1e-4);
  vec3 hitMax = (1.0 - mx4) / (4.0 * mn4 - 4.0 - 1e-4);
  vec3 lobeRGB = max(-hitMin, hitMax);
  float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * uSharp;
  outColor = vec4(((b + d + f + h) * lobe + e) / (4.0 * lobe + 1.0), 1.0);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s) || 'shader compile failed';
    gl.deleteShader(s);
    throw new Error(log.slice(0, 200));
  }
  return s;
}

function makeProgram(gl: WebGL2RenderingContext, frag: string) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
  return p;
}

function makeTexture(gl: WebGL2RenderingContext) {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

let _supported: boolean | undefined;
export function upscaleSupported(): boolean {
  if (_supported === undefined) {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      _supported = !!gl;
      (gl as WebGL2RenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      _supported = false;
    }
  }
  return _supported;
}

export class VideoUpscaler {
  onError?: (msg: string) => void;
  // Reports real pipeline dimensions (source → output) so the UI can prove
  // the upscale is actually happening rather than just showing a label.
  onResize?: (sw: number, sh: number, dw: number, dh: number) => void;
  private gl: WebGL2RenderingContext;
  private pEasu: WebGLProgram;
  private pRcas: WebGLProgram;
  private uEasuSrc: WebGLUniformLocation | null;
  private uEasuSize: WebGLUniformLocation | null;
  private uRcasSrc: WebGLUniformLocation | null;
  private uSharp: WebGLUniformLocation | null;
  private srcTex: WebGLTexture;
  private midTex: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private sw = 0; private sh = 0; private dw = 0; private dh = 0;
  private running = false;
  private vfc = 0;
  private raf = 0;

  constructor(private video: HTMLVideoElement, private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available on this device');
    this.gl = gl;
    this.pEasu = makeProgram(gl, EASU_FRAG);
    this.pRcas = makeProgram(gl, RCAS_FRAG);
    this.uEasuSrc = gl.getUniformLocation(this.pEasu, 'uSrc');
    this.uEasuSize = gl.getUniformLocation(this.pEasu, 'uSrcSize');
    this.uRcasSrc = gl.getUniformLocation(this.pRcas, 'uSrc');
    this.uSharp = gl.getUniformLocation(this.pRcas, 'uSharp');
    this.srcTex = makeTexture(gl);
    this.midTex = makeTexture(gl);
    this.fbo = gl.createFramebuffer()!;
    // The fullscreen-triangle vertex shader is attribute-less, but WebGL still
    // requires a bound VAO for drawArrays in some drivers.
    gl.bindVertexArray(gl.createVertexArray());
    canvas.addEventListener('webglcontextlost', ev => {
      ev.preventDefault();
      this.stop();
      this.onError?.('The GPU context was lost — upscaling turned off.');
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.draw();
    this.schedule();
  }

  stop() {
    this.running = false;
    const v = this.video as any;
    if (this.vfc && typeof v.cancelVideoFrameCallback === 'function') v.cancelVideoFrameCallback(this.vfc);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.vfc = this.raf = 0;
  }

  destroy() {
    this.stop();
    try { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* */ }
  }

  // Prefer requestVideoFrameCallback (fires exactly once per presented frame,
  // even for seeks while paused); rAF is the fallback for older engines.
  private schedule() {
    const v = this.video as any;
    if (typeof v.requestVideoFrameCallback === 'function') {
      this.vfc = v.requestVideoFrameCallback(() => this.frame());
    } else {
      this.raf = requestAnimationFrame(() => this.frame());
    }
  }

  private frame() {
    if (!this.running) return;
    this.draw();
    this.schedule();
  }

  private resize(sw: number, sh: number) {
    const gl = this.gl;
    this.sw = sw; this.sh = sh;
    // 2K target; never downscale (a >1440p source just passes through 1:1).
    const scale = Math.max(1, Math.min(TARGET_W / sw, TARGET_H / sh));
    this.dw = Math.round(sw * scale);
    this.dh = Math.round(sh * scale);
    this.canvas.width = this.dw;
    this.canvas.height = this.dh;
    gl.bindTexture(gl.TEXTURE_2D, this.midTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.dw, this.dh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.midTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.onResize?.(sw, sh, this.dw, this.dh);
  }

  private draw() {
    const gl = this.gl, v = this.video;
    if (gl.isContextLost()) return;
    if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) return;
    if (v.videoWidth !== this.sw || v.videoHeight !== this.sh) this.resize(v.videoWidth, v.videoHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v);
    } catch {
      return; // frame not ready / decoder hiccup — keep the previous frame
    }
    // Pass 1: EASU upscale into the intermediate texture.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.dw, this.dh);
    gl.useProgram(this.pEasu);
    gl.uniform1i(this.uEasuSrc, 0);
    gl.uniform2f(this.uEasuSize, this.sw, this.sh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Pass 2: RCAS sharpen onto the visible canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.dw, this.dh);
    gl.useProgram(this.pRcas);
    gl.bindTexture(gl.TEXTURE_2D, this.midTex);
    gl.uniform1i(this.uRcasSrc, 0);
    gl.uniform1f(this.uSharp, Math.pow(2, -RCAS_SHARPNESS));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
