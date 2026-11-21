import {expect,it} from "vitest";
import {mergeContributionRecords} from "./contributions";
import type {HpBiRecord} from "./types";

it("does not add form evidence again when its counted response is present",()=>{
  const form:HpBiRecord={id:"form:9",accountId:1,contactId:2,kind:"other",
    occurredAt:"2026-12-10T08:00:00Z",category:null,product:null,horizonMonths:null,
    orderValue:null,currency:null,source:"journey form",sourceName:"Feedback",status:"form_submitted"};
  const response={...form,id:"form:9:response",externalEventId:"form_submission:9"};
  expect(mergeContributionRecords([response],[form])).toEqual([response]);
  expect(mergeContributionRecords([],[form])).toEqual([form]);
});
