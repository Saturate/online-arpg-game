import { benchSpecKey } from '@rune/shared';
import { BenchMeasurer } from './measurer.js';
import { isMeasureJob, type MeasureJob, type WorkerReply } from './protocol.js';

/**
 * The balance bench's measuring thread: it applies tuning sets to its own copy of the config, so
 * previewing a set never changes the numbers the admin page or anything else reads.
 */
const measurer = new BenchMeasurer();
let job: MeasureJob | null = null;
let next = 0;
let scheduled = false;

function reply(r: WorkerReply): void {
  postMessage(r);
}

// One row per macrotask, so a new job (the admin typed another number) is read between rows.
function work(): void {
  scheduled = false;
  if (!job) return;
  const task = job.tasks[next++];
  const values = task ? job.sets[task.setKey] : undefined;
  if (!task || !values) {
    job = null;
    reply({ t: 'idle' });
    return;
  }
  const t0 = performance.now();
  const measure = measurer.measure(task.setKey, values, task.spec);
  reply({ t: 'result', setKey: task.setKey, rowKey: benchSpecKey(task.spec), measure, ms: performance.now() - t0 });
  schedule();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(work, 0);
}

addEventListener('message', (e: MessageEvent<unknown>) => {
  if (!isMeasureJob(e.data)) return;
  job = e.data;
  next = 0;
  schedule();
});
