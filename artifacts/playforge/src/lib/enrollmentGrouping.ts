/**
 * groupEnrollments — production grouping utility for EnrollmentsView.
 *
 * Groups a flat list of enrollment rows (as returned by
 * GET /api/email-sequences/:id/enrollments) by contact, sorted newest-first
 * within each group and with groups ordered by their most-recent enrollment.
 *
 * Extracted from the EnrollmentsView useMemo so it can be unit-tested
 * directly against the real implementation.
 */

export type EnrollmentRow = {
  id: number;
  contact_id: number;
  sequence_id: number;
  status: string;
  current_step_id: number | null;
  enrolled_at: string | null;
  completed_at: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  lead_score: number | null;
  re_enrollment_number: number;
  [key: string]: unknown;
};

export type ContactGroup = {
  contactId: number;
  latest: EnrollmentRow;
  enrollments: EnrollmentRow[];
};

export function groupEnrollments(enrollments: EnrollmentRow[]): ContactGroup[] {
  const map = new Map<number, EnrollmentRow[]>();
  for (const e of enrollments) {
    const arr = map.get(e.contact_id) ?? [];
    arr.push(e);
    map.set(e.contact_id, arr);
  }
  const result: ContactGroup[] = [];
  for (const [contactId, enrs] of map) {
    const sorted = [...enrs].sort(
      (a, b) =>
        new Date(b.enrolled_at ?? 0).getTime() -
        new Date(a.enrolled_at ?? 0).getTime(),
    );
    result.push({ contactId, latest: sorted[0], enrollments: sorted });
  }
  // Groups sorted by their most-recent enrollment DESC
  result.sort(
    (a, b) =>
      new Date(b.latest.enrolled_at ?? 0).getTime() -
      new Date(a.latest.enrolled_at ?? 0).getTime(),
  );
  return result;
}
