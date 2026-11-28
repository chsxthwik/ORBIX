// The ORBIX mark's geometry, the one source for the app (dom.js) and the app icon (tools/icons.mjs).
//
// The mark is an O cut along its vertical axis whose halves swap sides and become )(, the X in ORBIX. Each half is a
// crescent: two quarter curves a little squarer than a circle (handle 0.62 instead of 0.552), so the bends hold their
// weight instead of thinning into the turn. Optical corrections, in units of the mark's height:
//   - the arms (horizontal at the ends) are 20 and the bends (vertical at the waist) 22, because a horizontal stroke
//     looks heavier than a vertical one of the same width;
//   - the two bends overlap by 4.5, enough for a solid crossing and short enough that it reads as an X, not a bar;
//   - the X is 93 wide for 100 tall, so its silhouette looks square (a true square looks wide).
// Small icons do not scale this down: tools/icons.mjs gives each size whole-pixel arms, ends and height.

/** The mark at a height of 100: width, arm, bend, waist overlap and curve handle. */
export const MARK = { H: 100, W: 93, arm: 20, bend: 22, waist: 4.5, k: 0.62 };

const n = (v) => +v.toFixed(3);
const pts = (...p) => p.map(n).join(' ');

/**
 * One crescent as an SVG path. Its ends sit on x = `cx`, its middle at y = `cy`; `side` +1 bulges right `)`, -1 left
 * `(`. `a`/`b` are the outer half-width and half-height, `bend`/`arm` the stroke at the waist and at the ends. `seam`
 * runs the ends past `cx` so the two halves of the O meet without a hairline.
 */
export function crescent(cx, cy, { a, b, bend, arm, k = MARK.k, side = 1, seam = 0 }) {
  const ai = a - bend, bi = b - arm;
  const X = (d) => cx + side * d, Y = (d) => cy + d;
  return `M${pts(X(-seam), Y(-b))}L${pts(X(0), Y(-b))}`
    + `C${pts(X(k * a), Y(-b), X(a), Y(-k * b), X(a), Y(0))}`
    + `C${pts(X(a), Y(k * b), X(k * a), Y(b), X(0), Y(b))}`
    + `L${pts(X(-seam), Y(b))}L${pts(X(-seam), Y(bi))}L${pts(X(0), Y(bi))}`
    + `C${pts(X(k * ai), Y(bi), X(ai), Y(k * bi), X(ai), Y(0))}`
    + `C${pts(X(ai), Y(-k * bi), X(k * ai), Y(-bi), X(0), Y(-bi))}`
    + `L${pts(X(-seam), Y(-bi))}Z`;
}

/**
 * The X as two paths (left `)`, right `(`) in the box x0…x0+W, y0…y0+H. The halves are separate paths so their
 * overlap at the waist stays solid whatever the fill rule.
 */
export function xPaths(x0, y0, { H, W, arm, bend, waist, k = MARK.k }) {
  const b = H / 2, a = W / 2 + waist / 2;
  return [crescent(x0, y0 + b, { a, b, bend, arm, k, side: 1 }), crescent(x0 + W, y0 + b, { a, b, bend, arm, k, side: -1 })];
}

/** How far each half moves from the O (its rest in the 100-unit viewBox) to the X: half the X's width. */
export const SWAP = MARK.W / 2;

const halves = ({ W, arm, bend, waist }) => {
  const a = W / 2 + waist / 2;
  return [crescent(50, 50, { a, b: 50, bend, arm, side: -1, seam: 0.35 }), crescent(50, 50, { a, b: 50, bend, arm, side: 1, seam: 0.35 })];
};

/** The O's two halves in a 100×100 viewBox, centred: `(` then `)`. Moving them ±SWAP makes the X. */
export const [HALF_L, HALF_R] = halves(MARK);

/**
 * The mark drawn `size` px tall, in the same 100-unit viewBox but with its width, arms and end cuts on whole pixels,
 * so the title bar's 18 px X is sharp. `swap` is how far each half moves (viewBox units) to make the X.
 */
export function markFor(size) {
  const u = 100 / size;
  const Wpx = size - 2 * Math.max(0, Math.round(size * 0.035));
  const arm = Math.max(1, Math.floor(size * 0.19 + 0.2));
  const m = { W: Wpx * u, arm: arm * u, bend: arm * 1.12 * u, waist: Math.max(0.5, size * 0.045) * u };
  const [l, r] = halves(m);
  return { l, r, swap: +(m.W / 2).toFixed(3) };
}
