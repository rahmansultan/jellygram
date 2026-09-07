/**
 * Shrink the free-space reserve for a suite that moves a few megabytes.
 *
 * The pipeline refuses any ingestion that would leave less than
 * MIN_FREE_DISK_BYTES free, plus DISK_SAFETY_MARGIN_BYTES of headroom — 12 GiB
 * together by default. That is the right policy for a media server and the
 * wrong precondition for a test: these suites move fixtures measured in
 * megabytes, but inherited the production reserve and so refused to run
 * anywhere with less than 12 GiB free. A contributor working in a container, on
 * a CI runner, or on a checkout under /tmp got
 *
 *     FATAL: Insufficient disk space: Need 12.0 GiB free, only 978 MiB available
 *
 * which reads like an application bug and is not one.
 *
 * The policy itself is still tested — `tests/validation.test.ts` asserts that
 * the requirement is the file plus the margin plus the reserve, and that a file
 * which does not fit is refused with a reason. What these suites test is the
 * pipeline, and the reserve is only in the way of that.
 *
 * 16 MiB of reserve and 8 MiB of margin: small enough for any machine that can
 * check out the repository, large enough that the check is still genuinely
 * evaluated rather than disabled.
 *
 * Imported before the config module, like the other environment helpers.
 */
process.env['MIN_FREE_DISK_BYTES'] = String(16 * 1024 * 1024);
process.env['DISK_SAFETY_MARGIN_BYTES'] = String(8 * 1024 * 1024);
