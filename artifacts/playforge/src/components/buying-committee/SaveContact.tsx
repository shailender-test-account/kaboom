import { useState } from "react";
import { useSaveCommitteeContact, type CommitteePerson } from "./api";

export default function SaveContact({ person, clientId, canSave }: {
  person: CommitteePerson; clientId: number; canSave: boolean;
}) {
  const [review, setReview] = useState(false);
  const save = useSaveCommitteeContact();
  const contactId = save.data?.contactId ?? person.crmContactId;
  if (contactId) return <div className="mt-2 text-xs">
    <span className="mr-2 text-green-800">In database</span>
    <a className="font-semibold text-[#05628f] underline" href={`${import.meta.env.BASE_URL}crm/contacts/${contactId}`}>Open contact / route to journey or sequence</a>
    {!person.email && <p className="mt-1 text-[#5d7388]">Add an email in the database before using email journeys or sequences.</p>}
  </div>;
  if (!canSave || !/^apollo:\d+$/.test(person.id)) return null;
  return <div className="mt-2">
    {!review ? <button type="button" className="rounded border border-[#c5d3df] px-2 py-1 font-semibold text-[#05628f]" onClick={() => setReview(true)}>Add to database</button> :
      <div className="rounded border border-[#c5d3df] bg-[#f0f7fc] p-2">
        <p>Save {person.name} under {person.companyName} in the roster database? The details shown above will be saved. Existing matching contacts are reused and only missing details are filled. No message is sent and no journey or sequence is started.</p>
        {!person.email && <p className="mt-1">No email is available. You can save this person, but must add an email before email routing.</p>}
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={save.isPending} className="rounded bg-[#0B2A4A] px-2 py-1 text-white disabled:opacity-50"
            onClick={() => save.mutate({clientId,companyId:person.companyId,prospectId:Number(person.id.split(":")[1]),confirm:true})}>
            {save.isPending ? "Saving…" : "Confirm add to database"}
          </button>
          <button type="button" disabled={save.isPending} className="rounded border px-2 py-1" onClick={() => {setReview(false);save.reset();}}>Cancel</button>
        </div>
        {save.isError && <p role="alert" className="mt-1 text-red-700">{save.error.message.replace(/\bApollo\b/gi,"contact discovery")}</p>}
      </div>}
  </div>;
}
