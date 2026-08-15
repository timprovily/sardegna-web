// Making the drive screen cheaper to keep on.
//
// First, the thing this cannot do: a web page cannot change the phone's
// backlight. There is no API for it in Safari, and there won't be — the
// brightness slider belongs to the operating system. So instead of
// dimming the display, the app dims *itself*: a black overlay that fades
// in when nothing is happening and clears the moment something does.
//
// On an OLED screen — every iPhone from the X onwards — that is not
// merely cosmetic. Black pixels are switched off rather than lit, so a
// mostly-black screen genuinely draws less current. On an older LCD it
// saves nothing at all, which is worth knowing before expecting miracles.
//
// The larger saving is invisible: while you're cruising, the app stops
// redrawing a map that isn't changing. Map tiles and marker updates cost
// far more than the backlight does.

// With holds keeping the screen lit whenever there is something to act
// on, the idle timer only has to cover genuinely empty stretches — so it
// can be a good deal shorter than it was.
const DIM_AFTER_MS = 25000;
const FADE_MS = 1200;
// A touch means you're looking, so give it longer than a passing event.
const TOUCH_HOLD_MS = 40000;

export class PowerSaver extends EventTarget {
  constructor(settings) {
    super();
    this.settings = settings;
    this.overlay = null;
    this.dimmed = false;
    this.active = false;
    this.idleTimer = null;
    this.lastActivity = Date.now();
    this._onInteract = () => this.wake('touch');
  }

  get enabled() {
    return this.settings.powerSaving !== false;
  }

  /**
   * Reasons the screen must stay lit right now.
   *
   * Waking on an event and then fading out again on a timer was the wrong
   * model: a turn announced at three hundred metres would light the
   * screen and go dark again while you were still approaching the
   * junction — precisely when you'd want to glance at it. So instead of
   * only reacting to moments, the app asks whether there is currently
   * something to act on, and refuses to dim while there is.
   */
  hold(reason, active) {
    if (!this._holds) this._holds = new Set();
    const had = this._holds.size > 0;

    if (active) this._holds.add(reason);
    else this._holds.delete(reason);

    const has = this._holds.size > 0;
    if (has && !had) {
      this.wake('hold');
    } else if (!has && had) {
      // The last reason has gone; start counting down again rather than
      // dimming the instant a turn is completed.
      this.wake('release');
    }
  }

  get held() {
    return !!(this._holds && this._holds.size > 0);
  }

  /**
   * How far to fade, where 0 is untouched.
   *
   * Capped at 0.7 deliberately. Past that the manoeuvre banner stops
   * being legible, and a navigation screen you have to touch before you
   * can read it is worse than one that never dims. The saving between
   * 70 and 85 percent is small; the cost is the whole point of the
   * screen.
   */
  get level() {
    const pct = this.settings.dimLevel ?? 45;
    return Math.max(0, Math.min(0.7, pct / 100));
  }

  start() {
    if (this.active) return;
    this.active = true;
    this._ensureOverlay();

    // Any touch anywhere brings it back — including a touch on the dim
    // layer itself, which must not also press whatever is underneath.
    document.addEventListener('pointerdown', this._onInteract, true);
    this.wake('start');
  }

  stop() {
    this.active = false;
    clearTimeout(this.idleTimer);
    document.removeEventListener('pointerdown', this._onInteract, true);
    this._undim();
  }

  /** Called when something worth looking at happens. */
  wake(reason = 'event') {
    if (!this.active) return;
    this.lastActivity = Date.now();
    if (this.dimmed) this._undim();

    clearTimeout(this.idleTimer);
    if (!this.enabled) return;

    const delay = reason === 'touch' ? TOUCH_HOLD_MS : DIM_AFTER_MS;
    this.idleTimer = setTimeout(() => this._dim(), delay);
  }

  _ensureOverlay() {
    if (this.overlay) return;
    const el = document.createElement('div');
    el.className = 'dim-overlay';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    this.overlay = el;
  }

  _dim() {
    if (!this.active || !this.enabled || this.dimmed) return;
    // Something still needs looking at. Check again shortly rather than
    // dropping the timer entirely, so the screen fades as soon as the
    // last reason clears.
    if (this.held) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this._dim(), 4000);
      return;
    }
    this._ensureOverlay();
    this.dimmed = true;
    this.overlay.style.transition = `opacity ${FADE_MS}ms ease-in-out`;
    this.overlay.style.opacity = String(this.level);
    // Only capture taps once actually dark, so the first touch wakes the
    // screen instead of pressing a button you can't see.
    this.overlay.style.pointerEvents = 'auto';
    this.dispatchEvent(new CustomEvent('change', { detail: { dimmed: true } }));
  }

  _undim() {
    if (!this.overlay) return;
    this.dimmed = false;
    this.overlay.style.transition = 'opacity 220ms ease-out';
    this.overlay.style.opacity = '0';
    this.overlay.style.pointerEvents = 'none';
    this.dispatchEvent(new CustomEvent('change', { detail: { dimmed: false } }));
  }
}

/**
 * Throttles map redraws to what the situation warrants.
 *
 * Panning the map, moving the marker and loading tiles is the most
 * expensive thing this screen does, and on a long straight stretch almost
 * none of it is useful. Approaching a turn, or with the screen dimmed and
 * nobody looking, the sensible rates are very different.
 */
export class MapThrottle {
  constructor() {
    this.lastDraw = 0;
  }

  /**
   * @param {object} ctx
   * @param {boolean} ctx.dimmed        screen is faded down
   * @param {number}  ctx.speedKmh
   * @param {number}  ctx.distanceToTurn metres, Infinity when none
   */
  shouldDraw({ dimmed, speedKmh, distanceToTurn }) {
    const now = Date.now();
    const interval = this._intervalFor({ dimmed, speedKmh, distanceToTurn });
    if (now - this.lastDraw < interval) return false;
    this.lastDraw = now;
    return true;
  }

  _intervalFor({ dimmed, speedKmh, distanceToTurn }) {
    // A turn is coming: the map is the whole point, draw every fix.
    if (isFinite(distanceToTurn) && distanceToTurn < 400) return 0;
    // Nobody is looking.
    if (dimmed) return 8000;
    // Stopped at a viewpoint or in traffic — nothing is moving anyway.
    if (speedKmh < 5) return 5000;
    // Cruising: twice a second is invisible to the eye but halves the work.
    return 2000;
  }
}
