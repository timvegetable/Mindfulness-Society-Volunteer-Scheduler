import type { SchedulingRun, Snapshot } from '../../shared/domain/models';

/** Failed/staged publications never replace the last completed output. */
export function currentSchedulingRun(snapshot: Pick<Snapshot, 'schedulingRuns'>): SchedulingRun | null {
  return snapshot.schedulingRuns.reduce<SchedulingRun | null>((current, run) =>
    run.status === 'completed' && (!current || run.outputRevision > current.outputRevision) ? run : current, null);
}
