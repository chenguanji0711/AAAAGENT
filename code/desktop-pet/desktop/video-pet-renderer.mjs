import { createFaceEffects } from './video-pet-face-effects.mjs';
import { createVideoMatte } from './video-pet-matte.mjs';
import { catalogEntries, presetActions, replyAction, workAction } from './video-pet-state.mjs';

const icons = { heart:'♡', cry:'💧', thumb:'👍', questions:'???', cloud:'☁', anger:'╬', sparkle:'✦', sweat:'💧', breath:'〰' };
/** States the pet holds on its own; a randomized flourish must never pick one of these. */
const HELD_STATES = new Set(['idle','listening','thinking','working','waiting','rest']);
/** One video element and one selected source. No full-library preloading or video/blob cache. */
export class VideoPetRenderer {
  constructor(canvas, report = () => {}) {
    this.canvas = canvas; this.report = report; this.ready = false; this.generation = 0;
    this.current = 'idle'; this.ambient = 'idle'; this.workState = 'idle'; this.patCount = 0; this.lastPat = -Infinity;
    this.root = document.createElement('div'); this.root.className = 'video-pet-root dsh-pet-root'; this.root.dataset.facing = 'left';
    this.video = document.createElement('video'); this.video.className = 'dsh-pet-video is-front';
    this.video.muted = true; this.video.playsInline = true; this.video.preload = 'none'; this.video.setAttribute('aria-label', '视频鲸鱼桌宠');
    // The shipped clips are opaque (black backdrop). The matte canvas paints only
    // the character over the wallpaper, while the video element stays as the
    // decoding and layout box that no longer shows its own background.
    this.matte = createVideoMatte(this.video);
    if (this.matte.active) this.root.className += ' is-matted';
    this.root.append(this.video, this.matte.canvas); canvas.after(this.root);
    this.effect = document.createElement('div'); this.effect.id = 'video-pet-effect'; this.effect.setAttribute('role','img');
    this.caption = document.createElement('div'); this.caption.id = 'video-pet-caption';
    this.shadow = document.createElement('canvas'); this.shadow.id = 'video-pet-shadow'; this.shadow.hidden = true;
    document.body.append(this.shadow, this.effect, this.caption);
    this.effects = createFaceEffects({ effect:this.effect, caption:this.caption, shadow:this.shadow });
    this.video.onended = () => { this.transient = false; this.resumeAmbient(); };
  }
  /** Drives the matte only while the clip is visible, so a hidden or collapsed pet costs nothing. */
  pumpFrames() {
    this.frameHandle = null;
    if (this.disposed || this.suspended || !this.ready) return;
    this.matte.frame();
    this.frameHandle = requestAnimationFrame(() => this.pumpFrames());
  }
  startFrames() { if (this.frameHandle == null && !this.disposed && !this.suspended && this.ready) this.frameHandle = requestAnimationFrame(() => this.pumpFrames()); }
  stopFrames() { if (this.frameHandle != null) { cancelAnimationFrame(this.frameHandle); this.frameHandle = null; } }
  async load() {
    this.base = new URL('assets/local-model/dsh-pet/', location.href);
    const response = await fetch(new URL('catalog.json', this.base)).catch(() => null);
    if (!response?.ok) throw Error('视频桌宠素材未安装，请切换 Live2D 或导入有权使用的视频素材。');
    this.catalog = await response.json(); this.entries = catalogEntries(this.catalog);
    if (!this.entries.has('idle')) throw Error('视频桌宠动作目录不完整。');
    this.canvas.hidden = true;
    await this.play('idle', { loop:true });
    this.ready = true; this.startFrames();
    this.report({type:'model-ready',runtime:'video',videoElements:1,preload:'none',actions:this.entries.size,
      backdrop:this.matte.active ? 'transparent' : 'opaque', backdropruntime:this.matte.stats.mode});
  }
  clearEffect() {
    clearTimeout(this.effectTimer); this.effects.setDark(false); this.effect.replaceChildren();
    this.effect.dataset.icon = ''; delete this.effect.dataset.aspect; this.caption.textContent = '';
  }
  showEffect(action) {
    this.clearEffect(); this.effects.setDark(['dark-face','pat-dark'].includes(action.id));
    this.effect.dataset.icon = action.icon ?? ''; this.effect.textContent = icons[action.icon] ?? '';
    this.effect.setAttribute('aria-label', action.label); this.caption.textContent = action.text ?? '';
    this.effectTimer = setTimeout(() => this.clearEffect(), 3000);
  }
  async play(id, { loop = false, transient = !loop, silent = false } = {}) {
    if (this.disposed) return false;
    const action = this.entries.get(id); if (!action) throw Error('未知视频动作');
    this.cancelLoad?.(); this.cancelLoad = null;
    const generation = ++this.generation; this.current = id; this.transient = transient;
    this.showEffect(action); this.root.dataset.action = id;
    if (action.kind === 'meme') {
      // A meme overlays the current idle video, with at most one decoded image.
      await this.play('idle', {loop:true});
      if (this.disposed || generation + 1 !== this.generation) return false;
      this.current = id; this.root.dataset.action = id; this.transient = true;
      clearTimeout(this.effectTimer);
      const img = document.createElement('img'); img.alt = action.label; img.src = new URL(action.file, this.base).href;
      this.effect.dataset.icon = 'meme'; this.effect.dataset.aspect = String(action.width / action.height || 1); this.effect.replaceChildren(img);
      this.effectTimer = setTimeout(() => { this.clearEffect(); this.transient = false; this.resumeAmbient(); }, 4000);
      return true;
    }
    this.video.pause(); this.video.loop = loop;
    this.video.src = new URL(action.file, this.base).href; this.root.dataset.animation = action.video;
    // Await only this requested file; cancellation removes handlers before changing src.
    const loaded = new Promise((resolve, reject) => {
      let done = false;
      const finish = error => { if (done) return; done = true; clearTimeout(timer); this.video.removeEventListener('loadeddata', loaded); this.video.removeEventListener('error', failed); if (this.cancelLoad === cancel) this.cancelLoad = null; error ? reject(error) : resolve(true); };
      const loaded = () => finish(); const failed = () => finish(Error('视频动作无法播放，请重试或切换 Live2D。'));
      const cancel = () => { if (done) return; done = true; clearTimeout(timer); this.video.removeEventListener('loadeddata', loaded); this.video.removeEventListener('error', failed); resolve(false); };
      const timer = setTimeout(failed, 12000); this.cancelLoad = cancel;
      this.video.addEventListener('loadeddata', loaded); this.video.addEventListener('error', failed);
    });
    this.video.load();
    if (!await loaded || this.disposed || generation !== this.generation) return false;
    if (!this.suspended) await this.video.play();
    this.matte.reset(); this.startFrames();
    // Optional hook so a deliberate one-shot action can also carry a locally shipped voice line.
    // Looping ambient states never speak, and a randomized flourish stays silent so it never
    // talks over the reply that just ended.
    if (!silent && !loop) this.onAction?.(id);
    return true;
  }
  request(id, options) { if (!this.entries || this.disposed) return; void this.play(id, options).catch(() => { if (!this.disposed) { this.report({type:'video-error'}); this.caption.textContent = '这个动作暂时无法播放'; } }); }
  async invoke(payload) {
    const ids = payload?.actions;
    if (!Array.isArray(ids) || !ids.length || ids.length > 2 || ids.some(id => !this.entries.has(id))) throw Error('每次请选择 1～2 个现有动作 ID');
    for (const id of ids) {
      if (!await this.play(id)) throw Error('动作已被新的交互中断');
      const generation = this.generation;
      await new Promise((resolve, reject) => {
        const started = performance.now();
        const poll = setInterval(() => {
          if (this.disposed) { clearInterval(poll); reject(Error('角色已切换')); }
          else if (this.generation !== generation) { clearInterval(poll); this.current === this.ambient ? resolve() : reject(Error('动作已被新的交互中断')); }
          else if (performance.now() - started > 30000) { clearInterval(poll); reject(Error('动作播放超时')); }
        }, 80);
      });
    }
    return this.snapshot();
  }
  resumeAmbient() { if (this.entries && !this.disposed) this.request(this.ambient, {loop:true}); }
  setAutomaticPolicy(policy) {
    this.enabledIds = policy?.modelId === 'disconnected' ? new Set() : new Set(policy?.enabledIds ?? []);
    return true;
  }
  presentReply(reply) {
    const id = replyAction(reply.expression, this.enabledIds);
    if (id !== 'idle') this.request(id);
  }
  workEvent(kind, state) {
    const action = workAction(kind, state);
    if (action === this.workState) return;
    this.workState = action;
    if (['success','error'].includes(action)) this.request(action);
  }
  updateView(_view, state = _view.state, workFocus = false) {
    if (!this.ready || this.disposed) return;
    // The clips animate their own mouth. Driving that animation with the real output
    // amplitude is what makes it follow the voice, and it adds no pixels of its own.
    this.effects.setSpeaking(state === 'speaking' ? _view.mouth : null);
    const open = this.effects.stats().mouthOpen;
    const rate = state === 'speaking' ? Math.min(1.6, 0.65 + 0.95 * open) : 1;
    if (this.video.playbackRate !== rate) this.video.playbackRate = rate;
    const next = state === 'thinking' ? 'thinking' : state === 'listening' ? 'listening' : state === 'error' ? 'error'
      : workFocus && ['working','waiting','thinking'].includes(this.workState) ? this.workState : 'idle';
    this.ambient = next;
    if (!this.transient && this.current !== next) this.request(next, {loop:true});
  }
  /** Actions the user's own automatic policy enabled, minus the states the pet already holds. */
  actionPool() {
    const enabled = this.enabledIds;
    const pool = new Set();
    for (const [preset, action] of Object.entries(presetActions)) {
      if (enabled && !enabled.has(preset)) continue;
      if (HELD_STATES.has(action) || action === this.lastRandom) continue;
      if (this.entries.has(action)) pool.add(action);
    }
    return [...pool];
  }
  /** After a spoken reply ends, one randomized action plays once and then ambient resumes. */
  afterSpeech() {
    if (!this.ready || this.disposed) return null;
    this.effects.setSpeaking(null);
    this.transient = false; this.ambient = 'idle';
    const pool = this.actionPool();
    if (!pool.length) { this.reset(); return null; }
    const id = pool[Math.floor(Math.random() * pool.length)];
    this.lastRandom = id;
    this.request(id, { transient: true, silent: true });
    this.report({ type: 'auto-action', action: id, pool: pool.length });
    return id;
  }
  beginAttention() { this.transient = false; this.ambient = 'listening'; this.request('listening', {loop:true}); }
  reset() { if (!this.ready) return; this.transient = false; this.ambient = 'idle'; this.effects.setSpeaking(null); this.request('idle', {loop:true}); }
  pat() {
    const now = performance.now(); if (now - this.lastPat < 250 || !this.ready) return;
    if (now - this.lastPat > 8000) this.patCount = 0;
    this.lastPat = now; this.patCount++;
    this.request(this.patCount >= 6 ? 'pat-dark' : this.patCount >= 3 ? 'pat-angry' : 'pat-gentle');
  }
  reassure() { this.patCount = 0; this.lastPat = -Infinity; this.request('affectionate'); }
  setFraming(mode) { this.root.dataset.framing = mode; }
  setSuspended(value) {
    this.suspended = value;
    if (value) { this.stopFrames(); this.effects.setSpeaking(null); this.video.playbackRate = 1; this.video.pause(); }
    else if (this.ready) { void this.video.play().catch(()=>{}); this.startFrames(); }
  }
  snapshot() { return {runtime:'video',action:this.current,animation:this.root.dataset.animation,videoElements:1,preload:this.video.preload,paused:this.video.paused,readyState:this.video.readyState,patCount:this.patCount,backdrop:this.matte.active ? 'transparent' : 'opaque',backdropruntime:this.matte.stats.mode,matteFrames:this.matte.stats.frames,mouthOpen:Number(this.effects.stats().mouthOpen.toFixed(3)),playbackRate:this.video.playbackRate}; }
  dispose() {
    this.disposed = true; this.ready = false; ++this.generation; this.cancelLoad?.(); this.stopFrames(); this.clearEffect(); this.effects.dispose();
    this.video.pause(); this.video.removeAttribute('src'); this.video.load();
    this.matte.dispose();
    this.root.remove(); this.effect.remove(); this.caption.remove(); this.shadow.remove(); this.canvas.hidden = false;
  }
}
