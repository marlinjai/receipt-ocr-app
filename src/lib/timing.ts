import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * How long each step of a slow page took, written to the server log. A page
 * opens a measurement with `measurePage`; any code it calls, however deep,
 * marks a step with `timed`. Outside a measurement `timed` only runs the step.
 * Steps that run side by side overlap, so their sum can exceed the total.
 *
 * The log line holds the page, durations and counts, never receipt data.
 */

/** A page faster than this writes nothing. */
const SLOW_MS = 700;

interface Measurement {
  steps: Array<[label: string, ms: number]>;
}

const current = new AsyncLocalStorage<Measurement>();

export async function measurePage<T>(page: string, run: () => Promise<T>): Promise<T> {
  const measurement: Measurement = { steps: [] };
  const start = performance.now();
  try {
    return await current.run(measurement, run);
  } finally {
    const total = Math.round(performance.now() - start);
    if (total >= SLOW_MS) {
      const steps = measurement.steps.map(([label, ms]) => `${label} ${ms}`).join(', ');
      console.info(`[timing] ${page} ${total}ms: ${steps}`);
    }
  }
}

export async function timed<T>(label: string, step: () => Promise<T>): Promise<T> {
  const measurement = current.getStore();
  if (!measurement) return step();
  const start = performance.now();
  try {
    return await step();
  } finally {
    measurement.steps.push([label, Math.round(performance.now() - start)]);
  }
}
