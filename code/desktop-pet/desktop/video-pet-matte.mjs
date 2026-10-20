// The shipped clips are opaque (VP9/YUV420p) with a pure black backdrop. A
// desktop pet has to float on the wallpaper, so black is turned into alpha at
// play time and the original files stay untouched on disk.
//
// The clips were authored by compositing the character over black, so every
// source pixel is already premultiplied by its coverage. Dividing the coverage
// back out keeps antialiased silhouettes from keeping a dark grey fringe.
const VERTEX = `attribute vec2 aPosition;
varying vec2 vFrame;
void main(){
  // Video rows arrive top-down; the quad's own axis is bottom-up.
  vFrame = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;
const FRAGMENT = `precision mediump float;
uniform sampler2D uFrame;
uniform float uLow;
uniform float uHigh;
varying vec2 vFrame;
void main(){
  vec3 source = texture2D(uFrame, vFrame).rgb;
  float level = max(max(source.r, source.g), source.b);
  float coverage = clamp((level - uLow) / (uHigh - uLow), 0.0, 1.0);
  vec3 straight = clamp(source / max(coverage, 0.00390625), 0.0, 1.0);
  // Premultiplied output, matching the default WebGL compositing contract.
  gl_FragColor = vec4(straight * coverage, coverage);
}`;
/** Defaults: the backdrop is exactly 0 and the encoder's ringing stops well
 *  below 10/255, so 2/255..10/255 removes the backdrop and keeps soft edges. */
export const MATTE_LOW = 2 / 255;
export const MATTE_HIGH = 10 / 255;

function shader(gl, kind, source) {
  const handle = gl.createShader(kind); gl.shaderSource(handle, source); gl.compileShader(handle);
  return gl.getShaderParameter(handle, gl.COMPILE_STATUS) ? handle : null;
}

function webglProgram(gl) {
  const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX), fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, 'uFrame'), 0);
  gl.uniform1f(gl.getUniformLocation(program, 'uLow'), MATTE_LOW);
  gl.uniform1f(gl.getUniformLocation(program, 'uHigh'), MATTE_HIGH);
  return {program, texture};
}

/**
 * Composites one video element onto a transparent canvas of the same layout box.
 * WebGL does the work on the GPU; a 2D readback path keeps older runtimes usable.
 */
export function createVideoMatte(video, {width = 640, height = 360} = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'dsh-pet-video-matte'; canvas.width = width; canvas.height = height;
  canvas.setAttribute('aria-hidden', 'true');
  const stats = {mode:'off', frames:0, low:MATTE_LOW, high:MATTE_HIGH};
  let gl = null, pipeline = null;
  try { gl = canvas.getContext?.('webgl', {alpha:true, premultipliedAlpha:true, antialias:false, depth:false, stencil:false}) ?? null; } catch { gl = null; }
  try { pipeline = gl ? webglProgram(gl) : null; } catch { pipeline = null; }
  let flat = null;
  if (!pipeline) { try { flat = canvas.getContext?.('2d', {willReadFrequently:true}) ?? null; } catch { flat = null; } }
  const usable2d = Boolean(flat && typeof flat.getImageData === 'function' && typeof flat.putImageData === 'function');
  stats.mode = pipeline ? 'webgl' : usable2d ? '2d' : 'off';

  function drawWebgl() {
    gl.bindTexture(gl.TEXTURE_2D, pipeline.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function drawFlat() {
    flat.drawImage(video, 0, 0, width, height);
    const image = flat.getImageData(0, 0, width, height), pixels = image.data;
    const low = MATTE_LOW * 255, high = MATTE_HIGH * 255;
    for (let i = 0; i < pixels.length; i += 4) {
      const level = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
      const coverage = Math.min(1, Math.max(0, (level - low) / (high - low)));
      const scale = coverage > 0 ? 1 / coverage : 0;
      pixels[i] = Math.min(255, pixels[i] * scale); pixels[i + 1] = Math.min(255, pixels[i + 1] * scale);
      pixels[i + 2] = Math.min(255, pixels[i + 2] * scale); pixels[i + 3] = Math.round(coverage * 255);
    }
    // ImageData is straight alpha, unlike the premultiplied WebGL path.
    flat.putImageData(image, 0, 0);
  }
  const paint = pipeline ? drawWebgl : usable2d ? drawFlat : null;

  function release() {
    if (gl) { try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {} }
  }
  return {
    canvas, stats,
    get active() { return paint !== null; },
    /** Draws the current frame. False while the clip has no decoded frame yet. */
    frame() {
      if (!paint || video.readyState < 2) return false;
      try { paint(); } catch { stats.mode = 'off'; release(); return false; }
      stats.frames++;
      return true;
    },
    reset() { stats.frames = 0; },
    dispose() { stats.mode = 'off'; release(); canvas.remove(); }
  };
}
