import { InteractionMotion } from './interaction-motion.mjs';
import { collectModelReferences } from './model-references.mjs';
import { normalizePresentationIntent } from '../contracts/presentation.ts';
import { ModelFeather } from './model-feather.mjs';
import { bindOpaqueEyewear } from './opaque-eyewear.mjs';
import presetCatalog from './assets/local-model/presets.json';
import configuredParameters from './config/parameter-map.json';
// Application adapter over the official SDK; SDK owns deformation, physics, blending and WebGL rendering.
import { CubismFramework } from './vendor/cubism/Framework/src/live2dcubismframework.ts';
import { CubismUserModel } from './vendor/cubism/Framework/src/model/cubismusermodel.ts';
import { CubismModelSettingJson } from './vendor/cubism/Framework/src/cubismmodelsettingjson.ts';
import { CubismMatrix44 } from './vendor/cubism/Framework/src/math/cubismmatrix44.ts';
import { CubismEyeBlink } from './vendor/cubism/Framework/src/effect/cubismeyeblink.ts';
import { CubismExpressionMotionManager } from './vendor/cubism/Framework/src/motion/cubismexpressionmotionmanager.ts';
import { CubismShaderManager_WebGL } from './vendor/cubism/Framework/src/rendering/cubismshader_webgl.ts';


const presets = new Map(presetCatalog.items.map(item => [item.id, item]));
const automaticItems = presetCatalog.items.filter(item => item.availability === 'automatic');
const faces = new Map(automaticItems.flatMap(item => (item.emotions ?? []).map(key => [key, item])));
const gestures = new Map(automaticItems.flatMap(item => (item.gestures ?? []).map(key => [key, item])));
const parameters = { mouthOpen:'ParamMouthOpenY', body:'ParamBodyAngleX', eyeX:'ParamEyeBallX', eyeY:'ParamEyeBallY', leftEye:'ParamEyeLOpen', rightEye:'ParamEyeROpen', breath:'ParamBreath', ...configuredParameters };
const headParameters = [parameters.headYaw, parameters.headPitch, parameters.headRoll];
const interactionParameters = [...headParameters, parameters.body, parameters.eyeX, parameters.eyeY].filter(Boolean);
const webglOwners = new Set();
export class JellyfishRenderer extends CubismUserModel {
  constructor(canvas, report = () => {}, options = {}) {
    super(); this.canvas = canvas; this.report = report; this.options = options;
    this.textures = []; this.expressions = new Map(); this.faceKey = ''; this.gestureKey = '';
    this.expressionParameters = new Set(); this.expressionValues = new Map(); this.previewParameters = new Set(); this.appearanceParameters = new Set();
    this.interaction = new InteractionMotion(); this.elapsed = 0; this.gestureManager = new CubismExpressionMotionManager(); this.previewManager = new CubismExpressionMotionManager(); this.framing = 'full';
    // No policy yet means no automatic animation, including before backend ready.
    this.automaticIds = new Set(); this.policyRevision = -1; this.previewValues = new Map();
  }
  async load() {
    this.gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!this.gl) throw new Error('这个窗口无法启用 WebGL');
    this.syncViewport();
    const base = new URL(this.options.assetBase ?? 'assets/local-model/', location.href);
    const read = async path => { const r = await fetch(new URL(path, base)); if (!r.ok && r.status !== 0) throw new Error(`模型文件加载失败：${path}`); return r.arrayBuffer(); };
    await this.loadRig(read);
    this.createRenderer(this.canvas.width, this.canvas.height);
    webglOwners.add(this);
    const renderer = this.getRenderer(); renderer.startUp(this.gl); renderer.loadShaders(new URL(this.options.shaderBase ?? 'vendor/cubism/Framework/Shaders/WebGL/', location.href).href); renderer.setIsPremultipliedAlpha(true);
    for (let i = 0; i < this.settings.getTextureCount(); i++) {
      const img = new Image(); img.src = new URL(this.settings.getTextureFileName(i), base).href; await img.decode();
      if (Math.max(img.width, img.height) > this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE)) throw new Error('设备不支持这张模型纹理的尺寸');
      const gl = this.gl, tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      let source=img;
      // Dense embroidery needs prefiltered minification at desktop scale. WebGL1
      // needs power-of-two dimensions for mipmaps; retain the original source file
      // and resample only the isolated accessory's GPU upload, never the atlas.
      const lace=this.opaqueEyewear && i===this.opaqueEyewear.texture;
      if(lace){
        source=document.createElement('canvas');
        source.width=2**Math.ceil(Math.log2(img.width));source.height=2**Math.ceil(Math.log2(img.height));
        const context=source.getContext('2d');context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';
        context.drawImage(img,0,0,source.width,source.height);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      if(lace) gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lace?gl.LINEAR_MIPMAP_LINEAR:gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); renderer.bindTexture(i, tex); this.textures.push(tex);
    }
    this._modelMatrix.setHeight(1.9); this._modelMatrix.setPosition(0, 0);
    this.syncViewport(true);
    const attributes = this.gl.getContextAttributes();
    const bounds = this.canvas.getBoundingClientRect();
    this.report({ type: 'model-loaded', parameters: this._model.getParameterCount(), drawables: this._model.getDrawableCount(), expressions: this.expressions.size, textures: this.textures.length, canvas: [this._model.getCanvasWidth(), this._model.getCanvasHeight()], renderTarget: [this.canvas.width,this.canvas.height], backingScale: bounds.width>0?this.canvas.width/bounds.width:0, antialias: attributes?.antialias === true, alpha: attributes?.alpha === true, premultipliedAlpha: attributes?.premultipliedAlpha === true, maxTextureSize: this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE), runtime: 'Cubism5-r.5' });
    this.ready = true; this.last = performance.now();
  }
  // Shared by the real WebGL loader and silent tests of the actual Cubism rig.
  async loadRig(readAsset) {
    CubismFramework.startUp({ logFunction: message => this.report({ type: 'sdk', message }), loggingLevel: 3 }); CubismFramework.initialize();
    const buffers = new Map();
    const read = async path => {
      if (typeof path !== 'string' || /^[/.]|[:%\\]/.test(path) || path.split('/').includes('..')) throw new Error('模型资源路径不可用');
      if (!buffers.has(path)) buffers.set(path, await readAsset(path));
      return buffers.get(path);
    };
    const settingsBuffer = await read('pet.model3.json');
    const manifest = JSON.parse(new TextDecoder().decode(settingsBuffer));
    const references = collectModelReferences(manifest);
    const paths = [...new Set(['pet.model3.json', ...references.fingerprint].filter(Boolean))].sort();
    const hash = async buffer => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
    let binding = '';
    for (const path of paths) binding += path + '\0' + await hash(await read(path)) + '\n';
    const fingerprint = await hash(new TextEncoder().encode(binding));
    if (fingerprint !== presetCatalog.modelFingerprint) throw new Error('模型与预设目录版本不一致');
    this.settings = new CubismModelSettingJson(settingsBuffer, settingsBuffer.byteLength);
    this.loadModel(await read(this.settings.getModelFileName()), true);
    if (!this._model) throw new Error('Cubism 未能解析模型');
    this.opaqueEyewear = bindOpaqueEyewear(this._model.getModel().drawables, manifest.DesktopPet?.opaqueEyewear, this.settings.getTextureCount());
    if (this.settings.getPhysicsFileName()) { const physics = await read(this.settings.getPhysicsFileName()); this.loadPhysics(physics, physics.byteLength); }
    if (this.settings.getPoseFileName()) { const pose = await read(this.settings.getPoseFileName()); this.loadPose(pose, pose.byteLength); }
    this.blink = CubismEyeBlink.create(this.settings);
    this.parameterIndices = new Map(Array.from(this._model.getModel().parameters.ids, (id, i) => [id, i]));
    const supported = new Set(automaticItems.map(item => item.expressionName));
    const appearance = new Set(presetCatalog.items.filter(item => item.category === 'appearance').map(item => item.expressionName));
    for (let i = 0; i < this.settings.getExpressionCount(); i++) {
      const name = this.settings.getExpressionName(i), b = await read(this.settings.getExpressionFileName(i));
      this.expressions.set(name, this.loadExpression(b, b.byteLength, name));
      for (const parameter of JSON.parse(new TextDecoder().decode(b)).Parameters) {
        if (!this.parameterIndices.has(parameter.Id)) throw new Error('预设引用了模型不存在的参数');
        // Mouth amplitude stays on the actual playback clock, never expression easing.
        if (parameter.Id === parameters.mouthOpen) continue;
        this.previewParameters.add(parameter.Id);
        if (supported.has(name)) this.expressionParameters.add(parameter.Id);
        if (appearance.has(name)) this.appearanceParameters.add(parameter.Id);
      }
    }
    this.motionParameters = new Set();
    if (this.settings.getMotionCount('Idle') > 0) {
      const motion = await read(this.settings.getMotionFileName('Idle', 0));
      this.idle = this.loadMotion(motion, motion.byteLength, 'Idle'); this.idle.setLoop(true); this.idle.setEffectIds([], []);
      this.motionParameters = new Set(JSON.parse(new TextDecoder().decode(motion)).Curves.filter(c => c.Target === 'Parameter').map(c => c.Id));
    }
    this.runtimeParameters = new Set([...this.expressionParameters, ...this.motionParameters, ...interactionParameters, parameters.leftEye, parameters.rightEye, parameters.mouthForm, parameters.mouthOpen, parameters.breath].filter(id => id && this.parameterIndices.has(id)));
    for (const id of this.runtimeParameters) { if (!this.parameterIndices.has(id)) throw new Error('动作引用了模型不存在的参数'); this.previewParameters.add(id); this.appearanceParameters.delete(id); }
    // Keep the model's authored defaults; model-specific appearance stays in its resources.
    this._model.update();
    this.opaqueEyewear?.apply();
    this.defaults = Array.from(this._model.getModel().parameters.values);
  }
  set(name, value) { const m = this._model; const id = CubismFramework.getIdManager().getId(name); const i = m.getParameterIndex(id); if (i >= 0 && i < m.getParameterCount()) m.setParameterValueByIndex(i, value); }
  get(name) { return this._model.getParameterValueById(CubismFramework.getIdManager().getId(name)); }
  setAutomaticPolicy(policy) {
    // The host sends this sentinel at a backend-generation boundary. Other
    // foreign model IDs must not silently reset the monotonic revision guard.
    if (policy?.modelId === 'disconnected') this.policyRevision = -1;
    if (policy?.modelId !== presetCatalog.modelId) { this.policyValid = false; this.automaticIds.clear(); this.interaction.release(); this.clearAutomatic(); return false; }
    if (!Number.isSafeInteger(policy.revision) || policy.revision < 0 || policy.revision < this.policyRevision) return false;
    if (!Array.isArray(policy.enabledIds) || policy.enabledIds.some(id => presets.get(id)?.availability !== 'automatic')) { this.policyValid = false; this.automaticIds.clear(); this.interaction.release(); this.clearAutomatic(); return false; }
    const next = new Set(policy.enabledIds);
    if (this.policyValid && policy.revision === this.policyRevision) return next.size === this.automaticIds.size && [...next].every(id => this.automaticIds.has(id));
    this.policyValid = true; this.policyRevision = policy.revision; this.automaticIds = next;
    if (!['proc-head', 'proc-body', 'proc-blink'].some(id => next.has(id))) this.interaction.release();
    if (!this.previewMode) {
      let released = false;
      if (this.faceKey && !automaticItems.some(item => item.expressionName === this.faceKey && next.has(item.id))) { this._expressionManager.stopAllMotions(); this.faceKey = ''; released = true; }
      if (this.gestureKey && !automaticItems.some(item => item.expressionName === this.gestureKey && next.has(item.id))) { this.gestureManager.stopAllMotions(); this.gestureKey = ''; released = true; }
      if (released) this.expressionValues.clear();
      if (!next.has('motion-idle-0')) this._motionManager.stopAllMotions();
    }
    return true;
  }
  clearAutomatic() {
    if (!this.previewMode) this._motionManager.stopAllMotions();
    this._expressionManager.stopAllMotions(); this.gestureManager.stopAllMotions();
    this.faceKey = ''; this.gestureKey = ''; this.expressionValues.clear();
  }
  captureAppearance() {
    if (!this.defaults) return;
    for (const id of this.appearanceParameters) this.defaults[this.parameterIndices.get(id)] = this.get(id);
  }
  beginAttention(region = "body") {
    if (this.ready && !this.previewMode && this.policyValid && ['proc-head', 'proc-body', 'proc-blink'].some(id => this.automaticIds.has(id))) this.interaction.start(performance.now(), region);
  }
  configureMotion(settings) { this.interaction.configure(settings); }
  setLookAt(point) { this.interaction.setLookAt(point); }
  setAnimationState(name) {
    if (!this.ready || this.previewMode) return false;
    const accepted = this.interaction.request(name);
    if (accepted) this.report({type:'animation-state', state:name});
    return accepted;
  }
  reset({ preserveAttention = false } = {}) {
    if (!preserveAttention) this.interaction.release();
    this.clearAutomatic();
    if (this.previewMode) { this.stopPreview(); return; }
    // Release transient controls only; clothing/accessory state is not a turn.
    if (this._model && this.defaults) for (const id of this.runtimeParameters) if (!interactionParameters.includes(id)) this.set(id, this.defaults[this.parameterIndices.get(id)]);
  }
  enterPreview() {
    if (this.previewMode) return;
    this.clearAutomatic(); this.previewMode = true;
    this.previewBaseline = Array.from(this._model.getModel().parameters.values);
    for (const id of this.previewParameters) this.previewValues.set(id, this.get(id));
  }
  selectPreset(id) {
    const item = presets.get(id);
    if (!this._model || !item?.previewable || item.availability === 'unavailable') throw new Error('这个预设暂时不能预览');
    this.enterPreview(); this.previewManager.stopAllMotions(); this._motionManager.stopAllMotions(); this.previewSelection = item;
    if (item.expressionName) this.previewManager.startMotion(this.expressions.get(item.expressionName), false);
    return true;
  }
  stopPreview() {
    if (!this._model) return;
    this.enterPreview(); this.previewSelection = null; this.previewManager.stopAllMotions(); this._motionManager.stopAllMotions();
  }
  restorePreview() { this.stopPreview(); }
  blendParameters(parameters, values, delta) {
    const blend = 1 - Math.exp(-Math.max(0, delta) / .12);
    for (const id of parameters) {
      if (id === parameters.mouthOpen) continue;
      const target = this.get(id), previous = values.get(id) ?? target;
      const value = Math.abs(target - previous) < .0001 ? target : previous + (target - previous) * blend;
      values.set(id, value); this.set(id, value);
    }
  }
  updateView(view, interactionState = view.state, workFocus = false) {
    if (!this.ready || this.suspended) return;
    const now = performance.now(), rawDelta = (now - this.last) / 1000;
    const delta = Number.isFinite(rawDelta) ? Math.max(0, Math.min(rawDelta, .05)) : 0; this.last = now; this.elapsed += delta;
    if (!this.previewMode) this.captureAppearance();
    this._model.getModel().parameters.values.set(this.previewMode ? this.previewBaseline : this.defaults);
    const enabled = id => this.previewMode ? this.previewSelection?.id === id : this.automaticIds.has(id);
    const workActive=enabled('proc-work-focus') && (this.previewMode || workFocus && ['idle','error'].includes(view.state));
    if (this.idle && enabled('motion-idle-0')) {
      if (this._motionManager.isFinished()) this._motionManager.startMotionPriority(this.idle, false, 1);
      this._motionManager.updateMotion(this._model, delta);
      // Only scale authored motion axes. Eyelids, expressions and real mouth timing keep ownership.
      for (const id of [...headParameters,parameters.body,'ParamBodyAngleY','ParamBodyAngleZ']) {
        const index=this.parameterIndices.get(id);
        if(index!==undefined) this.set(id,this.defaults[index]+(this.get(id)-this.defaults[index])*this.interaction.settings.amount);
      }
    } else this._motionManager.stopAllMotions();
    if (enabled('proc-blink')) this.blink.updateParameters(this._model, delta);
    if (enabled('proc-breath')) this.set(parameters.breath, .5 + .5 * Math.sin(this.elapsed * 1.6));
    const rawExpression = workActive ? {emotion:'neutral',intensity:0,delivery:'',gesture:null} : view.invitation && view.state === 'idle' ? { emotion: 'neutral', intensity: 0, delivery: '', gesture: view.invitation.gesture } : view.expression;
    const expression = normalizePresentationIntent(rawExpression);
    const faceItem = faces.get(expression.emotion), gestureItem = gestures.get(expression.gesture);
    let face = '', gesture = '';
    if (!this.previewMode) {
      if (Object.hasOwn(expression, 'presetId')) {
        // A present null/unknown/disabled ID is explicitly neutral. It must not
        // fall back to the TTS emotion or the legacy gesture on the same reply.
        const item = presets.get(expression.presetId);
        if (item?.availability === 'automatic' && enabled(item.id)) {
          if (item.category === 'expression') face = item.expressionName;
          if (item.category === 'pose') gesture = item.expressionName;
        }
      } else {
        face = faceItem && enabled(faceItem.id) ? faceItem.expressionName : '';
        gesture = gestureItem && enabled(gestureItem.id) ? gestureItem.expressionName : '';
      }
    }
    if (face !== this.faceKey) { this._expressionManager.stopAllMotions(); if (face) this._expressionManager.startMotion(this.expressions.get(face), false); this.faceKey = face; }
    if (gesture !== this.gestureKey) { this.gestureManager.stopAllMotions(); if (gesture) this.gestureManager.startMotion(this.expressions.get(gesture), false); this.gestureKey = gesture; }
    this._expressionManager.updateMotion(this._model, delta); this.gestureManager.updateMotion(this._model, delta);
    if (this.previewMode) this.previewManager.updateMotion(this._model, delta);
    // The SDK managers reset on intent changes. Carry only supported expression
    // parameters across frames, so changing a face/pose does not pop to defaults.
    if (!this.previewMode) this.blendParameters(this.expressionParameters, this.expressionValues, delta);
    const active = !this.previewMode && view.state === 'speaking';
    const movement = this.interaction.sample({ now, delta, elapsed: this.elapsed, state: this.previewMode ? 'idle' : interactionState,
      head: enabled('proc-head')||workActive, body: enabled('proc-body')||workActive, blink: enabled('proc-blink')||workActive, work:workActive, reducedMotion:globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true });
    if (enabled('proc-head') || workActive) {
      this.set(parameters.headYaw, movement.yaw); this.set(parameters.headPitch, movement.pitch); this.set(parameters.headRoll, movement.roll);
      this.set(parameters.eyeX, movement.gazeX); this.set(parameters.eyeY, movement.gazeY);
    }
    if (workActive || enabled('proc-blink') && !this.previewMode) {
      this.set(parameters.leftEye, Math.min(this.get(parameters.leftEye), 1 - Math.max(movement.blink * .95, movement.sleep)));
      this.set(parameters.rightEye, Math.min(this.get(parameters.rightEye), 1 - Math.max(movement.blink * .95, movement.sleep)));
    }
    // Physics must see the complete body pose of this frame so hair and clothing respond.
    if (enabled('proc-body') || workActive) {
      this.set(parameters.body, this.get(parameters.body) + movement.body);
      for (const [id,value] of [['ParamBodyAngleY',movement.bodyY],['ParamBodyAngleZ',movement.bodyZ]])
        if(this.parameterIndices.has(id)) this.set(id,this.get(id)+value);
    }
    if (this._physics) this._physics.evaluate(this._model, delta);
    if (!active && !this.previewMode && enabled('proc-head')) {
      if (this.parameterIndices.has(parameters.mouthForm)) this.set(parameters.mouthForm,this.get(parameters.mouthForm)+movement.form);
      for (const id of ['ParamBrowLY','ParamBrowRY']) if(this.parameterIndices.has(id)) this.set(id,this.get(id)+movement.brow);
    }
    if (this.previewMode) this.blendParameters(this.previewParameters, this.previewValues, delta);
    // Expressions may shape the mouth; only real playback drives its opening.
    const amplitude = Number.isFinite(view.mouth) ? Math.max(0, view.mouth) : 0;
    this.set(parameters.mouthOpen, active ? Math.min(1, Math.sqrt(amplitude) * 1.9) : 0);
    this._pose?.updateParameters(this._model, delta);
    this._model.update();
    this.opaqueEyewear?.apply();
    this.draw();
  }
  setFraming(mode) {
    if (!['full', 'half'].includes(mode) || this.framing === mode && this.projection) return;
    if (mode === 'full') this.feather?.releaseTexture();
    this.framing = mode; this.syncViewport(true);
  }
  syncViewport(force = false) {
    if (!this.canvas) return;
    // A bounded 2x canvas also antialiases the large supplied textures on 1x screens.
    // No mip chain is allocated for the 8192/4096 texture sources.
    const dpr = Math.max(2, globalThis.devicePixelRatio || 1);
    const limit = this.gl?.getParameter(this.gl.MAX_RENDERBUFFER_SIZE) || 4096;
    const scale = Math.min(dpr, limit / Math.max(1, this.canvas.clientWidth, this.canvas.clientHeight));
    const width = Math.max(1, Math.round(this.canvas.clientWidth * scale)), height = Math.max(1, Math.round(this.canvas.clientHeight * scale));
    if (!force && this.canvas.width === width && this.canvas.height === height) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
      this.setRenderTargetSize(width, height);
    }
    if (!this._modelMatrix) return;
    const framing = parameters.framing?.[this.framing];
    const zoom = framing?.zoom ?? (this.framing === 'half' ? 1.8 : 1);
    this.projection = new CubismMatrix44();
    this.projection.scale(height / width * zoom, zoom); this.projection.multiplyByMatrix(this._modelMatrix);
    const translateY = framing?.translateY ?? (this.framing === 'half' ? -.65 : 0);
    this.projection.translateY(translateY);
  }
  draw() {
    this.syncViewport();
    const gl = this.gl; gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.getRenderer().setMvpMatrix(this.projection); this.getRenderer().setRenderState(null, [0, 0, this.canvas.width, this.canvas.height]); this.getRenderer().drawModel();
    if (this.framing === 'half') {
      this.feather ??= new ModelFeather(gl);
      if (!this.feather.apply(this.canvas) && !this.featherWarning) {
        this.featherWarning = true; this.report({ type: 'model-feather-unavailable', reason: this.feather.status });
      }
    }
  }
  setSuspended(value) { this.suspended = value === true; this.last = performance.now(); }
  snapshot() { return { mouth: this.get(parameters.mouthOpen), body: this.get(parameters.body), face: this.faceKey, gesture: this.gestureKey, breath: this.get(parameters.breath), animation: this.interaction.animation.snapshot() }; }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.ready = false; this.feather?.dispose();
    this.gestureManager.stopAllMotions(); this.gestureManager.release(); this.previewManager.stopAllMotions(); this.previewManager.release();
    for (const tex of this.textures) this.gl?.deleteTexture(tex);
    this.textures = []; this.expressions.clear(); this.previewValues.clear(); this.release();
    // The SDK renderer releases buffers/masks, but shader programs belong to its
    // context manager. Release that manager after our last canvas is disposed.
    if (webglOwners.delete(this) && webglOwners.size === 0) CubismShaderManager_WebGL.deleteInstance();
  }
}
