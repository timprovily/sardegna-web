// Leaflet + OpenStreetMap tiles. Free, no API key, no account — matching
// the rest of this app's "no cost" constraint. Tile imagery needs a
// connection; the route line and pins are drawn from data already on the
// phone, so they still appear even when the tiles come back grey.

const ICONS = {
  town: '🏘️', viewpoint: '🔭', nature: '🌿', beach: '🌊',
  archaeology: '🏛️', heritage: '📖', mining: '⛏️', culture: '🎭', pass: '⛰️'
};

export class RouteMap {
  constructor(containerId) {
    this.map = L.map(containerId, { zoomControl: false, attributionControl: true });
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors'
    }).addTo(this.map);

    this.polyline = null;
    this.highlightMarkers = new Map();
    this.userMarker = null;
    this.follow = false;
    // The drive screen puts a card over the bottom of the map and a bar
    // across the top. Without accounting for those, "centred" means
    // centred behind the card — your own position ends up hidden under
    // the text. These insets shift the centre into the strip you can
    // actually see.
    this.insetTop = 0;
    this.insetBottom = 0;
  }

  /** Pixels of the map covered by UI at the top and bottom. */
  setInsets({ top = 0, bottom = 0 } = {}) {
    const changed = top !== this.insetTop || bottom !== this.insetBottom;
    this.insetTop = top;
    this.insetBottom = bottom;
    if (changed && this.follow && this.userMarker) {
      this.map.panTo(this._centreFor(this.userMarker.getLatLng()), { animate: false });
    }
  }

  /** Shifts a coordinate so it lands in the middle of the visible strip
   *  rather than the middle of the container. */
  _centreFor(latlng) {
    const shift = (this.insetBottom - this.insetTop) / 2;
    if (!shift) return latlng;
    const zoom = this.map.getZoom();
    const point = this.map.project(latlng, zoom).add([0, shift]);
    return this.map.unproject(point, zoom);
  }

  showRoute(route, geometry) {
    this._clear();

    const latlngs = geometry.map((p) => [p.lat, p.lon]);
    this.polyline = L.polyline(latlngs, {
      color: '#53C4CF',
      weight: 5,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(this.map);

    for (const h of route.highlights) {
      const icon = L.divIcon({
        className: 'pin',
        html: `<span class="pin-dot" data-id="${h.id}">${ICONS[h.kind] || '📍'}</span>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17]
      });
      const marker = L.marker([h.lat, h.lon], { icon }).addTo(this.map);
      marker.on('click', () => this.onHighlightTap && this.onHighlightTap(h));
      this.highlightMarkers.set(h.id, marker);
    }

    this.map.fitBounds(this.polyline.getBounds(), {
      paddingTopLeft: [24, 24 + this.insetTop],
      paddingBottomRight: [24, 24 + this.insetBottom]
    });
  }

  updateGeometry(geometry) {
    if (!this.polyline) return;
    this.polyline.setLatLngs(geometry.map((p) => [p.lat, p.lon]));
  }

  markPlayed(highlightId) {
    const marker = this.highlightMarkers.get(highlightId);
    if (!marker) return;
    const el = marker.getElement();
    if (el) el.querySelector('.pin-dot')?.classList.add('played');
  }

  updateUserPosition(pos) {
    const latlng = [pos.lat, pos.lon];
    if (!this.userMarker) {
      const icon = L.divIcon({
        className: 'user-pin',
        html: `<div class="user-dot"></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });
      this.userMarker = L.marker(latlng, { icon, zIndexOffset: 1000 }).addTo(this.map);
    } else {
      this.userMarker.setLatLng(latlng);
    }
    if (this.follow) this.map.panTo(this._centreFor(latlng), { animate: true, duration: 0.5 });
  }

  setFollow(enabled) {
    this.follow = enabled;
    if (enabled && this.userMarker) {
      this.map.setView(this._centreFor(this.userMarker.getLatLng()), 16);
    }
  }

  invalidateSize() {
    this.map.invalidateSize();
  }

  _clear() {
    if (this.polyline) this.map.removeLayer(this.polyline);
    for (const m of this.highlightMarkers.values()) this.map.removeLayer(m);
    this.highlightMarkers.clear();
    this.polyline = null;
  }
}
