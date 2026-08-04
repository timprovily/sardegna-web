// Keeps the phone's screen from dimming or locking while a drive is
// active, using the Screen Wake Lock API.
//
// iOS support: works in Safari from iOS 16.4. For an app added to the
// home screen specifically (which is how this app is meant to be used),
// Apple had a long-standing bug that stopped it working in that
// standalone mode — fixed in iOS 18.4. On an older iOS, requesting the
// lock will either silently fail or simply have no effect; this class
// treats that as a normal, expected outcome rather than an error.
//
// The OS releases the lock on its own whenever the tab is backgrounded
// (screen locked, app switched away from, etc). This class listens for
// that and re-requests the lock the moment the app becomes visible again,
// so you don't have to think about it.

export class WakeLockManager extends EventTarget {
  constructor() {
    super();
    this.sentinel = null;
    this.wantsActive = false;

    document.addEventListener('visibilitychange', () => {
      if (this.wantsActive && document.visibilityState === 'visible') {
        this._request();
      }
    });
  }

  get isSupported() {
    return 'wakeLock' in navigator;
  }

  get isActive() {
    return this.sentinel != null && !this.sentinel.released;
  }

  /** Call when the drive screen opens. */
  async enable() {
    this.wantsActive = true;
    await this._request();
  }

  /** Call when the drive screen closes. */
  async disable() {
    this.wantsActive = false;
    if (this.sentinel && !this.sentinel.released) {
      try { await this.sentinel.release(); } catch { /* already gone */ }
    }
    this.sentinel = null;
  }

  async _request() {
    if (!this.isSupported) {
      this.dispatchEvent(new CustomEvent('change', { detail: { active: false, reason: 'unsupported' } }));
      return;
    }
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.dispatchEvent(new CustomEvent('change', { detail: { active: false, reason: 'released' } }));
      });
      this.dispatchEvent(new CustomEvent('change', { detail: { active: true } }));
    } catch (err) {
      // Common, harmless reasons: battery saver is on, the tab isn't
      // visible yet, or (pre-18.4) the app is running as a standalone
      // home-screen icon. Nothing to alarm the user with.
      this.dispatchEvent(new CustomEvent('change', { detail: { active: false, reason: err.name } }));
    }
  }
}
