/**
 * Stadium geometry helpers: segment curvature and derived segment geometry.
 *
 * Transcription of the official formulas (headless f066733d):
 *   applySegmentCurve   = off `E.bb(deg)`
 *   computeSegmentGeometry = off `E.Pb()`
 *   prepareStadium      = off `w.Pb()` (Pb on every segment)
 * Float expression order is kept exactly as in the official code.
 */
import type { Segment, Stadium } from './types.js';

/** Degrees -> radians factor used by the official code (literal). */
const DEG_TO_RAD = 0.017453292519943295;
/** Smallest curve (rad, exclusive) that is still treated as curved. off `E.jg` (~10 deg). */
export const CURVE_MIN_RAD = 0.17435839227423353;
/** Largest curve (rad, exclusive) that is still treated as curved. off `E.ig` (~340 deg). */
export const CURVE_MAX_RAD = 5.934119456780721;

/**
 * Applies a curve in DEGREES to a segment (off `E.bb`). A negative curve swaps
 * v0/v1 and negates the bias (0 becomes -0, like the official code); a curve
 * whose magnitude is outside (10 deg, 340 deg) leaves the segment straight
 * (`curveF` unchanged).
 */
export function applySegmentCurve(seg: Segment, degrees: number): void {
  let a = degrees * DEG_TO_RAD;
  if (0 > a) {
    a = -a;
    const v0 = seg.v0;
    seg.v0 = seg.v1;
    seg.v1 = v0;
    seg.bias = -seg.bias;
  }
  if (a > CURVE_MIN_RAD && a < CURVE_MAX_RAD) seg.curveF = 1 / Math.tan(a / 2);
}

/**
 * Recomputes the derived geometry of a segment (off `E.Pb`): unit normal for
 * straight segments; arc centre, radius and the two end normals for curved
 * ones ("curved" = `curveF` finite, tested as `0 == 0 * curveF`).
 */
export function computeSegmentGeometry(seg: Segment): void {
  const p0 = seg.v0;
  const p1 = seg.v1;
  const k = seg.curveF;
  if (0 === 0 * k) {
    const halfX = 0.5 * (p1.x - p0.x);
    const halfY = 0.5 * (p1.y - p0.y);
    const cx = p0.x + halfX + -halfY * k;
    const cy = p0.y + halfY + halfX * k;
    seg.arcCenterX = cx;
    seg.arcCenterY = cy;
    const dx = p0.x - cx;
    const dy = p0.y - cy;
    seg.arcRadius = Math.sqrt(dx * dx + dy * dy);
    let n0x = -(p0.y - cy);
    let n0y = p0.x - cx;
    let n1x = -(cy - p1.y);
    let n1y = cx - p1.x;
    if (0 >= k) {
      n0x = -n0x;
      n0y = -n0y;
      n1x = -n1x;
      n1y = -n1y;
    }
    seg.v0NormalX = n0x;
    seg.v0NormalY = n0y;
    seg.v1NormalX = n1x;
    seg.v1NormalY = n1y;
    seg.normalX = NaN;
    seg.normalY = NaN;
  } else {
    const dx = p0.x - p1.x;
    const ny = -(p0.y - p1.y);
    const len = Math.sqrt(ny * ny + dx * dx);
    seg.normalX = ny / len;
    seg.normalY = dx / len;
    seg.arcCenterX = NaN;
    seg.arcCenterY = NaN;
    seg.arcRadius = 0;
    seg.v0NormalX = NaN;
    seg.v0NormalY = NaN;
    seg.v1NormalX = NaN;
    seg.v1NormalY = NaN;
  }
}

/** off `w.Pb()`: derived geometry for every segment of the stadium. */
export function prepareStadium(stadium: Stadium): void {
  const segs = stadium.segments;
  for (let i = 0; i < segs.length; i++) computeSegmentGeometry(segs[i]!);
}

/** Official stadium validity test (off `w.Sf`). NaN values pass, as officially. */
export function isValidStadium(stadium: Stadium): boolean {
  return !(
    0 >= stadium.discs.length ||
    0 > stadium.bgCornerRadius ||
    0 > stadium.bgKickOffRadius ||
    0 > stadium.playerPhysics.radius
  );
}
