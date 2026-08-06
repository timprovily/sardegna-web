// Manoeuvre icons, drawn rather than borrowed.
//
// The visual grammar is the one every driver already knows from a car's
// own navigation: a single thick stroke rising from the bottom of the
// frame, bending once, and ending in a solid arrowhead. Rounded caps and
// joins, no outline, no gradient — it has to read at a glance in bright
// sun through a windscreen.
//
// Rather than hand-plotting a dozen near-identical paths, the turns are
// generated from one angle. That keeps every arrow geometrically
// consistent: the stem always starts in the same place, the corner always
// has the same radius, and only the departure angle changes. Hand-drawn
// variants tend to drift a pixel here and there and look subtly wrong
// next to each other.

const SIZE = 32;
const PIVOT = { x: 16, y: 16 };   // where the stroke bends
const STEM_BOTTOM = 29;
const CORNER = 4.5;               // radius of the bend
const ARM = 13;                   // pivot to arrow tip
const HEAD_LEN = 7;
const HEAD_HALF = 6.5;
// The arm has to outreach the corner plus the head, or the line after the
// bend runs backwards into the arrowhead and the whole thing reads as a
// little flag instead of an arrow. ARM - HEAD_LEN must stay above CORNER.

/** Angle in degrees, measured clockwise from straight ahead. */
const ANGLES = {
  straight: 0,
  'slight right': 45,
  right: 90,
  'sharp right': 135,
  'slight left': -45,
  left: -90,
  'sharp left': -135
};

function turnMarkup(angleDeg) {
  // A turn past a right angle doubles back alongside its own stem, so the
  // arrowhead lands on the line it came from and the whole thing reads as
  // a flag. The fix is geometric, not cosmetic: shift the bend sideways
  // towards the turn and pull it up the frame, so the returning arm runs
  // clear of the stem. Drawing it at a slightly shallower angle than the
  // true 135 degrees buys the last of the clearance, and nobody has ever
  // misread a sharp left for anything else.
  const sharp = Math.abs(angleDeg) > 100;
  const towards = Math.sign(angleDeg) || 1;
  const drawAngle = sharp ? towards * 122 : angleDeg;
  const pivot = {
    x: PIVOT.x + (sharp ? towards * 2.5 : 0),
    y: sharp ? 12 : PIVOT.y
  };
  const corner = sharp ? 3.5 : CORNER;
  const arm = sharp ? 14 : ARM;

  const rad = (drawAngle * Math.PI) / 180;
  const dir = { x: Math.sin(rad), y: -Math.cos(rad) };
  const perp = { x: -dir.y, y: dir.x };

  const tip = { x: pivot.x + dir.x * arm, y: pivot.y + dir.y * arm };
  const base = { x: tip.x - dir.x * HEAD_LEN, y: tip.y - dir.y * HEAD_LEN };
  const b1 = { x: base.x + perp.x * HEAD_HALF, y: base.y + perp.y * HEAD_HALF };
  const b2 = { x: base.x - perp.x * HEAD_HALF, y: base.y - perp.y * HEAD_HALF };

  // Straight ahead has no corner to round, so the stroke is one line.
  const stroke = angleDeg === 0
    ? `M${pivot.x} ${STEM_BOTTOM} L${n(base.x)} ${n(base.y)}`
    : `M${pivot.x} ${STEM_BOTTOM} V${n(pivot.y + corner)} ` +
      `Q${pivot.x} ${pivot.y} ${n(pivot.x + dir.x * corner)} ${n(pivot.y + dir.y * corner)} ` +
      `L${n(base.x)} ${n(base.y)}`;

  return `
    <path d="${stroke}" fill="none" stroke="currentColor" stroke-width="3.4"
          stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M${n(tip.x)} ${n(tip.y)} L${n(b1.x)} ${n(b1.y)} L${n(b2.x)} ${n(b2.y)} Z"
          fill="currentColor"/>`;
}

/**
 * A roundabout: the ring, the road in, and the road out.
 *
 * Italy drives on the right, so traffic runs anticlockwise and the first
 * exit is the one on your right. Where OSRM gives us no turn modifier we
 * fall back to that ordering, which is right far more often than not.
 */
function roundaboutMarkup(step) {
  const centre = { x: 16, y: 14 };
  const ring = 5.6;

  let angle;
  if (step.modifier && ANGLES[step.modifier] !== undefined) {
    angle = ANGLES[step.modifier];
  } else {
    angle = { 1: 90, 2: 0, 3: -90, 4: 165 }[step.exit] ?? 0;
  }

  const rad = (angle * Math.PI) / 180;
  const dir = { x: Math.sin(rad), y: -Math.cos(rad) };
  const perp = { x: -dir.y, y: dir.x };

  const leave = { x: centre.x + dir.x * ring, y: centre.y + dir.y * ring };
  const tip = { x: centre.x + dir.x * (ring + 10), y: centre.y + dir.y * (ring + 10) };
  const base = { x: tip.x - dir.x * 6, y: tip.y - dir.y * 6 };
  const b1 = { x: base.x + perp.x * 5.5, y: base.y + perp.y * 5.5 };
  const b2 = { x: base.x - perp.x * 5.5, y: base.y - perp.y * 5.5 };

  return `
    <circle cx="${centre.x}" cy="${centre.y}" r="${ring}" fill="none"
            stroke="currentColor" stroke-width="2.6" opacity="0.5"/>
    <path d="M16 30 V${n(centre.y + ring)}" fill="none" stroke="currentColor"
          stroke-width="3.2" stroke-linecap="round"/>
    <path d="M${n(leave.x)} ${n(leave.y)} L${n(base.x)} ${n(base.y)}" fill="none"
          stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M${n(tip.x)} ${n(tip.y)} L${n(b1.x)} ${n(b1.y)} L${n(b2.x)} ${n(b2.y)} Z"
          fill="currentColor"/>`;
}

/** A U-turn: up one side, over the top, back down with the head below. */
function uturnMarkup(left = true) {
  const path = left
    ? 'M21 30 V13 A4.5 4.5 0 0 0 12 13 V19'
    : 'M11 30 V13 A4.5 4.5 0 0 1 20 13 V19';
  const tipX = left ? 12 : 20;
  return `
    <path d="${path}" fill="none" stroke="currentColor" stroke-width="3.2"
          stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M${tipX} 29 L${tipX - 6} 18.5 L${tipX + 6} 18.5 Z" fill="currentColor"/>`;
}

/** Arrival: a flag, because a pin reads as "you are here" instead. */
function arriveMarkup() {
  return `
    <path d="M10 29.5 V4.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/>
    <path d="M11.4 5.4 H24.5 L20.4 11 L24.5 16.6 H11.4 Z" fill="currentColor"/>`;
}

/**
 * Merging and slip roads: the arrow you take, plus a faint line for the
 * road you're joining or leaving. That second line is the whole
 * difference between "bear right" and "take the exit".
 */
function rampMarkup(step) {
  const left = (step.modifier || '').includes('left');
  return `
    <path d="M16 30 V4" fill="none" stroke="currentColor" stroke-width="2.4"
          stroke-linecap="round" opacity="0.32"/>
    ${turnMarkup(left ? -45 : 45)}`;
}

function n(value) {
  return Math.round(value * 10) / 10;
}

/** Full <svg> element for a manoeuvre, sized by CSS. */
export function maneuverIconSVG(step) {
  let inner;

  switch (step.type) {
    case 'arrive':
      inner = arriveMarkup();
      break;
    case 'roundabout':
    case 'rotary':
      inner = roundaboutMarkup(step);
      break;
    case 'merge':
      inner = rampMarkup(step);
      break;
    case 'on ramp':
      inner = rampMarkup(step);
      break;
    case 'off ramp':
      inner = rampMarkup(step);
      break;
    case 'fork':
      // A lane choice, not a turn — always the gentle angle.
      inner = turnMarkup((step.modifier || '').includes('left') ? -45 : 45);
      break;
    default: {
      if (step.modifier === 'uturn') {
        inner = uturnMarkup(true);
        break;
      }
      const angle = ANGLES[step.modifier];
      inner = turnMarkup(angle === undefined ? 0 : angle);
    }
  }

  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;
}
