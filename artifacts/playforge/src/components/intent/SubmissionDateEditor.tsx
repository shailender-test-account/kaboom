import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthContext } from "@/contexts/AuthContext";
import { useUpdateInboundSubmissionDate } from "@/hooks/use-intent";
import { formatReportDate } from "@/lib/reportTime";

export default function SubmissionDateEditor({ id, submittedAt, origin }: {
  id: number; submittedAt: string | null; origin?: string;
}) {
  const { user } = useAuthContext();
  const save = useUpdateInboundSubmissionDate();
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState("");
  const open = () => {
    const value = submittedAt ? new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(submittedAt)) : "";
    setDate(value); setEditing(true); save.reset();
  };
  return <div className="mt-2 text-xs" data-testid={`submission-date-${id}`}>
    <p>Submission date: {submittedAt ? formatReportDate(submittedAt) : "Not recorded"}
      {origin === "upload" ? " · Upload/import date used" : origin === "edited" ? " · Manually corrected" : ""}</p>
    {user?.role === "admin" && !editing && <button type="button" className="mt-1 underline text-sky-700"
      data-testid={`edit-submission-date-${id}`} onClick={open}>Edit submission date</button>}
    {editing && <form className="mt-1 flex flex-wrap items-center gap-2" onSubmit={async e => {
      e.preventDefault();
      try {
        await save.mutateAsync({ id, submittedDate: date });
        await Promise.all(["hp-bi", "hp-bi-detail", "hp-bi-evidence"].map(key =>
          cache.invalidateQueries({ queryKey: [key] })));
        setEditing(false);
      } catch { /* Error remains visible beside the form. */ }
    }}>
      <input aria-label="Submission date" data-testid={`input-submission-date-${id}`}
        type="date" required value={date} onChange={e => setDate(e.target.value)}
        className="rounded border bg-white px-2 py-1" />
      <button type="submit" disabled={!date || save.isPending} className="rounded bg-sky-700 px-2 py-1 text-white">
        {save.isPending ? "Saving…" : "Save date"}</button>
      <button type="button" disabled={save.isPending} onClick={() => setEditing(false)}>Cancel</button>
      {save.isError && <p role="alert" className="w-full text-red-700">{save.error.message}</p>}
    </form>}
  </div>;
}
