/**
 * CI is still pending. The ready job waits and runs `record_ci_wait` again.
 * A pending check does not count as a failed attempt and does not enter Review.
 */
export class CiPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CiPendingError";
  }
}
