/**
 * Let this suite's jobs run.
 *
 * The media-root helper puts the test process into drain mode, so that a
 * suite driving the pipeline handlers itself never has a worker racing it for
 * the same job. This suite is the opposite case: it enqueues real work and
 * waits for the worker started by `test-worker` to claim it, and a parked job
 * would never be claimed. Imported after the media-root helper and before the
 * configuration, so the later assignment is the one the schema reads.
 */
process.env['QUEUE_PAUSED'] = 'false';
