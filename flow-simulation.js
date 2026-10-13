import { FlowEngine } from './flow-engine.js';
import { FLOW_ROUTES, buildEngineRoutes, buildObstacles } from './flow-world.js';

// Route geometry lives in flow-world.js; re-exported here for the app and QA.
export { FLOW_ROUTES };

const SPEEDS = [0.5, 1, 2];
const MIN_VISITORS = 1;
const MAX_VISITORS = 5;
// The scene opens mid-flow rather than empty; see FlowEngine.reset().
const WARM_SECONDS = 20;
const CAPTION = 'Illustrative circulation study';
const HINT = { perspective: 'Drag to orbit · Scroll to zoom', plan: 'Drag to pan · Scroll to zoom', canvas2d: 'Plan view' };

const icon = path => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">${path}</svg>`;
const ICONS = {
  play: icon('<path d="M4.2 2.6v10.8L13 8z" fill="currentColor"/>'),
  pause: icon('<path d="M4 2.8h2.9v10.4H4zM9.1 2.8H12v10.4H9.1z" fill="currentColor"/>'),
  restart: icon('<path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5M3 2.4v2.9h2.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  follow: icon('<circle cx="8" cy="8" r="2.1" fill="currentColor"/><circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.4"/>'),
};

function template() {
  const pills = FLOW_ROUTES.map(route =>
    `<button type="button" class="flow-pill" data-sim-route="${route.id}" aria-pressed="false" title="${route.subtitle}" style="--route:${route.color}"><i></i>${route.title}${route.itineraries?.length > 1 ? '<span class="flow-optional">+ optional S4</span>' : ''}</button>`
  ).join('');
  const dots = FLOW_ROUTES.map(route => `<i style="background:${route.color}"></i>`).join('');
  const speeds = SPEEDS.map(value => `<button type="button" data-sim-speed="${value}" aria-pressed="${value === 1}">${value}×</button>`).join('');
  return `
<div class="flow-viewport"></div>
<div class="flow-labels" aria-hidden="true"></div>
<div class="flow-top">
  <div class="flow-routes" role="group" aria-label="Visitor journeys">
    <button type="button" class="flow-pill flow-pill-all" data-sim-route="all" aria-pressed="true"><span class="flow-dots">${dots}</span>All</button>${pills}
  </div>
  <div class="flow-views">
    <div class="flow-segment" role="group" aria-label="View">
      <button type="button" data-sim-view="perspective" aria-pressed="true">Perspective</button>
      <button type="button" data-sim-view="plan" aria-pressed="false">Plan</button>
    </div>
    <button type="button" class="flow-chip" data-sim-action="source" aria-pressed="false" title="Show the original section plan under the study">Source plan</button>
  </div>
</div>
<div class="flow-dock" role="toolbar" aria-label="Playback">
  <button type="button" id="sim-play" class="flow-play" data-sim-action="play"></button>
  <button type="button" id="sim-restart" class="flow-icon" data-sim-action="restart" aria-label="Restart" title="Restart">${ICONS.restart}</button>
  <div class="flow-segment flow-speed" role="group" aria-label="Playback speed">${speeds}</div>
  <div class="flow-stepper" role="group" aria-label="Visitors per journey" title="Visitors per journey">
    <button type="button" data-sim-action="fewer" aria-label="Fewer visitors">−</button>
    <output id="sim-count" aria-live="polite">3</output>
    <button type="button" data-sim-action="more" aria-label="More visitors">+</button>
  </div>
  <button type="button" class="flow-chip flow-follow" data-sim-action="follow" aria-pressed="false" title="Follow one visitor">${ICONS.follow}<span>Follow</span></button>
  <div class="flow-counts" aria-label="Activity">
    <span><b data-sim-count="walking">0</b> walking</span>
    <span><b data-sim-count="stopped">0</b> at stops</span>
    <span><b data-sim-count="journeys">0</b> journeys</span>
  </div>
</div>`;
}

export class FlowSimulation {
  constructor({ stage, story, controls, toolbar, caption, hint, renderer } = {}) {
    if (!stage) throw new TypeError('FlowSimulation needs a stage element.');
    this.stage = stage;
    this.story = story;
    this.controls = controls;
    this.toolbar = toolbar;
    this.caption = caption;
    this.hint = hint;
    this.selected = 'all';
    this.view = 'perspective';
    this.renderer = 'pending';
    this.sourcePlan = false;
    this.following = false;
    this.followId = null;
    this.followRoute = null;
    this.destroyed = false;
    this.scene = null;
    this.raf = 0;
    this.last = null;
    this.clock = 0;
    this.stale = true;
    this.sized = false;
    this.countText = '';
    this.reducedMotion = Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

    this.engine = new FlowEngine({ routes: buildEngineRoutes(), obstacles: buildObstacles(), perRoute: 3, seed: 27, warm: WARM_SECONDS });
    this.engine.setPlaying(!this.reducedMotion);

    // The parent's story, controls and toolbar hosts stay empty: every control lives in the stage.
    for (const host of [story, controls, toolbar]) host?.replaceChildren();
    this.root = document.createElement('div');
    this.root.className = 'flow-root';
    this.root.innerHTML = template();
    this.viewport = this.root.querySelector('.flow-viewport');
    this.labels = this.root.querySelector('.flow-labels');
    this.stageWasStatic = getComputedStyle(stage).position === 'static';
    stage.classList.add('flow-stage', 'simulation-stage');
    stage.classList.toggle('flow-stage-static', this.stageWasStatic);
    stage.replaceChildren(this.root);
    if (caption) caption.textContent = CAPTION;
    else this.root.append(Object.assign(document.createElement('p'), { className: 'flow-caption', textContent: CAPTION }));
    if (hint) hint.textContent = '';

    this.onClick = event => this.#handleClick(event);
    this.onPointerDown = event => { this.press = { x: event.clientX, y: event.clientY, time: event.timeStamp }; };
    this.onPointerUp = event => this.#handlePick(event);
    this.onVisibility = () => { this.last = null; if (document.hidden) this.#cancelFrame(); else this.#schedule(); };
    this.onKey = event => {
      if (event.code !== 'Space' || event.target !== document.body || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) this.togglePlay();
    };
    this.root.addEventListener('click', this.onClick);
    this.viewport.addEventListener('pointerdown', this.onPointerDown);
    this.viewport.addEventListener('pointerup', this.onPointerUp);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('keydown', this.onKey, true);
    this.resizeObserver = new ResizeObserver(() => this.#resize());
    this.resizeObserver.observe(this.root);

    this.frame = this.frame.bind(this);
    this.#syncControls();
    this.#renderCounts(this.engine.snapshot());
    this.ready = this.#loadRenderer(renderer);
  }

  async #loadRenderer(forced) {
    if (forced !== '2d') {
      try {
        const { FlowScene } = await import('./flow-scene.js');
        if (this.destroyed) return 'destroyed';
        this.#attach(new FlowScene({ ...this.#sceneOptions(), onContextLost: () => { this.#useFallback(); } }));
        return this.renderer;
      } catch (error) {
        console.warn('Flow simulation: 3D view unavailable; showing the 2D plan instead.', error);
        this.viewport.replaceChildren();
        this.labels.replaceChildren();
      }
    }
    return this.#useFallback();
  }

  async #useFallback() {
    try {
      const { FlowFallback } = await import('./flow-fallback.js');
      if (this.destroyed) return 'destroyed';
      this.scene?.dispose();
      this.scene = null;
      this.#attach(new FlowFallback(this.#sceneOptions()));
    } catch (error) {
      console.error('Flow simulation could not start.', error);
      this.renderer = this.root.dataset.renderer = 'none';
      this.viewport.innerHTML = '<a class="flow-unavailable" href="assets/plan.png" target="_blank" rel="noopener"><img src="assets/plan.png" alt="Source section plan"><span>The animated study could not start. Open the source plan ↗</span></a>';
    }
    return this.renderer;
  }

  #sceneOptions() {
    return { host: this.viewport, labels: this.labels, routes: FLOW_ROUTES, reducedMotion: this.reducedMotion };
  }

  #attach(scene) {
    this.scene = scene;
    this.renderer = this.root.dataset.renderer = scene.kind;
    scene.setActiveRoutes(this.engine.activeRouteIds);
    if (this.sourcePlan) scene.setSourcePlan(true, () => this.#sourceFailed());
    this.sized = false;
    this.#resize();
    scene.setView(this.view, { immediate: true });
    if (this.following) scene.setFollow(this.followId);
    this.#refresh();
  }

  #resize() {
    const width = this.root.clientWidth, height = this.root.clientHeight;
    this.sized = width > 0 && height > 0;
    if (!this.sized || !this.scene) return;
    const top = this.root.querySelector('.flow-top'), dock = this.root.querySelector('.flow-dock');
    this.scene.setSize(width, height, {
      top: top.offsetTop + top.offsetHeight + 12,
      bottom: height - dock.offsetTop + 12,
      side: Math.min(64, width * 0.07),
    });
    this.stale = true;
    this.#schedule();
  }

  #schedule() {
    if (!this.destroyed && !this.raf && !document.hidden) this.raf = requestAnimationFrame(this.frame);
  }

  #cancelFrame() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  frame(now) {
    this.raf = 0;
    if (this.destroyed) return;
    const dt = this.last === null ? 0 : Math.min(0.25, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (this.scene && this.sized) {
      let snapshot = null;
      // All motion, including route dashes and idle sway, runs on this clock, so pausing freezes it.
      if (this.engine.playing) { snapshot = this.engine.tick(dt); this.clock += dt * this.engine.speed; }
      if (snapshot || this.stale) {
        snapshot ??= this.engine.snapshot();
        this.#trackFollow(snapshot);
        this.scene.update(snapshot, this.clock);
        this.#renderCounts(snapshot);
        this.stale = false;
      }
      if (this.scene.step(dt)) this.scene.render();
    }
    this.#schedule();
  }

  #handleClick(event) {
    const button = event.target.closest('button');
    if (!button || !this.root.contains(button)) return;
    const { simRoute, simSpeed, simView, simAction } = button.dataset;
    if (simRoute) this.setRoute(simRoute);
    else if (simSpeed) this.setSpeed(Number(simSpeed));
    else if (simView) this.setView(simView);
    else if (simAction === 'play') this.togglePlay();
    else if (simAction === 'restart') this.restart();
    else if (simAction === 'fewer') this.setVisitors(this.engine.perRoute - 1);
    else if (simAction === 'more') this.setVisitors(this.engine.perRoute + 1);
    else if (simAction === 'follow') this.setFollow(!this.following);
    else if (simAction === 'source') this.setSourcePlan(!this.sourcePlan);
  }

  // A click that was not a drag selects the visitor under the pointer.
  #handlePick(event) {
    const press = this.press;
    this.press = null;
    if (!press || !this.scene?.pick || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5 || event.timeStamp - press.time > 450) return;
    const box = this.viewport.getBoundingClientRect();
    const id = this.scene.pick(event.clientX - box.left, event.clientY - box.top);
    if (id) this.setFollow(id);
  }

  #trackFollow(snapshot) {
    if (!this.following) return;
    const visitors = snapshot.visitors;
    if (visitors.some(visitor => visitor.id === this.followId && visitor.visible && visitor.state !== 'leaving')) return;
    // The followed journey ended: move on to whoever has most of the same journey ahead.
    const next = visitors.filter(visitor => visitor.visible && visitor.state === 'walking')
      .sort((a, b) => (b.routeId === this.followRoute) - (a.routeId === this.followRoute) || a.progress - b.progress)[0];
    if (!next) return;
    this.followId = next.id;
    this.followRoute = next.routeId;
    this.scene?.setFollow(next.id);
    this.#syncControls();
  }

  #renderCounts(snapshot) {
    const text = `${snapshot.counts.walking}|${snapshot.counts.dwelling}|${snapshot.completed}`;
    if (text === this.countText) return;
    this.countText = text;
    const [walking, stopped, journeys] = text.split('|');
    this.root.querySelector('[data-sim-count="walking"]').textContent = walking;
    this.root.querySelector('[data-sim-count="stopped"]').textContent = stopped;
    this.root.querySelector('[data-sim-count="journeys"]').textContent = journeys;
  }

  #syncControls() {
    const root = this.root, playing = this.engine.playing;
    root.dataset.playing = String(playing);
    root.dataset.view = this.view;
    root.dataset.route = this.selected;
    if (this.hint && this.scene) this.hint.textContent = HINT[this.scene.kind === 'webgl' ? this.view : this.scene.kind] ?? '';
    const play = root.querySelector('#sim-play');
    play.innerHTML = playing ? `${ICONS.pause}<span>Pause</span>` : `${ICONS.play}<span>Play</span>`;
    play.setAttribute('aria-label', playing ? 'Pause visitor simulation' : 'Play visitor simulation');
    for (const el of root.querySelectorAll('[data-sim-route]')) el.setAttribute('aria-pressed', String(el.dataset.simRoute === this.selected));
    for (const el of root.querySelectorAll('[data-sim-speed]')) el.setAttribute('aria-pressed', String(Number(el.dataset.simSpeed) === this.engine.speed));
    for (const el of root.querySelectorAll('[data-sim-view]')) el.setAttribute('aria-pressed', String(el.dataset.simView === this.view));
    root.querySelector('#sim-count').textContent = String(this.engine.perRoute);
    root.querySelector('[data-sim-action="fewer"]').disabled = this.engine.perRoute <= MIN_VISITORS;
    root.querySelector('[data-sim-action="more"]').disabled = this.engine.perRoute >= MAX_VISITORS;
    root.querySelector('[data-sim-action="source"]').setAttribute('aria-pressed', String(this.sourcePlan));
    const follow = root.querySelector('[data-sim-action="follow"]');
    follow.setAttribute('aria-pressed', String(this.following));
    follow.style.setProperty('--route', FLOW_ROUTES.find(route => route.id === this.followRoute)?.color ?? 'currentColor');
  }

  #refresh() {
    this.last = null;
    this.stale = true;
    this.#syncControls();
    this.#schedule();
  }

  #sourceFailed() {
    this.sourcePlan = false;
    this.#refresh();
  }

  play() { this.engine.setPlaying(true); this.#refresh(); }

  pause() { this.engine.setPlaying(false); this.#refresh(); }

  togglePlay() { if (this.engine.playing) this.pause(); else this.play(); }

  restart() {
    this.engine.reset();
    this.clock = 0;
    this.#refresh();
  }

  /** `'all'` or one route id from FLOW_ROUTES. */
  setRoute(id) {
    const selected = FLOW_ROUTES.some(route => route.id === id) ? id : 'all';
    this.selected = selected;
    this.engine.setRoutes(selected === 'all' ? FLOW_ROUTES.map(route => route.id) : [selected]);
    this.scene?.setActiveRoutes(this.engine.activeRouteIds);
    this.#refresh();
  }

  setSpeed(multiplier) { this.engine.setSpeed(multiplier); this.#refresh(); }

  setVisitors(count) {
    this.engine.setPerRoute(Math.min(MAX_VISITORS, Math.max(MIN_VISITORS, Math.round(Number(count)) || MIN_VISITORS)));
    this.#refresh();
  }

  /** `'perspective'` or `'plan'`. Choosing the current view again recentres it. */
  setView(view) {
    if (view !== 'perspective' && view !== 'plan') return;
    this.view = view;
    this.scene?.setView(view);
    this.#refresh();
  }

  /** `true` follows a suitable visitor, a visitor id follows that one, `false` stops. */
  setFollow(target) {
    this.following = Boolean(target);
    this.followId = typeof target === 'string' ? target : null;
    this.followRoute = this.followId ? this.followId.split('-')[0] : this.selected === 'all' ? null : this.selected;
    if (this.following && this.followId) this.scene?.setFollow(this.followId);
    if (!this.following) this.scene?.setFollow(null);
    this.#refresh();
  }

  setSourcePlan(show) {
    this.sourcePlan = Boolean(show);
    this.scene?.setSourcePlan(this.sourcePlan, () => this.#sourceFailed());
    this.#refresh();
  }

  /** Engine snapshot plus the interface state; intended for QA. */
  snapshot() {
    return { ...this.engine.snapshot(), route: this.selected, view: this.view, renderer: this.renderer, following: this.following ? this.followId : null, sourcePlan: this.sourcePlan };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.engine.setPlaying(false);
    this.#cancelFrame();
    this.resizeObserver.disconnect();
    this.root.removeEventListener('click', this.onClick);
    this.viewport.removeEventListener('pointerdown', this.onPointerDown);
    this.viewport.removeEventListener('pointerup', this.onPointerUp);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('keydown', this.onKey, true);
    this.scene?.dispose();
    this.scene = null;
    this.root.remove();
    this.stage.classList.remove('flow-stage', 'simulation-stage', 'flow-stage-static');
    if (this.caption?.textContent === CAPTION) this.caption.textContent = '';
    if (this.hint && Object.values(HINT).includes(this.hint.textContent)) this.hint.textContent = '';
  }
}
