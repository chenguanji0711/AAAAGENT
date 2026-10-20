import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoMatte, MATTE_LOW, MATTE_HIGH } from '../video-pet-matte.mjs';

/** A 2D context whose "drawImage" seeds the canvas from the fake video's pixels. */
function flatContext(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  return {
    pixels,
    drawImage(video) { pixels.set(video.pixels); },
    getImageData() { return { width, height, data: new Uint8ClampedArray(pixels) }; },
    putImageData(image) { pixels.set(image.data); }
  };
}
/** Records the WebGL calls the matte is required to make. */
function glContext(calls) {
  const handle = name => ({ name });
  return {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TEXTURE_2D: 8, RGBA: 9, UNSIGNED_BYTE: 10,
    TEXTURE_WRAP_S: 11, TEXTURE_WRAP_T: 12, CLAMP_TO_EDGE: 13, TEXTURE_MIN_FILTER: 14,
    TEXTURE_MAG_FILTER: 15, LINEAR: 16, TRIANGLE_STRIP: 17,
    createShader: () => handle('shader'), shaderSource: () => {}, compileShader: () => {},
    getShaderParameter: () => true, createProgram: () => handle('program'), attachShader: () => {},
    linkProgram: () => {}, getProgramParameter: () => true, createBuffer: () => handle('buffer'),
    bindBuffer: () => {}, bufferData: (target, data) => calls.push(['bufferData', data.length]),
    getAttribLocation: () => 0, enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
    createTexture: () => handle('texture'), bindTexture: () => {},
    texParameteri: (target, name, value) => calls.push(['texParameteri', name, value]),
    useProgram: () => {}, getUniformLocation: (program, name) => name,
    uniform1i: (location, value) => calls.push(['uniform1i', location, value]),
    uniform1f: (location, value) => calls.push(['uniform1f', location, value]),
    texImage2D: (...rest) => calls.push(['texImage2D', rest[5]]),
    drawArrays: (mode, first, count) => calls.push(['drawArrays', mode, first, count]),
    getExtension: () => null, clear: () => {}
  };
}
function install(t, { gl = null, flat = null }) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  class Element {
    constructor(tag) {
      this.tag = tag; this.dataset = {}; this.style = {}; this.width = 0; this.height = 0;
      this.className = ''; this.removed = false;
      this.context = tag === 'canvas' ? (gl ? 'webgl' : flat ? '2d' : null) : null;
    }
    setAttribute(name, value) { this[name] = value; }
    getContext(kind) { if (kind === 'webgl' && gl) return gl; if (kind === '2d' && flat) return flat; return null; }
    remove() { this.removed = true; }
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { createElement: tag => new Element(tag) } });
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'document', saved); else delete globalThis.document; });
  return { Element };
}

test('the 2D path removes the black backdrop and un-premultiplies soft edges', t => {
  const flat = flatContext(2, 1); install(t, { flat });
  const video = { readyState: 2, pixels: new Uint8ClampedArray([0, 0, 0, 255, 4, 4, 6, 255]) };
  const matte = createVideoMatte(video, { width: 2, height: 1 });
  assert.equal(matte.stats.mode, '2d');
  assert.equal(matte.frame(), true);
  const [backdrop, edge] = [flat.pixels.slice(0, 4), flat.pixels.slice(4, 8)];
  assert.deepEqual([...backdrop], [0, 0, 0, 0], 'pure black backdrop becomes fully transparent');
  const coverage = Math.min(1, Math.max(0, (6 - MATTE_LOW * 255) / ((MATTE_HIGH - MATTE_LOW) * 255)));
  assert.equal(edge[3], Math.round(coverage * 255));
  assert.equal(edge[3], 128, 'a half-covered edge keeps half its coverage');
  assert.deepEqual([...edge.slice(0, 3)], [8, 8, 12], 'the edge is un-premultiplied instead of keeping the black fringe');
  assert.equal(matte.stats.frames, 1);
  assert.equal(matte.canvas.className, 'dsh-pet-video-matte');
});

test('the WebGL path uploads the frame, sets the thresholds and draws premultiplied alpha', t => {
  const calls = []; install(t, { gl: glContext(calls) });
  const video = { readyState: 2 };
  const matte = createVideoMatte(video);
  assert.equal(matte.stats.mode, 'webgl');
  matte.frame(); matte.frame();
  assert.deepEqual(calls.filter(call => call[0] === 'uniform1f').map(call => [call[1], call[2]]),
    [['uLow', MATTE_LOW], ['uHigh', MATTE_HIGH]]);
  assert.deepEqual(calls.find(call => call[0] === 'drawArrays'), ['drawArrays', 17, 0, 4]);
  assert.equal(calls.filter(call => call[0] === 'texImage2D').length, 2);
  assert.ok(calls.every(call => call[0] !== 'texImage2D' || call[1] === video));
  assert.equal(matte.stats.frames, 2);
});

test('a runtime without WebGL or a real 2D context reports an inactive matte', t => {
  install(t, {});
  const matte = createVideoMatte({ readyState: 2 });
  assert.equal(matte.stats.mode, 'off');
  assert.equal(matte.active, false);
  assert.equal(matte.frame(), false);
});

test('no frame is drawn before the clip has decoded one', t => {
  const flat = flatContext(1, 1); install(t, { flat });
  const matte = createVideoMatte({ readyState: 0, pixels: new Uint8ClampedArray(4) }, { width: 1, height: 1 });
  assert.equal(matte.frame(), false);
  assert.equal(matte.stats.frames, 0);
});
