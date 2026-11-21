import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { useAddManualInboundAccount, useUpdateManualInboundAccount } from "@workspace/api-client-react";
import { useIntentScopeOptions } from "@/hooks/use-intent";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Form } from "@/components/ui/form";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Fields={
  clientId:string;name:string;domain:string;industry:string;
  contactName:string;contactEmail:string;contactPhone:string;designation:string;city:string;
  productId:string;categoryName:string;purchaseTimeframeMonths:string;
  formType:"lead_form"|"event_feedback";eventName:string;eventDate:string;formFilledDate:string;
};

const emptyFields:Fields={
  clientId:"",name:"",domain:"",industry:"",contactName:"",contactEmail:"",contactPhone:"",
  designation:"",city:"",productId:"",categoryName:"",purchaseTimeframeMonths:"",
  formType:"lead_form",eventName:"",eventDate:"",formFilledDate:"",
};

export function AddInboundAccountDialog({open,onClose,onCreated,clientId,account}:{
  open:boolean;onClose:()=>void;onCreated:(name:string)=>void;clientId?:number;
  account?:{account_id:number;client_id:number;name:string;domain?:string|null;industry?:string|null;
    manual_details?:{contactName:string;contactEmail:string;contactPhone?:string;designation?:string;city?:string;
      productId:number;categoryName:string;purchaseTimeframeMonths:number|null;
      formType:"lead_form"|"event_feedback";eventName?:string;eventDate?:string;formFilledDate?:string}|null}|null;
}){
  const form=useForm<Fields>({defaultValues:{...emptyFields,clientId:clientId?String(clientId):""}});
  useEffect(()=>{
    if(open)form.reset({...emptyFields,clientId:account?String(account.client_id):clientId?String(clientId):"",
      name:account?.name??"",domain:account?.domain??"",industry:account?.industry??"",
      ...account?.manual_details,
      productId:account?.manual_details?.productId?String(account.manual_details.productId):"",
      purchaseTimeframeMonths:account?.manual_details?.purchaseTimeframeMonths==null?"":String(account.manual_details.purchaseTimeframeMonths),
    });
  },[open,account,clientId]);
  const {data:options,isLoading}=useIntentScopeOptions(undefined,open);
  const source=form.watch("formType");
  const selectedCategory=form.watch("categoryName");
  const selectedProductId=form.watch("productId");
  const matchingProducts=options?.products.filter(product=>product.active&&product.inboundCategoryName===selectedCategory)??[];
  const queryClient=useQueryClient();
  const add=useAddManualInboundAccount({mutation:{onSuccess:()=>{
    queryClient.invalidateQueries({queryKey:["intent","inbound"]});
    queryClient.invalidateQueries({queryKey:["intent","scope-options"]});
    queryClient.invalidateQueries({queryKey:["companies"]});
  }}});
  const update=useUpdateManualInboundAccount({mutation:{onSuccess:()=>{
    queryClient.invalidateQueries({queryKey:["intent","inbound"]});
    queryClient.invalidateQueries({queryKey:["intent","scope-options"]});
    queryClient.invalidateQueries({queryKey:["companies"]});
  }}});
  const pending=add.isPending||update.isPending;
  const {toast}=useToast();
  const close=()=>{
    onClose();
  };
  const submit=form.handleSubmit(values=>{
    const data={
      clientId:Number(values.clientId),name:values.name.trim(),
      domain:values.domain.trim(),industry:values.industry.trim(),
      contactName:values.contactName.trim(),contactEmail:values.contactEmail.trim(),
      contactPhone:values.contactPhone.trim(),designation:values.designation.trim(),city:values.city.trim(),
      productId:Number(values.productId),categoryName:values.categoryName as "IT Hardware"|"Business Collaboration"|"Security"|"Business Services",
      purchaseTimeframeMonths:values.purchaseTimeframeMonths===""?null:Number(values.purchaseTimeframeMonths) as 0|3|6|12|24,
      formType:values.formType,
      ...(values.formType==="event_feedback"
        ?{eventName:values.eventName.trim(),eventDate:values.eventDate}
        :{formFilledDate:values.formFilledDate}),
    };
    const callbacks={
      onSuccess:(saved:{id:number;name:string})=>{
        toast({title:accountMode?"Account updated":"Account added",description:"The response and its intent status have been saved."});
        close();onCreated(saved.name);
      },
      onError:(error:Error)=>toast({title:accountMode?"Could not update account":"Could not add account",description:error.message,variant:"destructive" as const}),
    };
    if(account)update.mutate({accountId:account.account_id,data},callbacks);
    else add.mutate({data},callbacks);
  });
  const accountMode=!!account;
  return <Dialog open={open} onOpenChange={value=>{if(!value&&!pending)close();}}>
    <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{accountMode?"Edit manual account":"Add account manually"}</DialogTitle>
        <DialogDescription>{accountMode?"Edit the account and its manually entered response. Changes to the account are visible in the CRM.":"Record a lead form or event response manually. Its selected product and purchase timeframe will determine the inbound status."}</DialogDescription>
      </DialogHeader>
      <Form {...form}>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="manual-inbound-client">Client *</Label>
            <Controller name="clientId" control={form.control} rules={{required:"Choose a client"}}
              render={({field})=><Select value={field.value} onValueChange={field.onChange} disabled={pending||isLoading}>
                <SelectTrigger id="manual-inbound-client" data-testid="select-manual-inbound-client"><SelectValue placeholder={isLoading?"Loading clients…":"Choose client"}/></SelectTrigger>
                <SelectContent>{options?.clients.map(client=><SelectItem key={client.id} value={String(client.id)}>{client.name}</SelectItem>)}</SelectContent>
              </Select>}/>
            {!isLoading&&!options?.clients.length&&<p className="text-xs text-slate-500">Add a client in Settings before creating an account.</p>}
            {form.formState.errors.clientId&&<p role="alert" className="text-xs text-rose-600">{form.formState.errors.clientId.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-inbound-name">Account name *</Label>
            <Input id="manual-inbound-name" data-testid="input-manual-inbound-name" maxLength={200} disabled={pending}
              {...form.register("name",{required:"Enter an account name",validate:value=>value.trim().length>=2||"Use at least 2 characters"})}/>
            {form.formState.errors.name&&<p role="alert" className="text-xs text-rose-600">{form.formState.errors.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-inbound-domain">Domain (optional)</Label>
            <Input id="manual-inbound-domain" data-testid="input-manual-inbound-domain" placeholder="example.com" maxLength={253} disabled={pending} {...form.register("domain")}/>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-inbound-industry">Industry (optional)</Label>
            <Input id="manual-inbound-industry" data-testid="input-manual-inbound-industry" maxLength={120} disabled={pending} {...form.register("industry")}/>
          </div>
          <div className="border-t pt-4">
            <h3 className="text-sm font-semibold">Contact details</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="manual-contact-name">Contact name *</Label>
                <Input id="manual-contact-name" maxLength={200} disabled={pending} {...form.register("contactName",{required:"Enter a contact name"})}/>
                {form.formState.errors.contactName&&<p role="alert" className="text-xs text-rose-600">{form.formState.errors.contactName.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="manual-contact-email">Email *</Label>
                <Input id="manual-contact-email" type="email" maxLength={254} disabled={pending} {...form.register("contactEmail",{required:"Enter a contact email",pattern:{value:/^[^\s@]+@[^\s@]+\.[^\s@]+$/,message:"Enter a valid email"}})}/>
                {form.formState.errors.contactEmail&&<p role="alert" className="text-xs text-rose-600">{form.formState.errors.contactEmail.message}</p>}
              </div>
              <div className="space-y-1.5"><Label htmlFor="manual-contact-phone">Phone (optional)</Label><Input id="manual-contact-phone" type="tel" maxLength={50} disabled={pending} {...form.register("contactPhone")}/></div>
              <div className="space-y-1.5"><Label htmlFor="manual-contact-title">Designation (optional)</Label><Input id="manual-contact-title" maxLength={120} disabled={pending} {...form.register("designation")}/></div>
              <div className="space-y-1.5"><Label htmlFor="manual-contact-city">City (optional)</Label><Input id="manual-contact-city" maxLength={120} disabled={pending} {...form.register("city")}/></div>
            </div>
          </div>
          <div className="border-t pt-4">
            <h3 className="text-sm font-semibold">Interest and source</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="manual-category">Product category *</Label>
                <Controller name="categoryName" control={form.control} rules={{required:"Choose a category"}} render={({field})=>
                   <Select value={field.value} onValueChange={value=>{
                     if(field.value!==value)form.setValue("productId","",{shouldValidate:form.formState.isSubmitted});
                     field.onChange(value);
                   }} disabled={pending||isLoading}>
                    <SelectTrigger id="manual-category"><SelectValue placeholder="Choose category"/></SelectTrigger>
                    <SelectContent>{options?.categoryNames?.map(category=><SelectItem key={category} value={category}>{category}</SelectItem>)}</SelectContent>
                  </Select>}/>
                {form.formState.errors.categoryName&&<p role="alert" className="text-xs text-rose-600">{form.formState.errors.categoryName.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="manual-product">Product interest *</Label>
                 <Controller name="productId" control={form.control} rules={{
                   required:"Choose a product",
                   validate:value=>matchingProducts.some(product=>String(product.id)===value)||"Choose a product in the selected category",
                 }} render={({field})=>
                   <Select value={matchingProducts.some(product=>String(product.id)===field.value)?field.value:""}
                     onValueChange={field.onChange} disabled={pending||isLoading||!selectedCategory||matchingProducts.length===0}>
                     <SelectTrigger id="manual-product"><SelectValue placeholder={selectedCategory?"Choose product":"Choose category first"}/></SelectTrigger>
                     <SelectContent>{matchingProducts.map(product=><SelectItem key={product.id} value={String(product.id)}>{product.name}</SelectItem>)}</SelectContent>
                  </Select>}/>
                 {selectedCategory&&!isLoading&&matchingProducts.length===0&&<p className="text-xs text-slate-500">No catalog products match this GTM OS category. Update the category matching rules or catalog before adding this response.</p>}
                 {selectedProductId&&options&&!matchingProducts.some(product=>String(product.id)===selectedProductId)&&<p className="text-xs text-amber-700">The saved product does not match this category. Choose a matching product.</p>}
                {form.formState.errors.productId&&<p role="alert" className="text-xs text-rose-600">{form.formState.errors.productId.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="manual-timeframe">Purchase timeframe</Label>
                <Controller name="purchaseTimeframeMonths" control={form.control} render={({field})=>
                  <Select value={field.value||"unspecified"} onValueChange={value=>field.onChange(value==="unspecified"?"":value)} disabled={pending}>
                    <SelectTrigger id="manual-timeframe"><SelectValue placeholder="Choose timeframe"/></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unspecified">Not specified</SelectItem>
                      <SelectItem value="0">Immediate</SelectItem>
                      <SelectItem value="3">Within 3 months</SelectItem>
                      <SelectItem value="6">Within 6 months</SelectItem>
                      <SelectItem value="12">Within 12 months</SelectItem>
                      <SelectItem value="24">More than 12 months</SelectItem>
                    </SelectContent>
                  </Select>}/>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="manual-source">Source *</Label>
                <Controller name="formType" control={form.control} rules={{required:"Choose a source"}} render={({field})=>
                  <Select value={field.value} onValueChange={field.onChange} disabled={pending}>
                    <SelectTrigger id="manual-source"><SelectValue/></SelectTrigger>
                    <SelectContent><SelectItem value="lead_form">Lead form</SelectItem><SelectItem value="event_feedback">Event Feedback</SelectItem></SelectContent>
                  </Select>}/>
              </div>
              {source==="event_feedback"?<>
                <div className="space-y-1.5"><Label htmlFor="manual-event-name">Event name *</Label>
                  <Input id="manual-event-name" maxLength={200} disabled={pending} {...form.register("eventName",{validate:value=>source!=="event_feedback"||!!value.trim()||"Enter the event name"})}/>
                  {form.formState.errors.eventName&&<p role="alert" className="text-xs text-rose-600">{form.formState.errors.eventName.message}</p>}
                </div>
                <div className="space-y-1.5"><Label htmlFor="manual-event-date">Event date *</Label>
                  <Input id="manual-event-date" type="date" disabled={pending} {...form.register("eventDate",{validate:value=>source!=="event_feedback"||!!value||"Choose the event date"})}/>
                  {form.formState.errors.eventDate&&<p role="alert" className="text-xs text-rose-600">{form.formState.errors.eventDate.message}</p>}
                </div>
              </>:<div className="space-y-1.5"><Label htmlFor="manual-form-date">Date form was filled *</Label>
                <Input id="manual-form-date" type="date" disabled={pending} {...form.register("formFilledDate",{validate:value=>source!=="lead_form"||!!value||"Choose the form date"})}/>
                {form.formState.errors.formFilledDate&&<p role="alert" className="text-xs text-rose-600">{form.formState.errors.formFilledDate.message}</p>}
              </div>}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={pending}>Cancel</Button>
            <Button type="submit" data-testid="button-save-manual-inbound" disabled={pending||isLoading||!options?.clients.length}>{pending?"Saving…":accountMode?"Save changes":"Add account"}</Button>
          </DialogFooter>
        </form>
      </Form>
    </DialogContent>
  </Dialog>;
}