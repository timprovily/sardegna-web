// The home-screen overview: all eight routes on one map of Sardinia, each
// in its own colour, so you can see at a glance where a drive actually is
// before opening it. Uses the coarse skeleton waypoints — this is a
// finding-your-bearings map, not a turn-by-turn one, so a precise
// road-snapped line would be wasted detail at this zoom level.

export const ROUTE_COLORS = [
  '#E8837A', '#F2B25A', '#E8D45A', '#9BBF6B',
  '#5FB8A8', '#6FA8DC', '#8C93E8', '#C792EA'
];

export class OverviewMap {
  constructor(containerId) {
    this.map = L.map(containerId, {
      zoomControl: false,
      attributionControl: true,
      dragging: true,
      scrollWheelZoom: false
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors'
    }).addTo(this.map);
  }

  /** routes: array of Route objects, in the same order as ROUTE_COLORS. */
  show(routes, onSelect) {
    const bounds = [];
    routes.forEach((route, index) => {
      const color = ROUTE_COLORS[index % ROUTE_COLORS.length];
      const latlngs = route.waypoints.map((w) => [w.lat, w.lon]);
      const line = L.polyline(latlngs, {
        color,
        weight: 4,
        opacity: 0.9,
        lineCap: 'round'
      }).addTo(this.map);

      line.on('click', () => onSelect(route));
      // A little visual feedback on tap/hover so the line doesn't feel inert.
      line.on('mouseover', () => line.setStyle({ weight: 7 }));
      line.on('mouseout', () => line.setStyle({ weight: 4 }));

      bounds.push(...latlngs);
    });

    if (bounds.length > 0) {
      this.map.fitBounds(bounds, { padding: [16, 16] });
    }
  }

  invalidateSize() {
    this.map.invalidateSize();
  }
}
