/**
 * What to call a run in a list.
 *
 * Split out of App.tsx when the pages became modules. Run Explorer and the
 * Benchmark Lab both list runs, and a benchmark row named one way in one list
 * and another way in the other is two names for the same run.
 */
import type { Run } from './app-types';

// Benchmark-suite rows come back without a prompt, so fall back to a readable label.
export function runLabel(run: Run) {
  return run.prompt?.trim() || 'Benchmark suite run';
}
