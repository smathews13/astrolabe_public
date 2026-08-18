import { useEffect, useRef } from 'react';
import Plotly, { type PlotConfig, type PlotData, type PlotLayout } from 'plotly.js-cartesian-dist-min';

import { egressPathAllowed } from './egress-policy';

/**
 * The only module that imports Plotly, and the reason it is a module of its own.
 */

/**
 * Everything interactive the notebook has, and nothing that fights a chat transcript.
 *
 * Exported because the read-only half of it is the point and not a detail. An answer
 * is a record of what the agent found, and a figure whose labels can be typed over is
 * not evidence of anything. `chart-read-only.test.ts` asserts this object, so the
 * guarantee survives a rewrite of how the plot is mounted.
 *
 * Config is also the whole of the control surface: which parts of a figure accept a
 * keystroke lives on Plotly's context, never in `layout`, so nothing the agent sends
 * can reopen what is closed here.
 */
export const FIGURE_CONFIG: PlotConfig = {
  displaylogo: false,
  displayModeBar: 'hover',
  responsive: true,
  scrollZoom: false,
  doubleClick: 'reset',
  // The master switch for every `edits` flag -- axis and figure titles, annotations,
  // the key beside the plot. Plotly already defaults it off; stated because a default
  // is not a decision anybody can see, and because it is what a reader of this file
  // should find when they ask whether the figure is writable.
  editable: false,
  // The one that was genuinely open, and how a reader changed an x-axis label by
  // clicking it. Plotly defaults this to `true` and reads it straight off the context
  // WITHOUT consulting `editable`, so turning editing off did not cover it: one click
  // on an axis end handle replaces the tick text with a live text box, and committing
  // it moves that end of the range. Off here, those same handles still drag.
  showAxisRangeEntryBoxes: false,
  // Off by Plotly's default too. Listed with the rest because they are the mode bar's
  // write affordances -- each one hands the figure to an editor elsewhere -- and a
  // list of what is closed is only useful if it is the whole list.
  showEditInChartStudio: false,
  showSendToCloud: false,
  // Selection tools produce no result here. Nothing downstream consumes a selection,
  // and spike lines duplicate what the unified tooltip already shows.
  //
  // `toImage` joins them when this deployment does not permit the chart image
  // download. That download is an egress path and not a view control: a PNG of a
  // figure is an extract of the rows behind it, leaving with no record of what was
  // in it. Plotly offers no boolean for it, so removing the button is the whole
  // mechanism. The path, its default -- off -- and what the app can honestly claim
  // about removing a button are all in `shared/egress-contract.ts`.
  //
  // A GETTER because the deployment's answer arrives from the server after this
  // object is built, and both draw calls must keep passing this object by name:
  // one reviewed config is the guarantee the rest of this file exists to make, and
  // assembling a variant at the call site would satisfy every assertion here while
  // shipping something else. Plotly reads the property while drawing, so each draw
  // gets the current answer. A figure already on screen when an administrator moves
  // the switch takes it on its next draw rather than at once.
  get modeBarButtonsToRemove(): string[] {
    const reading = ['lasso2d', 'select2d', 'toggleSpikelines', 'autoScale2d'];
    return egressPathAllowed('chart-image') ? reading : [...reading, 'toImage'];
  },
};

export interface PlotlyFigureProps {
  data: PlotData[];
  layout: PlotLayout;
  /** Used for the accessible name, since a canvas-like plot has no readable text. */
  title: string;
  height: number;
}

export default function PlotlyFigure({ data, layout, title, height }: PlotlyFigureProps) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    // `react` rather than `newPlot`: it diffs against what is already drawn, so a
    // re-render from a parent state change does not tear the chart down and rebuild it.
    void Plotly.react(element, data, { ...layout, autosize: true, height }, FIGURE_CONFIG);

    // `responsive: true` only listens for window resizes. The answer column also changes
    // width when the conversation rail opens or the viewport rotates, neither of which
    // fires one, so the container is observed directly.
    const observer = new ResizeObserver(() => {
      void Plotly.react(element, data, { ...layout, autosize: true, height }, FIGURE_CONFIG);
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      // Plotly attaches listeners and a WebGL-free canvas stack outside React's tree, so
      // dropping the node without purging leaks both.
      Plotly.purge(element);
    };
  }, [data, layout, height]);

  // `role="img"` with the chart's own title: Plotly draws into SVG whose text nodes read
  // as a stream of disconnected axis labels, so the panel announces itself once instead.
  return <div ref={host} role="img" aria-label={title} className="w-full" style={{ height }} />;
}
