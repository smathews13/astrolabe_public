/**
 * The standing attribution at the right of every top bar.
 *
 * §1: "13px `databricks-symbol-color.svg` + 11.5px #6F6F6F label. The bricks
 * symbol is the only full-color Databricks asset in the app." The other one is
 * the login gate's logo; between them they are the whole of the Databricks
 * artwork this app renders in its own colours.
 *
 * The symbol is inlined from `brand-icons.ts` rather than imported from
 * `assets/brand/` here, because that module is the only file allowed to resolve
 * anything out of the brand directory -- one place pairs artwork with meaning,
 * and brand-icons.test.tsx fails any second one.
 *
 * The whole thing is one labelled element rather than an image with an `alt` and
 * a span beside it. "Built on Databricks" is the sentence; the symbol is the
 * word "Databricks" drawn, so announcing it separately reads the name twice.
 */
import { BUILT_ON_DATABRICKS, DATABRICKS_SYMBOL } from './brand-icons';

export function BuiltOnDatabricks({ className }: { className?: string }) {
  return (
    <span className={`built-on-databricks ${className ?? ''}`.trim()} data-testid="built-on-databricks">
      <span
        className="built-on-databricks-symbol"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: DATABRICKS_SYMBOL }}
      />
      {BUILT_ON_DATABRICKS}
    </span>
  );
}
