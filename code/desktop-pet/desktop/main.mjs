import { loadRendererReplacement } from './renderer-switch.mjs';
import {WakeController} from './wake-controller.mjs';
import { COMPANION_LABEL, isProductCharacter } from '../contracts/character.ts';
import { CaptureFeedback } from './capture-feedback.mjs';
import { WorkRecords } from './work-records.mjs';
import { WorkCard } from './work-card.mjs';
import { DesktopWorkbenchCard } from './workbench-card.mjs';
import { installDisplayControls } from './display-controls.mjs';
import { installPetWindowControls } from './pet-window-controls.mjs';
import { FrameScheduler } from './frame-scheduler.mjs';
import { normalizeMotionSettings, DEFAULT_MOTION_SETTINGS } from './animation-state.mjs';
import { toDeviceFailure, deviceFailureMessage } from '../media/capture-errors.ts';
import { PressToTalk, validVoiceKey } from './press-to-talk.ts';
import { DesktopChatLog } from './chat-log.ts';
import { DesktopViewState, DesktopConnectionState, scopeEquals } from './view-state.ts';
import { VideoPetRenderer } from './video-pet-renderer.mjs';
import { createAudioOutput } from './audio-output.mjs';
import { createVoiceLines } from './voice-lines.mjs';
import { BrowserPlaybackDriver } from '../media/browser-playback.ts';
import { DesktopPlaybackController } from './playback-controller.ts';
import { BrowserCaptureDriver } from '../media/browser-capture.ts';
import { DESKTOP_BRIDGE_VERSION } from '../contracts/desktop-bridge.ts';
const $ = id => document.getElementById(id);
const hosted = !!window.webkit?.messageHandlers?.shell;
const native = (name, value) => window.webkit?.messageHandlers?.[name]?.postMessage(value);
const report = value => native('diagnostic', value);
function readStoredAudio() { try { return JSON.parse(localStorage.getItem('petAudio') ?? 'null') ?? undefined; } catch { return undefined; } }
function writeStoredAudio(value) { try { localStorage.setItem('petAudio', JSON.stringify(value)); } catch {} }

// Motion knobs shared with the native host, which normalises and persists them (see
// native/motion-preferences.swift). The page mirrors what it is told; only a browser preview has
// no host to ask and falls back to localStorage.
let motionConfig = { ...DEFAULT_MOTION_SETTINGS };
let selectedAnimation = 'Idle';
function readStoredMotion() { try { return JSON.parse(localStorage.getItem('petMotion') ?? 'null') ?? undefined; } catch { return undefined; } }
function writeStoredMotion(value) { try { localStorage.setItem('petMotion', JSON.stringify(value)); } catch {} }
// One output level for the dynamic reply and the pre-recorded action lines alike.
// The native host owns the durable copy; a browser preview falls back to localStorage.
const audio = createAudioOutput({ initial: readStoredAudio(), persist: value => { writeStoredAudio(value); native('shell', { type: 'set_audio', muted: value.muted, volume: value.volume }); } });
const voiceLines = createVoiceLines({ base: new URL('assets/voice/', location.href), gain: () => audio.gain, busy: () => playback.busy });
const connection = new DesktopConnectionState();
const send = (value, generation = connection.generation) => {
  if (connection.current(generation) && connection.connected) native('desktop', { generation, message: value });
};
const view = new DesktopViewState();
const workSpeechView=new DesktopViewState();
let workNotice=null,workSpeechBlocked=false,backendSessionId=null;
const spokenNotices=new Set();
const chat = new DesktopChatLog();
const captureFeedback=new CaptureFeedback($);let captureFeedbackToken;
let wakeFeedbackToken,wakeRequestId=null,wakeUI={phase:'off',enabled:false};
const wakeLabels={connecting:'连接中',waiting:'等待唤醒',listening:'正在听',submitting:'正在提交',replying:'等待唤醒'};
const wake=new WakeController({
 createCapture:async options=>{const module=await import('../media/wake/browser-capture.ts');return new module.BrowserWakeCapture({...options,workletModuleUrl:new URL('./wake-recorder-worklet.js',import.meta.url)});},send,
 onState:state=>{wakeUI=state;const label=wakeLabels[state.phase];if(state.enabled&&label){const mode={label,phase:state.phase,keepLabel:true};if(wakeFeedbackToken===undefined||!captureFeedback.active)wakeFeedbackToken=captureFeedback.start(mode);else captureFeedback.configure(wakeFeedbackToken,mode);}else{if(wakeFeedbackToken!==undefined)captureFeedback.stop(wakeFeedbackToken);wakeFeedbackToken=undefined;}Promise.resolve().then(()=>renderUI());},
 onLevel:level=>{if(wakeFeedbackToken!==undefined)captureFeedback.level(wakeFeedbackToken,level);},
 onWake:wakeHit=>command({type:'start_voice',wakeHit},{wakeInput:true}),
 onFinish:()=>command({type:'finish_voice'},{wakeInput:true}),
 onCancel:()=>{if(wakeRequestId){wakeRequestId=null;command({type:'cancel'},{wakeInput:true});}}
});
let workInputSource='generic';
const records=new WorkRecords({get:$,action:a=>work.action(a),onClose:()=>markVisibleWork(),onSelect:id=>{workInputSource='generic';workbench.forgetBinding();work.focusRecord(id);}});
const work = new WorkCard({get:$,send,open:()=>panel(true),onState:s=>records.receive(s),onRecords:origin=>records.show(origin),onToggle:()=>{
 if(work.expanded){workInputSource='generic';workbench.forgetBinding();workbench.close(false);}markVisibleWork();restoreSelectedSource();requestedSourceFocus=true;lastUI='';renderUI();}});
const workbench=new DesktopWorkbenchCard({get:$,send:action=>send({channel:'workbench_action',action}),
 online:()=>connection.connected,openNative:command=>native('shell',command),
 visible:()=>workInputSource==='native'&&!petWindow.collapsed&&!records.isOpen&&panelOpen&&!$('drawer').hidden&&!$('drawer').inert,
 onOpen:()=>{workInputSource='native';work.forgetBinding();},voice:()=>$('voice').onclick()});
let companionRoute = null;
let inputScope = null, awaitingTranscript = false;
let lastInputRow = null, lastWorkOpen = false, preserveReading = false, requestedSourceFocus=false,lastSourceId=null;
const expandedInputs=new Set();
let textRequestId = null;
let inputFocusEpoch=0, interactionFocusEpoch=0, routeFocusEpoch=0;
let composing = false;
let presentationPolicy=null;
function applyPresentationPolicy(){
  if(!renderer?.ready)return;
  const policy=presentationPolicy??{modelId:'disconnected',revision:0,enabledIds:[]};
  const applied=renderer.setAutomaticPolicy(policy);
  if(presentationPolicy)report({type:'presentation-policy',modelId:policy.modelId,revision:policy.revision,enabledCount:policy.enabledIds.length,applied:applied===true});
}
let renderer, capturing, captureAllowed = false, voicePhase = 'idle', greeted = false;
let rendererKind = 'video', rendererBooted = false, rendererSwitch = Promise.resolve();
let initialDisplayResolve;
const initialDisplay = hosted ? new Promise(resolve => { initialDisplayResolve=resolve; }) : Promise.resolve();
function selectRenderer(kind) {
  if (!['video', 'live2d'].includes(kind)) return rendererSwitch;
  rendererKind = kind; $('model-kind').value = kind;
  rendererSwitch = rendererSwitch.then(async () => {
    if (renderer?.kind === rendererKind && renderer.ready) return;
    const selected = rendererKind;
    const previous = renderer;
    const oldCanvas = $('model');
    const canvas = oldCanvas.cloneNode(false);
    canvas.id = 'model-pending'; canvas.hidden = false;
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;visibility:hidden';
    oldCanvas.before(canvas);
    let next;
    $('loading').hidden = false; $('loading').textContent = '正在切换角色…';
    try {
      if (selected === 'video') next = new VideoPetRenderer(canvas, report);
      else {
        await loadCubismCore();
        const { JellyfishRenderer } = await import('./cubism-renderer.mjs');
        next = new JellyfishRenderer(canvas, report, {assetBase:'assets/local-model/'});
      }
      next.kind = selected;
      if (next.root) next.root.style.visibility = 'hidden';
      next.setFraming(display.mode);
      next.setSuspended?.(petWindow.collapsed || document.hidden);
      renderer = await loadRendererReplacement(previous, next);
      // A replacement instance starts on its own defaults, so the knobs and the current action are
      // pushed to it here too; this is not only a first-launch concern.
      applyMotionConfig({ requestCurrentAnimation: true });
      oldCanvas.remove(); canvas.id = 'model'; canvas.style.cssText = '';
      if (renderer.root) renderer.root.style.visibility = '';
      applyPresentationPolicy(); renderer.setFraming(display.mode);
      renderer.onAction = id => { speakLine(id); };
      $('loading').hidden = true; $('video-controls').hidden = selected !== 'video';
      if (!greeted) { greeted = true; setTimeout(() => { speakLine('session-start'); }, 1200); }
      if (selected === 'video') {
        $('video-action').replaceChildren(...[...renderer.entries.values()].map(action => { const option = document.createElement('option'); option.value = action.id; option.textContent = action.label; return option; }));
      }
      report({type:'renderer-selected',rendererKind:selected});
    } catch (error) {
      next?.dispose(); canvas.remove(); renderer = previous;
      if (previous?.ready) {
        rendererKind = previous.kind; $('model-kind').value = rendererKind;
        $('loading').hidden = true; $('video-controls').hidden = rendererKind !== 'video';
        native('shell', {type:'set_renderer',rendererKind});
      } else $('loading').textContent = error.code === 'LIVE2D_RESOURCES_MISSING' ? error.message : '角色加载失败，请在面板中切换角色';
      view.error = error.message; report({type:'model-error',rendererKind:selected}); panel(true); renderUI();
    }
  });
  return rendererSwitch;
}
let cubismCoreLoad;
function loadCubismCore() {
  if (cubismCoreLoad) return cubismCoreLoad;
  const loaded = window.Live2DCubismCore ? Promise.resolve() : new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/cubism/Core/live2dcubismcore.min.js';
    script.onload = () => resolve();
    script.onerror = () => { cubismCoreLoad = undefined; script.remove(); reject(Object.assign(new Error('Live2D SDK 未安装，请准备有权使用的 SDK 和模型后重新构建。'), {code:'LIVE2D_RESOURCES_MISSING'})); };
    document.head.append(script);
  });
  cubismCoreLoad = loaded.then(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { window.Live2DCubismCore.Version.csmGetVersion(); return; }
      catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    throw Object.assign(new Error('Live2D SDK 尚未就绪，请重新构建或切换角色。'), {code:'LIVE2D_RESOURCES_MISSING'});
  }).catch(error => { cubismCoreLoad = undefined; throw error; });
  return cubismCoreLoad;
}
let voiceRequestId = null, invitationPending = false, voiceRequestAt = 0, inputEventTiming=null;
function timedVoiceInput(at,source,run){const previous=inputEventTiming;inputEventTiming={at,source};try{return run();}finally{inputEventTiming=previous;}}
let introduction = null, introductionEpoch = 0, introductionFramePending = false;
let panelOpen = false, panelEpoch = 0, panelAnimation, panelCloseTimer;
let lastUI = '';
let awaitingTextTurn = false;
let bindingKey = false;
let managementOpening = false;
function managementResult(result) {
  if (!managementOpening || typeof result?.ok !== 'boolean') return;
  managementOpening = false; $('management').disabled = false; $('management').textContent = '控制台';
  $('management-notice').hidden = result.ok;
  $('management-notice').textContent = result.ok ? '' : '暂时无法打开控制台，请确认桌宠服务已启动后重试。';
}
$('management').onclick = () => {
  if (managementOpening) return;
  managementOpening = true; $('management').disabled = true; $('management').textContent = '打开中…';
  $('management-notice').hidden = true;
  native('shell', { type:'open_management' });
};
// The display controls only assign a WIDTH to the character, while the CSS keeps a fixed height, so
// dragging the resize handle wider used to letterbox the model instead of enlarging it. The page
// therefore applies the matching height itself and offers a one-click "as tall as the dialog".
let latestLayout = null;
function applyLayoutGeometry(value) {
  if (!value) return;
  const modelWidth = Number(value.modelWidth), modelHeight = Number(value.modelHeight);
  if (!Number.isFinite(modelWidth) || !Number.isFinite(modelHeight) || modelWidth <= 0) return;
  const character = document.getElementById('character');
  const pet = document.getElementById('pet');
  if (character) character.style.height = `${modelHeight}px`;
  // Mirror the native model/composer reservation without resizing the WebGL canvas.
  if (pet) pet.style.height = `${Number.isFinite(value.petHeight) ? value.petHeight : modelHeight + 36}px`;
  positionSpeechBubble();
  // The quick composer geometry comes from the native layout (own width, clamped to the screen and
  // inside the native clip). Place it with those numbers instead of centring it in the pet, which
  // used to overflow the clip whenever the model was narrower than the composer.
  const quickBox = $('quick-chat');
  if (quickBox && ['quickLeft', 'quickTop', 'quickWidth'].every(k => Number.isFinite(value[k]))
      && Number.isFinite(value.petLeft) && Number.isFinite(value.petTop)) {
    Object.assign(quickBox.style, {
      left: `${value.quickLeft - value.petLeft}px`,
      top: `${value.quickTop - value.petTop}px`,
      width: `${value.quickWidth}px`,
      bottom: 'auto',
      transform: 'none',
    });
  }
  // Model canvas may overhang the edge, but every control must stay inside the native clip.
  requestAnimationFrame(clampHudsToScreen);
}
const HUD_SELECTORS = ['quick-chat', 'speech-show', 'quick-show', 'pet-collapse', 'model-resize', 'work-badge', 'open', 'invitation'];
function clampHudsToScreen() {
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  if (!vw) return;
  const clip = latestLayout && ['clipLeft', 'clipTop', 'clipWidth', 'clipHeight'].every(k => Number.isFinite(latestLayout[k]))
    ? {left:latestLayout.clipLeft,top:latestLayout.clipTop,right:latestLayout.clipLeft+latestLayout.clipWidth,bottom:latestLayout.clipTop+latestLayout.clipHeight}
    : {left:0,top:0,right:vw,bottom:innerHeight};
  for (const id of HUD_SELECTORS) {
    const el = $(id);
    if (!el || el.hidden) continue;
    // Individual translate composes with the authored transform (including centring).
    // Clearing only this correction makes repeated acknowledgements idempotent.
    el.style.translate = 'none';
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const insetX=Math.min(6,Math.max(0,(clip.right-clip.left-r.width)/2));
    const insetY=Math.min(6,Math.max(0,(clip.bottom-clip.top-r.height)/2));
    const left=Math.max(0,clip.left)+insetX,right=Math.min(vw,clip.right)-insetX;
    const top=Math.max(0,clip.top)+insetY,bottom=Math.min(innerHeight,clip.bottom)-insetY;
    const dx=Math.min(Math.max(0,left-r.left),right-r.right);
    const dy=Math.min(Math.max(0,top-r.top),bottom-r.bottom);
    el.style.translate = `${dx}px ${dy}px`;
  }
}
window.addEventListener('resize', () => requestAnimationFrame(clampHudsToScreen));
const display = installDisplayControls({ get: $, shell: value => native('shell', value), setFraming: mode => renderer?.setFraming(mode) });
const receiveDisplay = display.receive;
display.receive = value => { receiveDisplay(value); latestLayout = value; applyLayoutGeometry(value); };
/**
 * The model width whose drawn height equals the dialog height, derived from the host's own numbers
 * rather than a hard-coded size: the same aspect the host uses to lay the model out. The host's own
 * 220..720 clamp is applied too, so a request outside it is clamped exactly like a drag would be.
 */
function drawerMatchedWidth(layout) {
  if (!layout) return null;
  const modelWidth = Number(layout.modelWidth), modelHeight = Number(layout.modelHeight), drawerHeight = Number(layout.drawerHeight);
  if (!Number.isFinite(modelWidth) || !Number.isFinite(modelHeight) || !Number.isFinite(drawerHeight)) return null;
  if (modelWidth <= 0 || modelHeight <= 0 || drawerHeight <= 0) return null;
  return Math.min(720, Math.max(220, drawerHeight / (modelHeight / modelWidth)));
}
/** Resizes the model so its height equals the dialog's height, using the host's own aspect. */
function fitModelToDrawer() {
  const width = drawerMatchedWidth(latestLayout);
  if (width === null) return;
  // The host persists this as petDisplay.width; begin/commit mirrors its own drag protocol.
  native('shell', { type: 'resize_model', phase: 'begin' });
  native('shell', { type: 'resize_model', phase: 'commit', width });
  report({ type: 'model-fitted-to-drawer', width: Math.round(width), drawerHeight });
}
const hold = new PressToTalk({
  start() {
    // A fresh physical hold supersedes pending generation, output or capture cleanup.
    if (!connection.connected) return false;
    command({ type: 'start_voice' }); return true;
  },
  finish() { command({ type: 'finish_voice' }); },
  cancel(early) {
    command({ type: 'cancel' });
    view.error = early ? '录音尚未开始，已取消，未发送。请按住直到提示正在听。' : '按键录音已取消，未发送。'; renderUI();
  }
});
const petWindow = installPetWindowControls({ get: $, shell: value => native('shell', value),
  panelOpen: () => panelOpen,
  // Clicking the character pats it and opens the conversation. It never closes an
  // already open conversation, so petting the character while chatting cannot dismiss it.
  onPetClick: event => {
    const region = regionForClick(event);
    if (renderer?.pat) renderer.pat();
    else rendererCapability('beginAttention', region);
    if (!workbench.isOpen && !panelOpen) panel(true);
  },
  // The window controls own the press; the page only mirrors it into a pose.
  onDragChange: applyDragState,
  onCollapse() {
    const focused = document.activeElement;
    const saved = { panel: panelOpen, workbench: workbench.isOpen, records: records.isOpen,
      recordOrigin: records.returnFocus, focusId: focused?.id,
      selection: typeof focused?.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null };
    ++panelEpoch; ++inputFocusEpoch; ++interactionFocusEpoch; ++introductionEpoch;
    introductionFramePending = false; panelAnimation?.cancel(); panelAnimation = null; clearTimeout(panelCloseTimer);
    // Finish only the display transition. The drawer DOM, drafts and playback stay alive.
    $('drawer').hidden = !panelOpen;
    workbench.close(false); records.close(false); display.cancel();
    bindingKey = false; $('hotkey-bind').textContent = '设置按键'; focused?.blur?.();
    return saved;
  },
  onRestore(saved) {
    $('drawer').inert = !panelOpen;
    if (saved?.workbench && panelOpen) workbench.open();
    if (saved?.records && panelOpen) records.show(saved.recordOrigin);
    const focused = saved?.focusId && $(saved.focusId);
    if (focused && !focused.hidden && !focused.disabled && panelOpen) {
      focused.focus({ preventScroll: true });
      if (saved.selection) focused.setSelectionRange?.(...saved.selection);
    }
    if (panelOpen) { fitComposer(); markVisibleWork(); presentNativeWork(); scheduleIntroductionAck(); }
  }
});
function hotkeyConfig(value) {
  const code = value && typeof value === 'object' ? value.code ?? null : value;
  if (!hold.configure(code)) return;
  $('hotkey-value').textContent = code ? ({ ArrowUp:'↑', ArrowDown:'↓', ArrowLeft:'←', ArrowRight:'→', Space:'空格', Enter:'回车' }[code] ?? code.replace(/^Key|^Digit/,'')) : '未绑定';
}
function hotkeyEvent(event) {
  const receivedAt=performance.now();
  if (event.type === 'cancel') { hold.cancel(); return; }
  if (bindingKey || composing) return;
  if (event.type === 'down' && !petWindow.collapsed) timedVoiceInput(receivedAt,'native-hotkey',()=>hold.down(event.code,event.repeat));
  else if (event.type === 'up') hold.up(event.code);
}
$('hotkey-bind').onclick = () => { hold.cancel(); bindingKey = true; $('hotkey-bind').textContent = '请按一个键…'; $('hotkey-bind').focus(); };
$('hotkey-bind').onkeydown = event => {
  if (!bindingKey) return;
  event.preventDefault(); event.stopPropagation?.();
  if (event.key === 'Escape') { bindingKey = false; $('hotkey-bind').textContent = '设置按键'; return; }
  if (event.isComposing || event.repeat || event.metaKey || event.ctrlKey || event.altKey || !validVoiceKey(event.code)) return;
  bindingKey = false; $('hotkey-bind').textContent = '更换按键'; hotkeyConfig(event.code);
  native('shell', { type: 'set_hotkey', code: event.code });
};
$('hotkey-clear').onclick = () => { bindingKey = false; hotkeyConfig(null); $('hotkey-bind').textContent = '设置按键'; native('shell', { type: 'set_hotkey', code: null }); };

/** Plays one cached action line and records only that it happened (never the audio or text). */
function speakLine(actionId) {
  void voiceLines.action(actionId).then(played => {
    if (played) report({ type: 'voice-line', action: actionId, category: voiceLines.stats.lastCategory, file: voiceLines.stats.lastFile });
  }).catch(() => {});
}

// The volume control governs the dynamic reply and the action lines together.
function renderAudio(state = audio.state) {
  const silent = state.muted || state.volume === 0;
  const toggle = $('audio-toggle');
  toggle.textContent = silent ? '🔇' : '🔊';
  toggle.setAttribute('aria-pressed', String(state.muted));
  toggle.title = toggle.ariaLabel = state.muted ? '取消静音' : '静音';
  $('audio-volume').value = String(Math.round(state.volume * 100));
  $('audio-volume').title = `音量 ${Math.round(state.volume * 100)}%`;
}
$('audio-toggle').onclick = () => { audio.set({ muted: !audio.state.muted }); };
$('audio-volume').oninput = () => { const volume = Number($('audio-volume').value) / 100; audio.set({ volume, muted: volume > 0 ? false : audio.state.muted }); };
audio.subscribe(state => { renderAudio(state); report({ type: 'audio-config', muted: state.muted, volume: state.volume }); });

const reconnect = document.createElement('button'); reconnect.id = 'reconnect'; reconnect.type = 'button'; reconnect.textContent = '重新连接'; reconnect.hidden = true;
$('status').after(reconnect);
reconnect.onclick = () => { if (connection.canRetry && !connection.active) { reconnect.disabled = true; native('shell', { type: 'reconnect' }); } };
const connectionText = () => ({ connecting: '正在连接对话服务…', disconnected: '对话服务已断开', failed: connection.reason === 'version' ? '对话服务版本不一致，请退出后重新启动' : '对话服务连接失败' }[connection.state]);
const features = { type: 'features', secureContext: isSecureContext, mediaDevices: !!navigator.mediaDevices?.getUserMedia, audioWorklet: typeof AudioWorkletNode !== 'undefined', userAgent: navigator.userAgent, origin: location.origin };
report(features);
function renderUI() {
  wake.observe({busy:!!capturing||voicePhase!=='idle'||awaitingTextTurn||awaitingTranscript||['listening','thinking','speaking'].includes(view.state)||workSpeechView.state==='speaking',playing:playback.busy});
  const uiKey = JSON.stringify([wakeUI.phase,wakeUI.detail,awaitingTextTurn, awaitingTranscript, work.expanded,work.state?.sourceInput?.draftId,workSpeechView.state, voicePhase, chat.revision, view.reply, view.error, view.state, view.characterId, view.invitation?.id, view.invitation?.text, connection.state, connection.reason, connection.canRetry, introduction?.id, introduction?.text]);
  if (uiKey === lastUI) return;
  lastUI = uiKey;
  const rows = chat.rows(view.characterId).map(row => {
    const item = document.createElement('div'); item.className = `chat-row ${row.kind}`;item.dataset.rowId=String(row.id);
    if(row.recordId){item.dataset.recordId=row.recordId;item.dataset.recordVersion=String(row.recordVersion);item.dataset.sourceScope=JSON.stringify(row.sourceScope);}
    const label = document.createElement('span'); label.className = 'chat-label';
    label.textContent = row.kind === 'user' ? `${row.sourceLabel??'你'}${row.status === 'sending' ? ' · 发送中' : row.status === 'failed' ? ' · 未送达' : ''}` : COMPANION_LABEL;
    const text = document.createElement('div'); text.textContent = row.text;
    item.append(label, text);
    if(row.kind==='user'&&row.text.length>140){const expanded=expandedInputs.has(row.id);text.className=expanded?'input-original':'input-original input-original-preview';const more=document.createElement('button');more.type='button';more.className='input-full-toggle';more.textContent=expanded?'收起全文':'查看输入全文';more.setAttribute('aria-expanded',String(expanded));more.onclick=()=>{if(expanded)expandedInputs.delete(row.id);else expandedInputs.add(row.id);preserveReading=true;lastUI='';renderUI();};item.append(more);}
    return item;
  });
  if (introduction) {
    const opening = document.createElement('section'); opening.id = 'introduction'; opening.className = 'introduction';
    const label = document.createElement('span'); label.className = 'introduction-label'; label.textContent = '开场 · 虚构设定';
    const text = document.createElement('div'); text.textContent = introduction.text; opening.append(label, text); rows.unshift(opening);
  }
  const log = $('reply'),scroller=$('conversation'), nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 36;
  const oldScroll = scroller.scrollTop, latestInput = chat.rows(view.characterId).filter(row=>row.kind==='user').at(-1)?.id;
  const sourceId=work.state?.sourceInput?.draftId;
  const sourceFocus=requestedSourceFocus||work.expanded&&(!lastWorkOpen||sourceId!==lastSourceId);
  const focusInput=sourceFocus?chat.sourceRowId(view.characterId,sourceId)??latestInput:latestInput;
  const showInput = requestedSourceFocus||latestInput!==lastInputRow||work.expanded!==lastWorkOpen||work.expanded&&sourceId!==lastSourceId;lastSourceId=sourceId;requestedSourceFocus=false;
  lastInputRow=latestInput;lastWorkOpen=work.expanded;
  log.replaceChildren(...rows);
  const inputRow=showInput?rows.find(row=>row.dataset?.rowId===String(focusInput)):null;
  if(preserveReading){scroller.scrollTop=oldScroll;preserveReading=false;}
  else if(inputRow)scroller.scrollTop=Math.max(0,(scroller.scrollTop||0)+inputRow.getBoundingClientRect().top-scroller.getBoundingClientRect().top);
  else scroller.scrollTop=nearBottom?scroller.scrollHeight:oldScroll;
  renderSpeechBubble();
  refreshQuickChat();
  $('status').textContent = connectionText() || view.error || (workSpeechView.state==='speaking'?'正在播报任务状态…':'') || (awaitingTranscript ? '正在转写…' : '') || (voicePhase === 'preparing' ? '正在准备麦克风…' : '') || ({ idle: wakeLabels[wakeUI.phase]||(wakeUI.phase==='error'?'唤醒已停止，请在网页重新开启':'我在这里'), listening: voicePhase === 'recording' ? '正在听你说 · 再点一次结束' : '正在准备麦克风…', thinking: '正在想怎么回应你…', speaking: '正在说话…', error: '这一轮没有完成' }[view.state]);
  $('thinking-indicator').hidden = !connection.connected || !!view.error || awaitingTranscript || !(awaitingTextTurn || view.state === 'thinking');
  reconnect.hidden = connection.active || !connection.canRetry; reconnect.disabled = connection.active;
  $('invitation').disabled = !connection.connected;
  $('voice').textContent = voicePhase === 'preparing' ? '取消准备' : voicePhase === 'recording' ? '说完了' : '开始语音';
  $('stop').hidden = (view.state === 'idle' || view.state === 'error')&&!workNotice;
  $('voice').disabled = !connection.connected || (voicePhase === 'idle' && !['idle', 'error'].includes(view.state));
  workbench.updateInputControls();
  $('send').disabled = !connection.connected || chat.pending(view.characterId);
  $('invitation').hidden = !view.invitation; $('invitation').textContent = view.invitation?.text ?? '';
  if (panelOpen) fitComposer();
  scheduleIntroductionAck();
}
// This presentation is never appended to chat or submitted as user/model text.
function scheduleIntroductionAck() {
  const current = introduction, epoch = introductionEpoch;
  if (!current || current.acknowledged || introductionFramePending || !connection.connected || !panelOpen || petWindow.collapsed || document.hidden) return;
  const visible = () => {
    if (epoch !== introductionEpoch || introduction !== current || !connection.current(current.generation) || !connection.connected || !panelOpen || petWindow.collapsed || document.hidden) return false;
    const node = $('introduction');
    if (!node || !node.getClientRects().length || $('drawer').hidden) return false;
    const rect = node.getBoundingClientRect(), clip = $('conversation').getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > clip.top && rect.top < clip.bottom && rect.right > clip.left && rect.left < clip.right;
  };
  introductionFramePending = true;
  requestAnimationFrame(() => {
    if (!visible()) { if (epoch === introductionEpoch) introductionFramePending = false; return; }
    // Give the visible content a paint opportunity before acknowledging it.
    requestAnimationFrame(() => {
      if (epoch === introductionEpoch) introductionFramePending = false;
      if (!visible() || current.acknowledged) return;
      send({ channel: 'command', command: { type: 'acknowledge_introduction', introductionId: current.id } }, current.generation);
      current.acknowledged = true;
    });
  });
}
$('conversation').addEventListener('scroll', scheduleIntroductionAck);
// Speech, quick input and the main drawer have independent user-owned visibility.
// Never derive either HUD switch from playback, connection or the drawer state.
let speechHidden = false, quickChatHidden = false, speechProgress = null, speechMeasuredHeight = 84, quickMeasuredHeight = 56;
function positionSpeechBubble() {
  const node=$('speech-bubble'), pet=$('pet'); if(!node||!pet)return;
  let left,top,width,maxHeight;
  if (latestLayout && ['speechLeft','speechTop','speechWidth','speechMaxHeight','petLeft','petTop'].every(k=>Number.isFinite(latestLayout[k]))) {
    left=latestLayout.speechLeft-latestLayout.petLeft; top=latestLayout.speechTop-latestLayout.petTop;
    width=latestLayout.speechWidth; maxHeight=latestLayout.speechMaxHeight;
  } else {
    // Browser preview stacks the HUD above the character; AppKit fits it on Mac.
    const p=pet.getBoundingClientRect();width=Math.min(260,innerWidth);maxHeight=Math.min(160,innerHeight/3);
    const h=Math.min(node.offsetHeight||84,maxHeight);
    left=p.width/2-width/2;top=-h-8;
  }
  Object.assign(node.style,{left:`${left}px`,right:'auto',top:`${top}px`,width:`${width}px`,maxHeight:`${maxHeight}px`});
}
function publishSpeechLayout() {
  const measured=Math.ceil($('speech-bubble').getBoundingClientRect().height);
  if(measured>0)speechMeasuredHeight=measured;
  const quickMeasured=Math.ceil($('quick-chat').getBoundingClientRect().height);
  if(quickMeasured>0)quickMeasuredHeight=quickMeasured;
  native('shell',{type:'set_chat_hud',visible:!speechHidden,height:speechMeasuredHeight,quickHeight:quickMeasuredHeight});
}
function renderSpeechBubble() {
  const node = $('speech-bubble'), textNode = $('speech-text');
  if (!node || !textNode) return;
  const last = [...chat.rows(view.characterId)].reverse().find(row => row.kind === 'assistant' && row.text?.trim());
  const partial = speechProgress && view.accepts(speechProgress.scope) ? speechProgress.text : '';
  const text = partial || last?.text || '我在这里，想聊什么？';
  if (textNode.textContent !== text) {
    const nearBottom = textNode.scrollHeight - textNode.scrollTop - textNode.clientHeight < 24;
    textNode.textContent = text;
    if (nearBottom) textNode.scrollTop = textNode.scrollHeight;
  }
  node.hidden = speechHidden;
  $('speech-show').hidden = !speechHidden;
  $('quick-chat').hidden = quickChatHidden;
  $('quick-show').hidden = !quickChatHidden;
  positionSpeechBubble();
  requestAnimationFrame(clampHudsToScreen);
}
function bindChatVisibility() {
  $('speech-hide').onclick = () => { speechHidden = true; renderSpeechBubble(); publishSpeechLayout(); $('speech-show').focus({preventScroll:true}); };
  $('speech-show').onclick = () => { speechHidden = false; renderSpeechBubble(); publishSpeechLayout(); $('speech-hide').focus({preventScroll:true}); };
  $('quick-hide').onclick = () => { quickChatHidden = true; renderSpeechBubble(); $('quick-show').focus({preventScroll:true}); };
  $('quick-show').onclick = () => { quickChatHidden = false; renderSpeechBubble(); refreshQuickChat(); $('quick-text').focus({preventScroll:true}); };
  renderSpeechBubble();
  publishSpeechLayout();
  const observer=new ResizeObserver(publishSpeechLayout);
  observer.observe($('speech-bubble'));observer.observe($('quick-chat'));
  window.addEventListener('resize',positionSpeechBubble);
}

// ── 快捷消息输入框（桌宠正下方，跟随窗口移动）─────────────────────────────────
function refreshQuickChat() {
  const input = $('quick-text'), send = $('quick-send'), box = $('quick-chat');
  if (!input || !send) return;
  send.disabled = !input.value.trim() || !connection.connected || chat.pending(view.characterId);
  if (box) box.dataset.busy = String(chat.pending(view.characterId));
  input.style.height = 'auto';
  input.style.height = `${Math.min(96, Math.max(22, input.scrollHeight || 22))}px`;
}
function submitQuickChat() {
  const input = $('quick-text');
  if (!input) return;
  const text = input.value.trim();
  if (!text || !connection.connected || chat.pending(view.characterId)) return;
  input.value = '';
  // Same path as the main composer, so routing, drafts and errors behave identically.
  const main = $('text');
  if (main) main.value = '';
  fitComposer();
  refreshQuickChat();
  command({ type: 'submit_text', text });
}
function bindQuickChat() {
  const input = $('quick-text'), send = $('quick-send');
  if (!input || !send) return;
  input.addEventListener('input', refreshQuickChat);
  input.addEventListener('keydown', event => {
    // Enter sends; Shift+Enter keeps the newline; IME composition must not submit.
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submitQuickChat();
  });
  send.addEventListener('click', () => submitQuickChat());
  refreshQuickChat();
}

function panel(open) {
  // Pet visibility and dialog visibility are independent; a collapsed pet used to block the panel.
  if(open&&panelOpen&&!$('drawer').hidden){workbench.schedulePresentation();scheduleIntroductionAck();return;}
  const epoch = ++panelEpoch;
  panelAnimation?.cancel(); panelAnimation = null;
  clearTimeout(panelCloseTimer);
  if (!open) {
    records.close(false);document.activeElement?.blur?.();
    bindingKey = false; $('hotkey-bind').textContent = '设置按键';
  }
  const drawer = $('drawer');
  panelOpen = open; drawer.inert = !open; $('open').hidden = true;
  document.body.dataset.panelOpen = String(open);
  $('open').setAttribute('aria-expanded', String(open));
  const animate = drawer.animate && !document.hidden && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const finishClose = () => { if (!panelOpen && epoch === panelEpoch && !drawer.hidden) { clearTimeout(panelCloseTimer); drawer.hidden = true; native('shell', { type: 'panel', open: false }); } };
  if (open) { drawer.hidden = false; markVisibleWork(); workbench.schedulePresentation(); native('shell', { type: 'panel', open: true }); }
  if (animate && !drawer.hidden) {
    panelAnimation = drawer.animate(open ? [{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}] : [{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(6px)'}], {duration:open ? 200 : 180,easing:'cubic-bezier(.2,.7,.2,1)'});
    // Occluded WKWebViews can suspend animation frames. Closing must still end.
    if (!open) panelCloseTimer = setTimeout(finishClose, 180);
    panelAnimation.finished.then(() => { if (!open) finishClose(); }, () => {});
  } else if (!open) finishClose();
  introductionEpoch++; introductionFramePending = false;
  if (open) { requestAnimationFrame(() => {
    if (panelOpen && !petWindow.collapsed && epoch === panelEpoch && !document.hidden && document.hasFocus?.() !== false&&!records.isOpen&&!workbench.isOpen) { fitComposer(); $('text').focus({ preventScroll: true }); }
  }); scheduleIntroductionAck(); }
}
function fitComposer() {
  const input = $('text'); input.style.height = 'auto';
  input.style.height = `${Math.min(120, Math.max(24, input.scrollHeight || 24))}px`;
}
const playback = new DesktopPlaybackController(new BrowserPlaybackDriver(() => audio.gain), scope => view.accepts(scope)||workSpeechView.accepts(scope), (requestId, event) => {
  const workOutput=workSpeechView.accepts(event.scope);
  (workOutput?workSpeechView:view).receive({type:'playback',playback:event});
  if(workOutput&&event.type==='started'&&workNotice)workNotice.started=true;
  if(workOutput&&event.type==='ended'&&workNotice?.started&&workNotice.workBinding)work.presented(workNotice.workBinding);
  if(workOutput&&['ended','stopped','error'].includes(event.type)){workNotice=null;workSpeechView.reset();}
  renderUI();
  send({ channel: 'playback', requestId, event });
  // A finished reply is followed by one randomized action; a cancelled or failed one
  // simply returns to the ambient state.
  if (event.type === 'ended') { if (typeof renderer?.afterSpeech === 'function') renderer.afterSpeech(); else renderer?.reset(); }
  else if (['stopped','error'].includes(event.type)) renderer?.reset();
  if (event.type === 'started' || ['ended','stopped','error'].includes(event.type)) report({ type: 'playback-state', event: event.type, timingBasis: event.timingBasis, model: renderer?.ready ? renderer.snapshot() : null });
});
function stopPlayback(scope) { playback.stop(scope); }
function restoreSelectedSource(){const source=work.state?.sourceInput;if(workInputSource==='generic'&&work.expanded&&source&&typeof source.draftId==='string'&&typeof source.text==='string'&&isProductCharacter(source.scope?.characterId)&&['original_input','legacy_saved_input'].includes(source.provenance))chat.restoreSource(source);}
function markVisibleWork(){if(workInputSource==='generic'&&!petWindow.collapsed&&!records.isOpen&&panelOpen&&!document.hidden&&!$('drawer').hidden&&work.expanded&&!$('work-card').hidden)work.presented();}
function displayedInputBinding(){if(workInputSource==='native'){const binding=workbench.inputBinding();return binding?{workbenchBinding:binding}:null;}
 const binding=work.inputBinding();return binding?{workBinding:binding}:null;}
function presentNativeWork(){
 if(!workbench.needsPresentation()||document.hidden||petWindow.collapsed)return;
 records.close(false);panel(true);workbench.open();
 const card=$('workbench-draft'),content=$('workbench-content');
 if(card&&content.contains(card))content.scrollTop=card.offsetTop-content.offsetTop;
}
function clearWorkSpeech(){const scope=workNotice?.scope;workNotice=null;workSpeechView.reset();if(scope)stopPlayback(scope);}
function stopCapture(scope) {
  if (!scope || capturing && scopeEquals(capturing.scope, scope)) voicePhase = 'idle';
  if (!capturing || scope && !scopeEquals(capturing.scope, scope)) return;
  const active = capturing; capturing = null; captureFeedback.stop(active.feedbackToken);active.controller.abort(); active.session?.stop();
  report({ type: 'capture-stopped' });
}
function command(cmd,{wakeInput=false}={}) {
  const commandEnteredAt=performance.now();
  if (!connection.connected) return;
  if(!wakeInput&&['start_voice','click_invitation','submit_text','cancel'].includes(cmd.type)){wake.pause();wakeRequestId=null;}
  if(['start_voice','submit_text'].includes(cmd.type)){
    const {workBinding,workbenchBinding,...inputCommand}=cmd;cmd={...inputCommand,...(displayedInputBinding()??{})};
  }
  if(['start_voice','click_invitation'].includes(cmd.type))voiceRequestAt=inputEventTiming?.at??commandEnteredAt;

  if (cmd.type === 'finish_voice' && voicePhase !== 'recording') {
    command({ type: 'cancel' }); view.error = '录音尚未就绪，已取消；请等到提示正在听再结束。'; renderUI(); return;
  }
  if (cmd.type === 'click_invitation' && voicePhase !== 'idle') return;
  if(['start_voice','click_invitation'].includes(cmd.type))captureFeedbackToken=wakeInput?wakeFeedbackToken:captureFeedback.start();
  else if(['finish_voice','cancel','submit_text'].includes(cmd.type)&&!wakeInput)captureFeedback.stop();
  if(['cancel','start_voice','click_invitation'].includes(cmd.type))textRequestId=null;
  if(cmd.type==='submit_text'){textRequestId=crypto.randomUUID();cmd={...cmd,clientRequestId:textRequestId};}
  if (cmd.type === 'start_voice') { voiceRequestId = crypto.randomUUID();wakeRequestId=wakeInput?voiceRequestId:null; cmd = { ...cmd, clientRequestId: voiceRequestId }; invitationPending = false; }
  if (cmd.type === 'click_invitation') { voiceRequestId = null; invitationPending = true; }
  if (['cancel', 'submit_text'].includes(cmd.type)) { voiceRequestId = null; invitationPending = false; chat.cancelVoice(view.characterId); }
  if (['start_voice', 'click_invitation'].includes(cmd.type)) { chat.failPending(view.characterId); chat.beginVoice(view.characterId, true); }
  if (cmd.type === 'submit_text' && !chat.submit(view.characterId, cmd.text)) return;
  if (cmd.type === 'cancel') { work.forgetBinding();workbench.forgetBinding();chat.failPending(view.characterId); $('text').value = chat.draft(view.characterId); }
  if (['cancel','submit_text'].includes(cmd.type)) hold.clear();
  if (['cancel','submit_text','start_voice','click_invitation'].includes(cmd.type)) {
    clearWorkSpeech();workSpeechBlocked=false;inputFocusEpoch++;inputScope=null;awaitingTranscript=false;work.input(!!(cmd.workBinding||cmd.workbenchBinding)); routeFocusEpoch=++interactionFocusEpoch; companionRoute=null; void stopPlayback(); stopCapture(); renderer?.reset();
  }
  captureAllowed = cmd.type === 'start_voice' || cmd.type === 'click_invitation';
  if (captureAllowed) { voicePhase = 'preparing'; }
  if (cmd.type === 'finish_voice') { awaitingTranscript=true;voicePhase = 'finishing'; captureAllowed = false; if (capturing) capturing.inputEndedAt = new Date().toISOString(); }
  if (['cancel', 'submit_text', 'start_voice', 'click_invitation'].includes(cmd.type)) awaitingTextTurn = cmd.type === 'submit_text';
  view.command(cmd);
  if (cmd.type === 'start_voice') renderer?.beginAttention();
  // Dispatch explicit voice authorization before rebuilding the chat DOM.
  if (cmd.type === 'start_voice') { send({ channel: 'command', command: cmd }); report({type:'capture-command-timing',source:inputEventTiming?.source??'command',handlerToCommandMs:Math.max(0,commandEnteredAt-voiceRequestAt),handlerToSendMs:Math.max(0,performance.now()-voiceRequestAt)});renderUI(); }
  else { renderUI(); send({ channel: 'command', command: cmd }); }

}
const bytesFromBase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
function base64(bytes) { let text = ''; for (let at = 0; at < bytes.length; at += 32768) text += String.fromCharCode(...bytes.subarray(at, at + 32768)); return btoa(text); }
function connectionChanged(value) {
  if (!connection.update(value)) return;
  wake.disconnect();wakeRequestId=null;
  captureFeedback.stop();
  awaitingTextTurn = false;clearWorkSpeech();spokenNotices.clear();workSpeechBlocked=false;inputFocusEpoch=0;interactionFocusEpoch=0;routeFocusEpoch=0; inputScope=null;awaitingTranscript=false;work.reset(); companionRoute=null; textRequestId=null;
  workbench.disconnect();
  workInputSource='generic';
  presentationPolicy=null;applyPresentationPolicy();
  hold.clear(); voiceRequestId = null; invitationPending = false; chat.cancelVoice(view.characterId);
  introduction = null; introductionEpoch++; introductionFramePending = false; captureAllowed = false;
  chat.setDraft(view.characterId, $('text').value); chat.failPending(view.characterId); $('text').value = chat.draft(view.characterId);
  void stopPlayback(); stopCapture(); renderer?.reset(); view.reset(); view.reply = ''; view.invitation = null;
  renderUI();
  if (!connection.active) panel(true);
}
async function receive(message, generation) {
  if (!connection.current(generation)) return;
  if (message.channel === 'backend_ready') {
    if (message.bridgeVersion !== DESKTOP_BRIDGE_VERSION || !isProductCharacter(message.characterId) || typeof message.sessionId !== 'string' || !message.sessionId) {
      connectionChanged({ generation, state: 'failed', reason: 'version' });
      native('shell', { type: 'disconnect', generation }); return;
    }
    if (!connection.ready(generation)) return;
    wake.disconnect();wakeRequestId=null;
    captureFeedback.stop();
    awaitingTextTurn = false;clearWorkSpeech();spokenNotices.clear();workSpeechBlocked=false;inputFocusEpoch=0;interactionFocusEpoch=0;routeFocusEpoch=0; inputScope=null;awaitingTranscript=false;work.reset(); companionRoute=null; textRequestId=null;
    workbench.ready();
    workInputSource='generic';
    presentationPolicy=null;applyPresentationPolicy();
    introduction = null; introductionEpoch++; introductionFramePending = false; captureAllowed = false;
    void stopPlayback(); stopCapture(); renderer?.reset();
    backendSessionId=message.sessionId;view.setSession(message.characterId, message.sessionId);workSpeechView.setSession(message.characterId,message.sessionId);
    chat.restoreHistory(message.characterId, message.history);
    if (message.introduction && typeof message.introduction.id === 'string' && message.introduction.id && typeof message.introduction.text === 'string' && message.introduction.text.trim()) introduction = { ...message.introduction, generation, acknowledged: false };
    $('text').value = chat.draft(view.characterId); renderUI();
    report({ type: message.channel, characterId: message.characterId, bridgeVersion: DESKTOP_BRIDGE_VERSION }); return;
  }
  if(message.channel==='wake_control'){if(!connection.connected)return;wake.control(message);return;}
  if(message.channel==='wake_result'){if(!connection.connected)return;wake.result(message);return;}
  if(message.channel==='wake_error'){if(!connection.connected)return;wake.error(message);return;}
  if (message.channel === 'backend_closed') { connectionChanged({ generation, state: 'disconnected' }); return; }
  if (!connection.connected) return;
  if(message.channel==='work_state') { if(work.receive(message.state)){renderer?.workEvent?.('work',message.state);markVisibleWork();if(message.state.focus==='work')restoreSelectedSource();renderUI();} return; }
  if(message.channel==='workbench_state'){if(workbench.receive(message.state)){renderer?.workEvent?.('workbench',message.state);presentNativeWork();}return;}
  if(message.channel==='work_speech'){
    const e=message.event;
    if(!e||!e.scope||e.scope.sessionId!==backendSessionId||!isProductCharacter(e.scope.characterId)||!Number.isSafeInteger(e.inputEpoch)||e.inputEpoch!==inputFocusEpoch||typeof e.noticeId!=='string')return;
    if(e.state==='end'){if(workNotice?.noticeId===e.noticeId&&scopeEquals(workNotice.scope,e.scope)){if(playback.busy&&scopeEquals(playback.scope,e.scope))workNotice.ending=true;else clearWorkSpeech();}return;}
    if(e.state!=='start'||spokenNotices.has(e.noticeId)||workSpeechBlocked||voicePhase!=='idle'||capturing||awaitingTextTurn||['thinking','speaking','listening'].includes(view.state))return;
    clearWorkSpeech();spokenNotices.add(e.noticeId);workNotice={noticeId:e.noticeId,scope:e.scope,ending:false,workBinding:e.workBinding?structuredClone(e.workBinding):undefined};workSpeechView.scope=e.scope;renderUI();return;
  }
  if(message.channel==='input_route') {
    if(!view.accepts(message.scope)||!['companion','work'].includes(message.route))return;
    chat.route(message.scope,message.route);
    if(message.route==='work'){companionRoute=null;awaitingTextTurn=false;if(workInputSource==='generic'){if(routeFocusEpoch===interactionFocusEpoch)work.routedWork();markVisibleWork();restoreSelectedSource();}view.reset();renderer?.reset();}
    else {companionRoute=message.scope;work.input();}
    renderUI(); return;
  }
  if(message.channel==='presentation_policy'){
    const p=message.policy;
    if(!p||typeof p.modelId!=='string'||!Number.isSafeInteger(p.revision)||p.revision<0||!Array.isArray(p.enabledIds)||p.enabledIds.some(id=>typeof id!=='string'))return;
    if(presentationPolicy?.modelId===p.modelId&&p.revision<=presentationPolicy.revision)return;
    presentationPolicy=structuredClone(p);applyPresentationPolicy();return;
  }
  if (message.channel === 'event') {
    const e = message.event;
    if(e.type==='turn'&&e.input.kind==='text'&&(!textRequestId||e.input.clientRequestId!==textRequestId))return;
    if(e.type==='reply'&&!scopeEquals(companionRoute,e.reply.scope))return;
    if(e.type==='reply_progress'&&(!scopeEquals(companionRoute,e.scope)||typeof e.text!=='string'))return;
    if (e.type === 'turn' && e.input.kind === 'voice' && !(invitationPending && !e.input.clientRequestId) && (!voiceRequestId || e.input.clientRequestId !== voiceRequestId)) return;
    // Work presentation may reset before a late ASR event; input identity is independent.
    const accepted = e.type==='transcript' ? scopeEquals(inputScope,e.scope) : view.receive(e);
    if(accepted&&e.type==='turn'){inputScope=e.input.scope;speechProgress=null;}
    if(accepted&&e.type==='reply_progress'){
      speechProgress={scope:e.scope,text:e.text};
      // Streaming changes only the HUD. Preserve reading selection/focus in the main log.
      renderSpeechBubble();return;
    }
    if(accepted&&e.type==='transcript')awaitingTranscript=false;
    if(accepted&&e.type==='error'){speechProgress=null;captureFeedback.stop();inputScope=null;awaitingTranscript=false;}
    if (accepted && ['turn', 'error'].includes(e.type)) awaitingTextTurn = false;
    if (accepted && e.type === 'turn') { if (e.input.kind === 'text') chat.acknowledge(e.input.scope, true); else chat.bindVoice(e.input.scope); }
    if (accepted && e.type === 'transcript') chat.transcript(e.scope, e.text);
    if (accepted && e.type === 'reply' && scopeEquals(companionRoute,e.reply.scope)) { chat.reply(e.reply.scope, e.reply.text); speechProgress = null; renderer?.presentReply?.(e.reply); renderUI(); }
    if (accepted && e.type === 'error') { hold.clear(); voiceRequestId = null; invitationPending = false; chat.cancelVoice(view.characterId); chat.failPending(view.characterId); $('text').value = chat.draft(view.characterId); }
    if (accepted && (e.type === 'error' || e.type === 'presentation' && e.presentation.state === 'error')) { captureFeedback.stop();void stopPlayback(); stopCapture(); renderer?.reset(); }
    if (accepted && e.type === 'turn') { if (playback.scope && !scopeEquals(playback.scope, e.input.scope)) void stopPlayback(); if (capturing && !scopeEquals(capturing.scope, e.input.scope)) stopCapture(); renderer?.reset({ preserveAttention: e.input.kind === 'voice' }); }
    if (accepted) renderUI(); return;
  }
  try {
    if (message.channel === 'stop' || message.channel === 'capture_stop') {
      if (message.channel === 'stop') await stopPlayback(message.scope); else stopCapture(message.scope);
      send({ channel: 'ack', requestId: message.requestId }, generation); return;
    }
    if (message.channel === 'play') {
      const isWorkSpeech=workNotice&&!workNotice.ending&&scopeEquals(workNotice.scope,message.tts.scope);
      if(!scopeEquals(companionRoute,message.tts.scope)&&!isWorkSpeech||isWorkSpeech&&workNotice.playRequestId&&workNotice.playRequestId!==message.requestId){message.audioBase64='';send({channel:'playback',requestId:message.requestId,event:{type:'stopped',scope:message.tts.scope,at:new Date().toISOString()}});return;}
      if(isWorkSpeech)workNotice.playRequestId=message.requestId;
      if(isWorkSpeech)workSpeechView.expression=message.tts.expression??workSpeechView.expression;
      const bytes = bytesFromBase64(message.audioBase64); message.audioBase64 = '';
      // A dynamic reply always wins the output; an action line never talks over it.
      voiceLines.stop();
      await playback.play(message.requestId, message.tts, bytes);
      return;
    }
    if (message.channel === 'capture_start') {
      if (!captureAllowed || !view.accepts(message.scope)) throw new Error('录音仅能由当前主动语音轮次打开');
      const fromWake=wakeRequestId!==null&&wakeRequestId===voiceRequestId;
      if(fromWake&&!wake.pendingCapture){if(capturing?.wake&&capturing.session&&scopeEquals(capturing.scope,message.scope)){send({channel:'ack',requestId:message.requestId},generation);return;}throw new Error('唤醒录音已取消');}
      stopCapture(); voicePhase = 'preparing';
      const active = { scope: message.scope, controller: new AbortController(),feedbackToken:captureFeedbackToken,wake:fromWake }; capturing = active;
      const driver = new BrowserCaptureDriver({ workletModuleUrl: new URL('./recorder-worklet.js', import.meta.url), cameraWidth: 640, jpegQuality: .8, maxBufferedSamples: 12000000,onLevel:level=>{if(capturing===active&&!active.controller.signal.aborted)captureFeedback.level(active.feedbackToken,level);}, onDiagnostic: event => {
        if(capturing===active){if(event.phase==='stopped')captureFeedback.stop(active.feedbackToken);report({type:'capture-timing',...event,requestElapsedMs:Math.max(0,performance.now()-voiceRequestAt)});}
      } });
      const opening=active.wake?Promise.resolve(wake.takeCapture()):driver.open(active.controller.signal);renderUI();
      active.session = await opening;
      if (capturing !== active) { active.session.stop(); throw new Error('录音轮次已取消'); }
      voicePhase = 'recording'; hold.ready(); renderUI();
      send({ channel: 'ack', requestId: message.requestId }, generation);if(active.wake)wake.captureReady(); report({ type: 'capture-ready' }); return;
    }
    if (message.channel === 'capture_finish') {
      const active = capturing;
      if (!active?.session || !scopeEquals(active.scope, message.scope)) throw new Error('没有本轮已就绪的录音');
      if(!active.wake)captureFeedback.stop(active.feedbackToken);
      const inputEndedAt = active.inputEndedAt ?? new Date().toISOString();
      const value = await active.session.finish();
      try {
        if (capturing !== active) throw new Error('采集结果已失效');
        send({ channel: 'capture', requestId: message.requestId, result: { scope: active.scope, audio: { id: crypto.randomUUID(), mimeType: 'audio/wav', base64: base64(value.audio) }, images: value.images.map(i => ({ id: crypto.randomUUID(), mimeType: i.mimeType, base64: base64(i.bytes) })), inputEndedAt, captureStoppedAt: value.captureStoppedAt } }, generation);
        capturing = null; voicePhase = 'idle'; renderUI(); report({ type: 'capture-finished', inputEndedAt, captureStoppedAt: value.captureStoppedAt });
      } finally { value.audio.fill(0); value.images.forEach(i => i.bytes.fill(0)); }
    }
  } catch (error) {
    const failure = toDeviceFailure(error), text = deviceFailureMessage(failure), scope = message.scope ?? message.tts?.scope;
    if (connection.current(generation) && message.channel.startsWith('capture') && scope && view.accepts(scope)) {
      stopCapture(scope); captureAllowed = false; hold.clear(); voiceRequestId = null; invitationPending = false;
      inputScope=null;awaitingTranscript=false;chat.cancelVoice(view.characterId); view.receive({ type: 'error', scope, message: text }); renderUI();
    }
    send({ channel: 'rpc_error', requestId: message.requestId, ...(scope ? { scope } : {}), error: failure, message: text }, generation);
  }
}
window.petBridge = { receive, connectionChanged, hotkeyConfig, hotkeyEvent, audioConfig: config => { audio.receive(config); },
 // Settings pushed by the native host after load or after any set_motion round-trip.
 motionConfig: applyHostMotionConfig,
 voiceLinesState: async () => ({ enabled: voiceLines.enabled, ...voiceLines.stats, playing: voiceLines.playing }), displayConfig: config => {
 display.receive(config); petWindow.receive(config);
 if (['video','live2d'].includes(config.rendererKind) && config.rendererKind !== rendererKind) { rendererKind = config.rendererKind; if(rendererBooted) void selectRenderer(rendererKind); }
 initialDisplayResolve?.(); initialDisplayResolve=undefined;
 renderer?.setSuspended?.(petWindow.collapsed || document.hidden);
 if (workbench.isOpen) workbench.position(); if (records.isOpen) records.position();
},
 managementResult,workbenchOpenResult:result=>workbench.nativeOpenResult(result) };
window.WhaleDesktop = { express: async payload => {
  if (renderer?.kind !== 'video' || !renderer.ready) throw Error('请先选择视频鲸鱼');
  return renderer.invoke(payload);
}, snapshot: () => renderer ? {kind:renderer.kind,ready:renderer.ready,...(renderer.ready ? renderer.snapshot() : {})} : null };
$('model-kind').onchange = () => { const kind = $('model-kind').value; if(hosted) native('shell',{type:'set_renderer',rendererKind:kind}); else void selectRenderer(kind); };
$('video-play').onclick = () => renderer?.request?.($('video-action').value);
$('video-reassure').onclick = () => renderer?.reassure?.();
$('open').onclick = () => panel(true); $('close').onclick = () => panel(false); $('quit').onclick = () => { wake.disconnect();captureFeedback.stop();void stopPlayback(); stopCapture(); native('shell', { type: 'quit' }); };
$('text').oninput = () => { clearWorkSpeech();workSpeechBlocked=true;interactionFocusEpoch++; work.input(!!displayedInputBinding()); chat.setDraft(view.characterId, $('text').value); fitComposer(); };
$('text').oncompositionstart = () => { composing = true; };
$('text').oncompositionend = () => { composing = false; };
$('text').onkeydown = event => {
  if (event.key !== 'Enter') return;
  if (composing || event.isComposing || event.keyCode === 229) { event.preventDefault(); return; }
  if (!event.shiftKey) { event.preventDefault(); $('form').requestSubmit(); }
};
$('form').onsubmit = event => {
  event.preventDefault(); const text = $('text').value.trim();
  if (composing || event.isComposing || !text || !connection.connected || chat.pending(view.characterId)) return;
  $('text').value = ''; command({ type: 'submit_text', text });
};
$('text').onfocus = () => report({ type: 'input-focus', active: document.activeElement === $('text') });
$('voice').onclick = () => timedVoiceInput(performance.now(),'voice-button',()=>command({ type: voicePhase !== 'idle' ? 'finish_voice' : 'start_voice' }));
$('stop').onclick = () => command({ type: 'cancel' });
$('invitation').onclick = () => { if (view.invitation) { const id = view.invitation.id; view.invitation = null; panel(true); command({ type: 'click_invitation', invitationId: id }); } };
const petWindowControl = target => ['pet-collapse', 'pet-ball', 'workbench-collapse', 'work-records-collapse'].includes(target?.id);
const editing = target => ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable || ['view-full', 'view-half', 'model-resize', 'management', 'workbench-open'].includes(target?.id) || petWindowControl(target);
document.addEventListener('keydown', e => {
  const receivedAt=performance.now();
  if(petWindow.collapsed)return;
  if(workbench.isOpen){if(e.key==='Tab'){workbench.tab(e);return;}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();workbench.close();return;}}
  if(e.key==='Tab'&&records.isOpen){records.tab(e);return;}
  if(e.key==='Escape'&&records.isOpen){e.preventDefault();e.stopPropagation();records.close();return;}
  if (e.key === 'Escape' && display.cancel(e)) return;
  if (bindingKey || composing || e.isComposing || e.keyCode === 229) return;
  if (!editing(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey && timedVoiceInput(receivedAt,'keyboard',()=>hold.down(e.code,e.repeat))) { e.preventDefault(); e.stopPropagation(); return; }
  if (e.key === 'Escape') { if (playback.busy || capturing || voicePhase !== 'idle' || view.scope) command({ type: 'cancel' }); else panel(false); }
}, true);
document.addEventListener('keyup', e => { if (hold.up(e.code)) { e.preventDefault(); e.stopPropagation(); } }, true);
document.addEventListener('focusin', e => { if (editing(e.target) && !petWindowControl(e.target)) hold.cancel(); });
window.addEventListener('blur', () => { hold.cancel(); display.cancel(); petWindow.cancel(); });
document.addEventListener('visibilitychange', () => { renderer?.setSuspended?.(document.hidden || petWindow.collapsed); introductionEpoch++; introductionFramePending = false; if (document.hidden) { hold.cancel(); display.cancel(); petWindow.cancel(); } else {presentNativeWork();workbench.schedulePresentation();scheduleIntroductionAck();} });
window.addEventListener('pagehide', () => { display.cancel(); connectionChanged({ generation: connection.generation, state: 'disconnected' }); void stopPlayback(); stopCapture(); renderer?.dispose(); });
window.addEventListener('error', e => report({ type: 'script-error', message: e.message }));
window.addEventListener('unhandledrejection', e => report({ type: 'promise-error', message: String(e.reason) }));
renderUI(); native('shell', { type: 'ready' });

// ---- frame cadence and motion settings (module scope: the host callback must reach these) ----
// The display drives cadence; the user's budget decides how often we draw.
const frameScheduler = new FrameScheduler({ rate: motionConfig.rate });

// Codex owns the renderer module. A capability is called only when it really exists, and a missing
// one is reported once instead of being replaced with a local guess that would quietly diverge.
const missingRendererCapabilities = new Set();
function rendererCapability(name, ...args) {
  const fn = renderer?.[name];
  if (typeof fn !== 'function') {
    if (renderer && !missingRendererCapabilities.has(name)) { missingRendererCapabilities.add(name); report({ type: 'renderer-capability-missing', name }); }
    return undefined;
  }
  try { return fn.apply(renderer, args); }
  catch (error) { report({ type: 'renderer-capability-failed', name, message: String(error?.message ?? error) }); return undefined; }
}

// The renderer that last received an action request. A settings change must not restart a transient
// action or re-enter Sleep, so a request is repeated only for a brand-new renderer or an explicit
// choice.
let animationOwner = null;
// The drag pose is interaction state, not a user selection; random actions must stand aside for it.
let dragActive = false;

// ---- random idle actions -----------------------------------------------------------------------
// Only transient behaviours take part. Talking is deliberately absent (a silent request would fight
// the rule that the mouth moves only for real audio), and Sleep/Drag are intent states
// that belong to the user or to an interaction, never to a dice roll.
const RANDOM_ACTIONS = Object.freeze(['Blink', 'LookAt', 'Breathing', 'Happy', 'Surprised', 'Shy', 'Interact']);
const RANDOM_INTERVALS = Object.freeze({short: 8_000, medium: 18_000, long: 40_000});
const RANDOM_INTERVAL_LABELS = Object.freeze({short: '频繁', medium: '适中', long: '偶尔'});
let randomActionConfig = { enabled: true, interval: 'medium' };

const readStoredRandom = () => { try { return JSON.parse(localStorage.getItem('petRandomActions') ?? 'null'); } catch { return null; } };
const writeStoredRandom = value => { try { localStorage.setItem('petRandomActions', JSON.stringify(value)); } catch {} };

/** The action a dice roll lands on, or null when it must not play at all. Pure and testable. */
function chooseRandomAction({enabled, actions, random = Math.random}) {
  if (!enabled || !actions?.length) return null;
  const roll = Number(random());
  if (!Number.isFinite(roll)) return null;
  const index = Math.min(actions.length - 1, Math.max(0, Math.floor(roll * actions.length)));
  return actions[index] ?? null;
}

/** Whether an idle random action may play right now. Pure: the caller supplies every fact. */
function randomActionAllowed({enabled, collapsed, hidden, busy, speaking, dragging, currentState}) {
  if (!enabled || collapsed || hidden) return false;
  if (busy || speaking || dragging) return false;
  // Only from a settled idle pose, so the user's Sleep, a playing clip or an interaction is never cut.
  return currentState === 'Idle';
}

/** Next delay for the chosen cadence, jittered so the pet never feels metronomic. */
function nextRandomDelay(interval, random = Math.random) {
  const base = RANDOM_INTERVALS[interval] ?? RANDOM_INTERVALS.medium;
  const roll = Number(random());
  const factor = Number.isFinite(roll) ? 0.6 + Math.min(1, Math.max(0, roll)) * 0.8 : 1;
  return Math.round(base * factor);
}
function requestAnimation({ force = false } = {}) {
  if (!renderer) return undefined;
  if (!force && animationOwner === renderer) return undefined;
  animationOwner = renderer;
  const accepted = rendererCapability('setAnimationState', selectedAnimation);
  if (accepted === false) report({ type: 'animation-state-rejected', state: selectedAnimation });
  return accepted;
}
/** An explicit choice from the user. It always reaches the renderer, so re-picking the same
 * transient action replays it instead of being swallowed by a de-duplication guard. */
function selectAnimation(name) {
  selectedAnimation = typeof name === 'string' && name ? name : 'Idle';
  return requestAnimation({ force: true });
}

/**
 * The drag pose is temporary and is applied straight to the renderer, so it never becomes the
 * user's selection: releasing hands control back to what the user actually picked rather than
 * requesting Drag a second time.
 */
function applyDragState(dragging) {
  dragActive = Boolean(dragging);
  if (dragging) { rendererCapability('setAnimationState', 'Drag'); return undefined; }
  return requestAnimation({ force: true });
}
function applyMotionConfig({ persist = false, requestCurrentAnimation = false } = {}) {
  frameScheduler.configure({ rate: motionConfig.rate });
  rendererCapability('configureMotion', motionConfig);
  // Only a new renderer asks for the current action; a knob change or a host round-trip must not
  // restart the animation that is already playing.
  if (requestCurrentAnimation) requestAnimation({ force: true });
  if (persist) {
    if (hosted) native('shell', { type: 'set_motion', settings: motionConfig, animation: selectedAnimation });
    else writeStoredMotion({ settings: motionConfig, animation: selectedAnimation });
  }
}

/**
 * The core's gaze convention: x and y run -1..1 with the origin at the centre of the character and
 * y pointing up. Feeding it 0..1 coordinates would park the gaze right of centre and invert the
 * vertical axis, so the conversion lives here and nowhere else.
 */
function toLookAtPoint(clientX, clientY, box) {
  if (!box || !Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) return null;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  return {
    x: Math.max(-1, Math.min(1, ((clientX - box.left) / box.width) * 2 - 1)),
    y: Math.max(-1, Math.min(1, 1 - ((clientY - box.top) / box.height) * 2)),
  };
}

/**
 * Coarse screen partition, not an ArtMesh hit test: the character box is split at 38% of its height
 * so a click on the upper part is treated as the head and the rest as the body. Deliberately
 * approximate and never to be described as precise model hit testing.
 */
function regionForClick(event) {
  const box = document.getElementById('character')?.getBoundingClientRect?.();
  if (!box || !box.height || !Number.isFinite(event?.clientY)) return 'body';
  return (event.clientY - box.top) / box.height < 0.38 ? 'head' : 'body';
}

// Fires at most once per interval; every gate is re-checked here because the pose can change at any
// time (a clip starts, the window collapses, the user drags).
let nextRandomAt = 0;
function maybePlayRandomAction(at) {
  if (!randomActionConfig.enabled) return;
  const state = renderer?.ready ? renderer.snapshot?.()?.animation?.state : undefined;
  if (!randomActionAllowed({
    enabled: randomActionConfig.enabled,
    collapsed: Boolean(petWindow.collapsed),
    hidden: Boolean(document.hidden),
    busy: Boolean(playback.busy),
    speaking: workSpeechView.state === 'speaking',
    dragging: dragActive,
    currentState: state,
  })) return;
  if (at < nextRandomAt) return;
  nextRandomAt = at + nextRandomDelay(randomActionConfig.interval);
  const action = chooseRandomAction({ enabled: true, actions: RANDOM_ACTIONS });
  if (!action) return;
  // Sent straight to the renderer, so the random action never becomes the user's own selection.
  rendererCapability('setAnimationState', action);
  report({ type: 'random-action', state: action });
}

let lastStatsPaint = 0;
function updateMotionStats() {
  const node = document.getElementById('motion-stats');
  if (!node) return;
  const now = performance.now();
  if (now - lastStatsPaint < 250) return;
  lastStatsPaint = now;
  const s = frameScheduler.stats();
  // Every number is a measured sample; nothing here is extrapolated or fixed.
  node.textContent = `帧率 ${s.fps.toFixed(1)} · 渲染耗时 p95 ${s.p95RenderMs.toFixed(1)}ms · 均值 ${s.meanRenderMs.toFixed(1)}ms · 采样 ${s.samples} · 预算 ${s.rate === 'high' ? '跟随刷新率' : s.rate === 'eco' ? '30Hz' : '60Hz'}`;
}

/**
 * Settings pushed by the native host after load or after any set_motion round-trip. The shared
 * normaliser is authoritative for the five fields; the page does not re-clamp them itself. Named
 * and module-scoped so it can be executed directly by the tests.
 */
function applyHostMotionConfig(config) {
  if (!config || typeof config !== 'object') return undefined;
  const changedAnimation = typeof config.animation === 'string' && config.animation && config.animation !== selectedAnimation;
  motionConfig = normalizeMotionSettings(config, motionConfig);
  if (typeof config.animation === 'string' && config.animation) selectedAnimation = config.animation;
  bindMotionUi();
  // A round-trip echoes the same action back; only a real change may request one.
  return applyMotionConfig({ requestCurrentAnimation: changedAnimation });
}

function bindMotionUi() {
  const animation = document.getElementById('motion-animation');
  const amount = document.getElementById('motion-amount');
  const speed = document.getElementById('motion-speed');
  const frequency = document.getElementById('motion-frequency');
  const tracking = document.getElementById('motion-tracking');
  const rate = document.getElementById('motion-rate');
  if (animation) { animation.value = selectedAnimation; animation.onchange = () => { selectAnimation(animation.value); applyMotionConfig({ persist: true }); }; }
  const bindRange = (node, key) => {
    if (!node) return;
    node.value = String(motionConfig[key]);
    node.oninput = () => { motionConfig = normalizeMotionSettings({ [key]: Number(node.value) }, motionConfig); applyMotionConfig({ persist: false }); };
    node.onchange = () => applyMotionConfig({ persist: true });
  };
  bindRange(amount, 'amount'); bindRange(speed, 'speed'); bindRange(frequency, 'frequency');
  if (tracking) {
    tracking.checked = motionConfig.tracking;
    tracking.onchange = () => {
      motionConfig = normalizeMotionSettings({ tracking: tracking.checked }, motionConfig);
      applyMotionConfig({ persist: true });
      // Turning tracking off must release the gaze instead of leaving it frozen where it was.
      if (!motionConfig.tracking) rendererCapability('setLookAt', null);
    };
  }
  if (rate) { rate.value = motionConfig.rate; rate.onchange = () => { motionConfig = normalizeMotionSettings({ rate: rate.value }, motionConfig); applyMotionConfig({ persist: true }); }; }
  const fit = document.getElementById('motion-fit-drawer');
  if (fit) fit.onclick = () => fitModelToDrawer();
  const random = document.getElementById('motion-random');
  const randomInterval = document.getElementById('motion-random-interval');
  if (randomInterval) {
    randomInterval.replaceChildren(...Object.entries(RANDOM_INTERVAL_LABELS).map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value; option.textContent = label;
      return option;
    }));
    randomInterval.value = randomActionConfig.interval;
    randomInterval.onchange = () => {
      randomActionConfig = { ...randomActionConfig, interval: RANDOM_INTERVALS[randomInterval.value] ? randomInterval.value : 'medium' };
      writeStoredRandom(randomActionConfig);
      // A cadence change takes effect from now, not after the old, longer wait.
      nextRandomAt = 0;
    };
  }
  if (random) {
    random.checked = randomActionConfig.enabled;
    random.onchange = () => {
      randomActionConfig = { ...randomActionConfig, enabled: random.checked };
      writeStoredRandom(randomActionConfig);
      nextRandomAt = 0;
      report({ type: 'random-actions', enabled: randomActionConfig.enabled });
    };
  }
}

let frame = 0, lastRender = 0;
// Last local-voice waveform sample, refreshed once per drawn frame.
let localVoice = { playing: false, mouth: 0 };
// Tracks the local clip's playing -> ended edge so it is reported exactly once.
let localVoicePlaying = false;
{
  // Loaded before the first action so the greeting line is available immediately.
  await voiceLines.load(); report({ type: 'voice-lines', enabled: voiceLines.enabled, files: voiceLines.stats.files });
  await initialDisplay; rendererBooted = true; await selectRenderer(rendererKind);
  // A brand-new renderer starts on its own defaults, so it is the one case that asks for the
  // current action; later settings changes must not restart what is already playing.
  applyMotionConfig({ requestCurrentAnimation: true });
  document.getElementById('character')?.addEventListener('pointermove', event => {
    if (!motionConfig.tracking) return;
    const box = event.currentTarget.getBoundingClientRect?.();
    rendererCapability('setLookAt', toLookAtPoint(event.clientX, event.clientY, box));
  });
  // Leaving the character must release the gaze instead of freezing it.
  document.getElementById('character')?.addEventListener('pointerleave', () => rendererCapability('setLookAt', null));
  const stored = readStoredRandom();
  if (stored && typeof stored === 'object') randomActionConfig = {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : randomActionConfig.enabled,
    interval: RANDOM_INTERVALS[stored.interval] ? stored.interval : randomActionConfig.interval,
  };
  bindMotionUi(); applyMotionConfig(); bindQuickChat(); bindChatVisibility();

  function animate(at) {
    requestAnimationFrame(animate);
    // A hidden window or the collapsed ball tells the scheduler to resync rather than bank time,
    // so restoring cannot replay the gap as a burst of frames.
    if (!frameScheduler.tick(at, { visible: !petWindow.collapsed && !document.hidden })) return;
    if (view.expireInvitation(Date.now())) renderUI();
    const shown = workSpeechView.state === 'speaking' ? workSpeechView : view;
    // Exactly one sample per drawn frame. The value is cached so the sparse telemetry below never
    // advances the smoothing a second time.
    localVoice = voiceLines.sample();
    // Dynamic TTS and workbench speech keep their existing path; only when neither of them owns the
    // output does a local line speak. `playback.busy` is part of the test, not just the view state,
    // so a TTS reply that is still loading cannot be raced by a local clip.
    maybePlayRandomAction(at);
    const voiceOwnsOutput = shown.state === 'speaking' || playback.busy;
    // Handed over as a shallow copy: the backend view and its scope are never modified, and the copy
    // carries the state the state machine expects for speech.
    const viewForRenderer = localVoice.playing && !voiceOwnsOutput
      ? { ...shown, state: 'speaking', mouth: localVoice.mouth }
      : shown;
    const started = performance.now();
    renderer?.updateView(viewForRenderer, voicePhase === 'preparing' ? 'listening' : viewForRenderer.state, (work.focused || workInputSource === 'native') && shown === view);
    // Reported once per playing -> ended transition, deliberately after updateView so the value is
    // the renderer's own mouth rather than the waveform's last sample.
    if (localVoice.playing) localVoicePlaying = true;
    else if (localVoicePlaying) {
      localVoicePlaying = false;
      report({ type: 'local-voice-ended', source: 'local-voice', mouth: renderer?.ready ? renderer.snapshot().mouth : null });
    }
    // Only a real measurement is recorded; the statistics shown are these samples.
    frameScheduler.record(performance.now() - started);
    lastRender = at; frame += 1;
    updateMotionStats();
  }
  requestAnimationFrame(animate);
  // Bounded telemetry of model parameters only, never transcript/audio/frame contents.
  let lastTrace = 0, lastLocalTrace = 0;
  setInterval(() => { if (playback.busy && renderer?.ready && performance.now() - lastTrace > 700) { lastTrace = performance.now(); report({ type: 'speaking-parameters', ...renderer.snapshot() }); } }, 500);
  // Sparse telemetry for the local clips, so the native side can verify a real wav opens and closes
  // the mouth. Parameters only: no audio, no transcript, no keys. Rate-limited to one per 700 ms.
  setInterval(() => {
    if (!localVoice.playing || !renderer?.ready) return;
    if (performance.now() - lastLocalTrace <= 700) return;
    lastLocalTrace = performance.now();
    report({ type: 'speaking-parameters', source: 'local-voice', mouth: localVoice.mouth, ...renderer.snapshot() });
  }, 500);
}
