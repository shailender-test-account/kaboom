/**
 * Each input change and each new request invalidates all earlier responses.
 * Comparing only a mapping JSON value cannot distinguish two different files
 * (or a mapping changed away and then back while the request was running).
 */
export class PreviewRevision {
  private revision = 0;
  invalidate() { return ++this.revision; }
  isCurrent(revision: number) { return revision === this.revision; }
}
