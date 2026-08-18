/**
 * A constellation drawing itself: connectors on `ast-draw`, stars on `ast-pop`.
 *
 * One renderer for the splash, the working strip and the opening sequence, so a
 * star pops the same way in all three. The coordinates are `constellation.ts`.
 *
 * DECORATIVE, ENTIRELY. The whole SVG is `aria-hidden`, and the surface that
 * seats it carries the one `aria-live="polite"` string that says what is
 * happening (§5). Twelve connectors and twenty stars narrating at once say less
 * than nothing.
 *
 * Under `prefers-reduced-motion: reduce` the guard at the foot of
 * astrolabe-animation.css freezes every `ast-anim-*` class AND gives it its rest
 * state, because four of these animations begin at opacity 0 -- `animation: none`
 * alone would leave a reader who asked for less motion looking at an empty navy
 * panel rather than at a still constellation.
 */
import {
  PRODUCT_GLYPHS,
  glyphPath,
  glyphTakesAccent,
  hopPath,
  type Constellation as ConstellationShape,
  type Star,
  type StarGlyph,
} from './constellation';

import { BRAND_THEME_MARKS, type BrandProduct } from './brand-icons';

/**
 * The recoloured product icons, which are the `dark` cut because every seating
 * of a constellation is a navy band.
 *
 * READ OUT OF `brand-icons.ts` RATHER THAN IMPORTED FROM THE DIRECTORY. That
 * module is the app's one pairing of product to drawing, and a component that
 * resolves `assets/logo/theme/genie-blue.svg` for itself has made a second one:
 * the two are never on screen together for anybody to notice they disagree, and
 * this one has the extra hazard of picking a tone the surface is not.
 * `brand-icons.test.tsx` refuses the direct import, and it is right to.
 *
 * The theme cut and never `assets/brand/`: those copies are #6FAEDD over
 * #B7D6EE, and §2 permits exactly two full-colour Databricks assets in the
 * product -- the top bar's bricks symbol and the login gate's logo. A star in a
 * night sky is neither.
 */
const PRODUCT_STARS: Partial<Record<StarGlyph, BrandProduct>> = {
  'databricks-sql': 'databricks-sql',
  genie: 'genie',
  'mosaic-ai': 'mosaic-ai',
  'unity-catalog': 'unity-catalog',
};

/**
 * One product's artwork as something `<image href>` can take.
 *
 * The map holds markup, because everywhere else in the app a product mark is
 * inlined into the document and coloured by the surface. Here it is a star
 * inside another SVG, positioned by the constellation's own coordinates, so it
 * stays an `<image>` and the markup becomes its source. `encodeURIComponent`
 * rather than base64: the payload is text either way, and a data URI that can
 * be read in a devtools panel is worth the handful of extra bytes.
 */
function starHref(glyph: StarGlyph): string | null {
  const product = PRODUCT_STARS[glyph];
  if (!product) return null;
  return `data:image/svg+xml,${encodeURIComponent(BRAND_THEME_MARKS.dark[product])}`;
}

function StarGlyphShape({ star }: { star: Star }) {
  if (PRODUCT_GLYPHS.includes(star.glyph)) {
    const href = starHref(star.glyph);
    if (!href) return null;
    return <image href={href} x={star.x - star.size} y={star.y - star.size} width={star.size * 2} height={star.size * 2} />;
  }
  if (star.glyph === 'dot') {
    return <circle cx={star.x} cy={star.y} r={star.size} className="ast-star-ink" opacity={star.opacity} />;
  }
  const path = glyphPath(star);
  if (!path) return null;
  const accent = glyphTakesAccent(star.glyph);
  // The filled glyph and the stroked ones. A sparkle is a mass; a cross, a
  // square, a triangle and a d-pad cross are line drawings, and the stroke width
  // scales with the glyph so a 4-unit cross in a 56px strip is not a hairline.
  if (star.glyph === 'sparkle') {
    return <path d={path} className="ast-star-accent-fill" />;
  }
  return (
    <path
      d={path}
      className={accent ? 'ast-star-accent' : 'ast-star-ink-stroke'}
      strokeWidth={Math.max(1.6, +(star.size * 0.36).toFixed(2))}
      strokeLinecap={star.glyph === 'triangle' ? undefined : 'round'}
      strokeLinejoin={star.glyph === 'triangle' ? 'round' : undefined}
      fill="none"
    />
  );
}

export function ConstellationField({
  shape,
  className,
  exitTo,
}: {
  shape: ConstellationShape;
  className?: string;
  /**
   * Where the stars travel to when the sky is leaving, in this shape's own
   * coordinates. Absent everywhere but the login transition, which is the only
   * seating a constellation exits from.
   *
   * ADDITIVE ON PURPOSE. Three surfaces draw a constellation and a fourth is
   * being added beside this one, so the exit is an extra wrapper around each star
   * rather than a change to how a star pops: the pop's own delay stays on the
   * element that owns it, and a seating that passes nothing renders exactly the
   * markup it rendered before.
   */
  exitTo?: (star: Star, at: number) => { dx: number; dy: number; delaySeconds: number };
}) {
  const loop = `${shape.loopSeconds}s`;
  return (
    <svg
      className={`ast-constellation ${className ?? ''}`.trim()}
      width={shape.width}
      height={shape.height}
      viewBox={`0 0 ${shape.width} ${shape.height}`}
      fill="none"
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMid slice"
    >
      {/* The connectors. `pathLength="1"` with `stroke-dasharray="1"` is what
          lets ONE keyframe draw lines of every length: the offset runs 1 to 0 in
          normalised units, so a short spur and a long chain finish together. */}
      <g className="ast-constellation-lines" style={{ opacity: shape.lineOpacity }}>
        {shape.hops.map((hop) => (
          <path
            key={`${hop.from.join()}-${hop.to.join()}`}
            className="ast-anim-draw"
            d={hopPath(hop)}
            pathLength={1}
            strokeDasharray={1}
            style={{ animationDuration: loop, animationDelay: `${hop.delay}s` }}
          />
        ))}
      </g>
      {/* Each star pops as its connector reaches it. The transform origin is the
          star's own centre, or the 1.25 overshoot pulls it towards the panel's
          corner instead of growing in place. */}
      {shape.stars.map((star, at) => {
        const exit = exitTo?.(star, at);
        const pop = (
          <g
            key={`${star.x}-${star.y}`}
            className="ast-anim-pop"
            style={{
              transformOrigin: `${star.x}px ${star.y}px`,
              animationDuration: loop,
              animationDelay: `${star.delay}s`,
            }}
          >
            <StarGlyphShape star={star} />
          </g>
        );
        if (!exit) return pop;
        // A second group AROUND the pop rather than a second animation on it:
        // `animation-delay` is one list per element, so a travel delay written
        // beside the pop's would have to replace it, and the star would pop at the
        // moment it was supposed to leave. A seating with no exit renders the
        // group above and nothing else, unchanged.
        return (
          <g
            key={`x-${star.x}-${star.y}`}
            className="ast-anim-x-star"
            style={{
              transformOrigin: `${star.x}px ${star.y}px`,
              animationDelay: `${exit.delaySeconds}s`,
              // Each star's own path to the lockup, which is why these are custom
              // properties and not a keyframe: one keyframe has to move
              // twenty-two stars along twenty-two different vectors.
              ['--dx' as string]: `${exit.dx}px`,
              ['--dy' as string]: `${exit.dy}px`,
            }}
          >
            {pop}
          </g>
        );
      })}
      {/* The sky behind the chains: fixed, dim, and never animated. Without it
          the panel reads as a diagram on a dark rectangle rather than as a night
          sky with a constellation in it. */}
      {shape.backdrop.map((dot) => (
        <circle key={`${dot.x}-${dot.y}`} cx={dot.x} cy={dot.y} r={1.3} className="ast-star-ink" opacity={dot.opacity} />
      ))}
    </svg>
  );
}
