// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SaveContact from "./SaveContact";
import type { CommitteePerson } from "./api";
const mocks=vi.hoisted(()=>({mutate:vi.fn(),reset:vi.fn(),data:undefined as {contactId:number}|undefined,isPending:false,isError:false,error:new Error("Apollo request failed")}));
vi.mock("./api",()=>({useSaveCommitteeContact:()=>mocks}));
afterEach(()=>{cleanup();vi.clearAllMocks();mocks.data=undefined;mocks.isPending=false;mocks.isError=false;});
const person:CommitteePerson={id:"apollo:21",companyId:42,companyName:"Account",name:"Test Person",title:"IT Director",email:"test@example.invalid",phone:null,linkedin:null,location:"India",categories:[],source:"Apollo",engagementSources:[],engaged:false,sourcedAt:null};
it("reviews the account and no-outreach boundary before an explicit save",()=>{
  const {container}=render(<SaveContact person={person} clientId={9} canSave/>);
  expect(container.textContent).not.toMatch(/apollo/i);
  expect(mocks.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Add to database"}));
  expect(screen.getByText(/No message is sent/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Confirm add to database"}));
  expect(mocks.mutate).toHaveBeenCalledWith({clientId:9,companyId:42,prospectId:21,confirm:true});
});
it("hides write controls from viewers and supports cancellation",()=>{
  const {rerender}=render(<SaveContact person={person} clientId={9} canSave={false}/>);
  expect(screen.queryByRole("button")).toBeNull();
  rerender(<SaveContact person={person} clientId={9} canSave/>);
  fireEvent.click(screen.getByText("Add to database"));
  fireEvent.click(screen.getByText("Cancel"));
  expect(mocks.mutate).not.toHaveBeenCalled();
});
it("opens the saved database contact for routing and explains missing email",()=>{
  render(<SaveContact person={{...person,email:null,crmContactId:99}} clientId={9} canSave/>);
  expect(screen.getByRole("link").getAttribute("href")).toBe("/crm/contacts/99");
  expect(screen.getByText(/Add an email in the database/)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
it("shows failures without the provider name and disables double saves while pending",()=>{
  mocks.isError=true;
  const {rerender}=render(<SaveContact person={person} clientId={9} canSave/>);
  fireEvent.click(screen.getByText("Add to database"));
  expect(screen.getByRole("alert").textContent).toBe("contact discovery request failed");
  mocks.isPending=true;
  rerender(<SaveContact person={person} clientId={9} canSave/>);
  expect(screen.getByRole("button",{name:"Saving…"}).hasAttribute("disabled")).toBe(true);
});
