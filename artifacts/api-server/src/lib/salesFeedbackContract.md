# Sales feedback API contract

All endpoints credentialed under `/api/sales-feedback`. Read/write access uses `gtm`; reviews require actual admin role. Existing app routes and API base path conventions apply.

- GET `/options?clientId=&search=&accountId=&contactId=` → `{clients:[{id,name}],accounts:[{id,name,clientId}],contacts:[{id,name,companyId,clientId,email}],products:[{id,name}],googleDriveConnected:boolean}`. Search narrows account/contact results, max 50 each. Target IDs resolve client and include the exact selected record; invalid/foreign targets fail rather than falling back to tenant-wide choices.
- GET `/` query optional `clientId,accountId,contactId,parentKey,type,status,page,pageSize`. Parent key requires client ID. Response `{items,total,page,pageSize}`.
- POST `/` body `{clientId,accountId?,contactId?,type,occurredAt?,repName,feedback,product?,timingMonths?,proposedTemperature?,nextAction?}` → entry (201). Types `telesales|sales_rep`. Proposed temperature `Hot|Warm|Cold` optional.
- POST `/:id/review` body `{decision:'approve'|'reject',accountId?,contactId?,note,applyQualification:boolean,product?,timingMonths?,occurredAt?}` → entry. Explicit identity must resolve within source client. Applying qualification requires a matched contact, exact configured active product name, timingMonths >= 0, and a verified nonfuture interaction date. Approval can affect HP weighted account qualification and approved journey-only routing; no automatic sequence sends and no GTM lead/form creation. Review note required. History-only approval does not affect scores. Approved/rejected records can be re-reviewed with audit preserved. Imported revisions revoke older qualification for the same source record, never change prior raw fields. Superseded revisions cannot be approved.
- GET `/sources` → `{items:[source]}`.
- POST `/sources` body `{clientId,name,folderUrl,type,enabled,fieldMappings?:object}` → source.
- PUT `/sources/:id` same body → source. Once imported, client/folder/type immutable. Can change name, mappings, enabled.
- GET `/sources/:id/preview` → `{files:[{id,name}],sheets:[{name,headers:string[],rowCount:number}],errors:string[]}`.
- POST `/sources/:id/sync` (no body) → `{imported,duplicates,files,errors:string[],remainingFiles}`; enabled sources only.

Entry shape: `id,clientId,accountId:number|null,contactId:number|null,type,occurredAt:string|null,repName,feedback,product:string|null,timingMonths:number|null,proposedTemperature:string|null,reviewStatus:'pending'|'approved'|'rejected',reviewNote:string|null,approvedQualification:boolean,reviewedAt:string|null,reviewedBy:number|null,sourceId:number|null,fileName:string|null,sheetName:string|null,rowNumber:number|null,rawFields:object,createdAt:string,accountName:string|null,contactName:string|null,nextAction:string|null,sourceName:string|null,superseded:boolean,reviewHistory:object[]`.

Source shape: `id,clientId,name,folderUrl,type,enabled,fieldMappings:object,lastSyncedAt:string|null,lastError:string|null,hasImported:boolean`.

Field mappings are source heading → canonical key. Canonical keys: `companyName,contactName,email,phone,occurredAt,repName,feedback,product,timingMonths,proposedTemperature,nextAction,recordId`. Sample tracker automatically handles header on row 7 in Lead Tracker and row 5 in Call History. Blank/formula-only rows and Guide ignored. Lead Tracker can emit separate Telesales/Sales Rep entries from the two feedback columns, regardless of source default type. Call History Role selects the type where provided.

No secrets requested in UI. Reuse existing Drive connection. Manual entries do not require Drive. Account/contact history uses same list endpoint with exact target narrowing; do not show tenant-wide feedback when target is absent/unresolved.
