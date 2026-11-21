import { useInboundResponses, useDeleteInboundResponse, useReviewInboundAffinity, useSetInboundCategory, useReviewInboundIdentity, type InboundResponse } from "@/hooks/use-intent";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Trash2 } from "lucide-react";
import { useAuthContext } from "@/contexts/AuthContext";
import { formatReportDateTime } from "@/lib/reportTime";
import SubmissionDateEditor from "./SubmissionDateEditor";

function IdentityConflict({response}:{response:InboundResponse}) {
  const conflict=response.identityConflict;
  const [choice,setChoice]=useState<"keep"|"relink"|null>(null);
  const save=useReviewInboundIdentity();
  const {toast}=useToast();
  const {user}=useAuthContext();
  if(!conflict)return null;
  const record=(label:string,person:typeof conflict.owner|null)=><div className="rounded border bg-white p-3 text-sm">
    <p className="font-semibold">{label}</p>
    {person?<p>{person.name||"Unnamed contact"} · {person.accountName??"No account"}<br/>
      Email: {person.email??"Not provided"} · Phone: {person.phone??"Not provided"}
      <br/>Contact #{person.id}</p>:<p>No contact linked to this response.</p>}
  </div>;
  return <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4" data-testid={`identity-conflict-${response.id}`}>
    <p className="font-semibold text-amber-950">Email conflict {conflict.review?`· reviewed: ${conflict.review==="keep"?"kept with source account":"relinked to email owner"}`:"· needs admin review"}</p>
    <p className="mt-1 text-sm">Form email <strong>{conflict.email}</strong> belongs to a contact at another account. A matching first name is not proof of identity.</p>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {record(`Form account: ${conflict.sourceAccountName??`#${conflict.sourceAccountId}`}`,conflict.sourceContact)}
      {record("Contact owning the form email",conflict.owner)}
    </div>
    {conflict.review&&<p className="mt-2 text-xs text-amber-950" data-testid={`identity-review-provenance-${response.id}`}>
      {conflict.reviewedAt&&conflict.reviewedById
        ? <>Reviewed by {conflict.reviewedByName??`Admin #${conflict.reviewedById}`} on {formatReportDateTime(conflict.reviewedAt)}</>
        :"Reviewer and time unavailable for this earlier review."}
    </p>}
    {!conflict.canRelink&&<p className="mt-2 text-sm text-amber-900">{conflict.ambiguousOwners
      ?"Multiple contacts own this email. Resolve duplicate email records before relinking."
      :"The email owner is under a different client or has no account. Relinking is unavailable; correct the CRM/source records first."}</p>}
    {!conflict.canKeep&&<p className="mt-2 text-sm text-amber-900">Keeping the form account requires a source contact with the form’s exact phone number. Correct the source record first.</p>}
    <p className="mt-2 text-xs text-amber-900">Only this response link changes. Other responses, contacts, previous enrollments and sent messages stay where they are. Keeping the source contact blocks email routing for this response.</p>
    {user?.role==="admin"&&<div className="mt-3 flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!conflict.canKeep||save.isPending} onClick={()=>setChoice("keep")}>Keep form account and contact</Button>
      <Button size="sm" variant="outline" disabled={!conflict.canRelink||save.isPending} onClick={()=>setChoice("relink")}>Relink this response to email owner</Button>
    </div>}
    {user?.role==="admin"&&choice&&<div className="mt-3 rounded border border-amber-400 bg-white p-3 text-sm">
      <p>Confirm: {choice==="keep"?"keep this response with the form account and block email routing":"move only this response to the email owner’s account"}?</p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={save.isPending} onClick={()=>save.mutate({
          id:response.id,action:choice,email:conflict.email,ownerContactId:conflict.owner.id,
          sourceAccountId:conflict.sourceAccountId,sourceContactId:conflict.sourceContact?.id??null,
        },{
          onSuccess:()=>{setChoice(null);toast({title:"Identity review saved",description:"Existing enrollments and other responses were not changed."});},
          onError:error=>toast({title:"Could not save identity review",description:error.message,variant:"destructive"}),
        })}>{save.isPending?"Saving…":"Confirm review"}</Button>
        <Button size="sm" variant="ghost" onClick={()=>setChoice(null)} disabled={save.isPending}>Cancel</Button>
      </div>
    </div>}
  </div>;
}

function answerText(value:unknown):string {
  if(value===null||value===undefined)return "";
  if(typeof value==="string")return value;
  if(typeof value==="number"||typeof value==="boolean")return String(value);
  return JSON.stringify(value);
}

export function InboundResponseDialog({accountId,sourceId,onClose}:{accountId:number|null;sourceId?:number;onClose:()=>void}) {
  const [deleteTarget,setDeleteTarget]=useState<{id:number;name:string}|null>(null);
  const {data,isLoading,isError,error}=useInboundResponses(accountId,sourceId);
  const remove=useDeleteInboundResponse();
  const review=useReviewInboundAffinity();
  const setCategory=useSetInboundCategory();
  const {toast}=useToast();
  const {user}=useAuthContext();
  return <><Dialog open={accountId!==null} onOpenChange={open=>{if(!open)onClose();}}>
    <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Inbound responses · {data?.accountName??"Account"}</DialogTitle>
        <DialogDescription>Review imported answers and manually recorded details before confirming an interest. A category correction applies to the same selected interest on this account’s other responses. Existing enrollments are not undone.</DialogDescription>
      </DialogHeader>
      {isLoading&&<div className="flex items-center gap-2 p-6 text-sm"><Loader2 className="h-4 w-4 animate-spin"/>Loading responses…</div>}
      {isError&&<p className="p-4 text-sm text-rose-700" role="alert">{error?.message??"Could not load responses"}</p>}
      {data?.responses.length===0&&<p className="p-4 text-sm text-stone-600">No responses found for this account.</p>}
      {data?.hasMore&&<p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">Showing the most recent 500 responses. Older responses are not shown here.</p>}
      <div className="space-y-5">
        {data?.responses.map((response,index)=><section key={response.id} className="rounded-lg border border-stone-200 p-4" data-testid={`response-${response.id}`}>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-stone-900">Response {index+1}</h3>
            <Badge variant="outline">{response.classification}</Badge>
            <span className="text-xs text-stone-500">{response.fileName}</span>
             {response.fileName==="Manual entry"&&<Badge variant="outline">Entered manually</Badge>}
            <SubmissionDateEditor id={response.id} submittedAt={response.submittedAt} origin={response.submissionDateOrigin}/>
             {user?.role==="admin"&&<Button type="button" size="sm" variant="outline" className="ml-auto text-rose-700" data-testid={`delete-response-${response.id}`}
               onClick={()=>setDeleteTarget({id:response.id,name:`Response ${index+1} · ${response.fileName}`})}>
               <Trash2 className="mr-1 h-3.5 w-3.5"/>Delete this response
             </Button>}
          </div>
          <p className="mt-2 text-xs text-stone-600">Classification: {response.classificationReason}</p>
           <IdentityConflict key={`${response.id}-${response.identityConflict?.review??"pending"}`} response={response}/>
          <div className="mt-4 space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-stone-500">Product interests to verify</h4>
            {response.affinities.length===0&&<div className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
              <p>No product or service was selected in this response. Assign a category to move this response into Categorized. Its original answer will remain unchanged.</p>
              {user?.role==="admin"&&<div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold">Assign category</span>
                <Select value={response.missingCategory??"unassigned"}
                  onValueChange={category=>setCategory.mutate({id:response.id,selection:null,category:category==="unassigned"?null:category},{
                    onSuccess:()=>toast({title:"Category updated",description:"The cohort list has been refreshed. Already-routed enrollments are unchanged."}),
                    onError:err=>toast({title:"Could not assign category",description:err.message,variant:"destructive"}),
                  })} disabled={setCategory.isPending}>
                  <SelectTrigger className="h-9 w-full max-w-64 bg-white" aria-label={`Category for response ${index+1}`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Not Categorized</SelectItem>
                    {["IT Hardware","Business Collaboration","Security","Business Services"].map(category=>
                      <SelectItem value={category} key={category}>{category}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>}
            </div>}
            {response.affinities.map(affinity=><div key={affinity.selection} className="rounded-md border border-indigo-100 bg-indigo-50/50 p-3" data-testid={`affinity-${response.id}-${affinity.selection}`}>
              <div className="text-sm font-semibold text-stone-900">Selected: {affinity.selection}</div>
               <div className="text-xs text-stone-600">Product: {affinity.derivedProduct??affinity.selection} · Cohort: {affinity.categoryName}</div>
               {user?.role==="admin"&&<div className="mt-2 flex flex-wrap items-center gap-2">
                 <span className="text-xs text-stone-600">Correct cohort</span>
                 <Select value={affinity.categoryName==="Needs categorization"?"automatic":affinity.categoryName}
                   onValueChange={category=>setCategory.mutate({id:response.id,selection:affinity.selection,category:category==="automatic"?null:category},{
                     onSuccess:result=>toast({title:"Cohort updated",description:`Applied to ${result.updatedResponses} response${result.updatedResponses===1?"":"s"} with this interest. Existing enrollments are unchanged.`}),
                     onError:err=>toast({title:"Could not update cohort",description:err.message,variant:"destructive"}),
                   })} disabled={setCategory.isPending||affinity.review==="rejected"}>
                   <SelectTrigger className="h-8 w-full max-w-64 bg-white text-xs" aria-label={`Cohort for ${affinity.selection}`}><SelectValue /></SelectTrigger>
                   <SelectContent>
                     <SelectItem value="automatic">Automatic classification</SelectItem>
                     {["IT Hardware","Business Collaboration","Security","Business Services"].map(category=>
                       <SelectItem value={category} key={category}>{category}</SelectItem>)}
                   </SelectContent>
                 </Select>
                 {affinity.review==="rejected"&&<span className="text-xs text-amber-800">Confirm this interest before placing it in a cohort.</span>}
               </div>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant="outline">{affinity.review}</Badge>
                {user?.role==="admin"&&<Button size="sm" variant={affinity.review==="confirmed"?"default":"outline"} disabled={review.isPending} data-testid={`button-confirm-affinity-${response.id}`} onClick={()=>review.mutate({id:response.id,selection:affinity.selection,review:"confirmed"},{
                  onSuccess:()=>toast({title:"Interest confirmed"}),
                  onError:err=>toast({title:"Could not save review",description:err.message,variant:"destructive"}),
                })}>Accurate</Button>}
                {user?.role==="admin"&&<Button size="sm" variant={affinity.review==="rejected"?"destructive":"outline"} disabled={review.isPending} data-testid={`button-reject-affinity-${response.id}`} onClick={()=>review.mutate({id:response.id,selection:affinity.selection,review:"rejected"},{
                  onSuccess:()=>toast({title:"Interest marked inaccurate",description:"Removed from future product cohort routing. Existing enrollments are unchanged."}),
                  onError:err=>toast({title:"Could not save review",description:err.message,variant:"destructive"}),
                })}>Inaccurate</Button>}
              </div>
            </div>)}
          </div>
          <div className="mt-4 space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-stone-500">Original questions and answers</h4>
            {Object.entries(response.answers??{}).map(([question,value])=><div key={question} className="rounded-md border border-stone-200 bg-white p-3">
              <div className="text-xs font-semibold text-stone-600 break-words">{question}</div>
              <div className="mt-1 whitespace-pre-wrap break-words text-sm text-stone-900">{answerText(value)||"No answer"}</div>
            </div>)}
          </div>
        </section>)}
      </div>
    </DialogContent>
  </Dialog>
  <AlertDialog open={deleteTarget!==null} onOpenChange={open=>{if(!open&&!remove.isPending)setDeleteTarget(null);}}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete {deleteTarget?.name} permanently?</AlertDialogTitle>
        <AlertDialogDescription>The original answers and this response’s inbound routing record will be removed. The contact, account, other responses, and any already-sent messages or enrollments remain. This cannot be undone. The current Drive row will be ignored on later syncs, but editing a source row without a submission date may import it again.</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
        <AlertDialogAction disabled={remove.isPending} className="bg-rose-600 hover:bg-rose-700" onClick={event=>{
          event.preventDefault();
          if(!deleteTarget)return;
          remove.mutate(deleteTarget.id,{
            onSuccess:()=>{setDeleteTarget(null);toast({title:"Response deleted"});},
            onError:err=>toast({title:"Could not delete response",description:err.message,variant:"destructive"}),
          });
        }}>{remove.isPending?"Deleting…":"Delete response"}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog></>;
}