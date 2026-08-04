// Wraps navigator.geolocation.watchPosition.
//
// Note for the record: this works fine in mobile Safari. It is the Tesla
// in-car browser specifically that has, historically, given third-party
// sites no way to grant location access at all — which is the reason this
// app targets the phone rather than the car's own screen.

export class LocationService extends EventTarget {
  constructor() {
    super();
    this.watchId = null;
    this.last = null; // { lat, lon, accuracy, speedKmh, headingDeg, timestamp }
  }

  get isSupported() {
    return 'geolocation' in navigator;
  }

  start() {
    if (!this.isSupported || this.watchId != null) return;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._handle(pos),
      (err) => this.dispatchEvent(new CustomEvent('error', { detail: err })),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  }

  stop() {
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  _handle(pos) {
    const c = pos.coords;
    // Some browsers report -1 or null when speed/heading are unknown.
    const speedKmh = typeof c.speed === 'number' && c.speed >= 0 ? c.speed * 3.6 : 0;
    const headingDeg = typeof c.heading === 'number' && c.heading >= 0 ? c.heading : null;

    this.last = {
      lat: c.latitude,
      lon: c.longitude,
      accuracy: c.accuracy,
      speedKmh,
      headingDeg,
      timestamp: pos.timestamp
    };
    this.dispatchEvent(new CustomEvent('position', { detail: this.last }));
  }
}
