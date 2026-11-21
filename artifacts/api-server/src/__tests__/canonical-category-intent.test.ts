import { describe,expect,it } from "vitest";
import { isStrongerIntentCandidate,selectCanonicalCategoryIntent } from "../lib/canonicalCategoryIntent";

describe("canonical category intent",()=>{
  it("promotes explicit Warm questionnaire intent above a weaker Cold hiring inference",()=>{
    const hiring={categoryName:"Virtual Collaboration",score:33,tier:"cold",source:"research_propensity"};
    const questionnaire={categoryName:"Virtual Collaboration",score:56,tier:"warm",source:"questionnaire"};
    expect(isStrongerIntentCandidate(questionnaire,hiring)).toBe(true);
    expect(selectCanonicalCategoryIntent([hiring,questionnaire])).toEqual(questionnaire);
  });

  it("does not let a higher numeric Cold score displace a validated Warm conclusion",()=>{
    const warm={categoryName:"IT Hardware",score:42,tier:"warm",source:"questionnaire"};
    const cold={categoryName:"IT Hardware",score:68,tier:"cold",source:"approved_signals"};
    expect(selectCanonicalCategoryIntent([cold,warm])).toEqual(warm);
  });

  it("keeps an explicit no-plans response above a warmer inferred signal",()=>{
    const inferred={categoryName:"Virtual Collaboration",score:62,tier:"warm",source:"approved_signals"};
    const declaredNoPlans={categoryName:"Security Services",score:18,tier:"cold",source:"questionnaire"};
    expect(selectCanonicalCategoryIntent([inferred,declaredNoPlans])).toEqual(declaredNoPlans);
  });

  it("treats lead forms as explicit first-party intent",()=>{
    const research={categoryName:"IT Hardware",score:72,tier:"warm",source:"research_propensity"};
    const leadForm={categoryName:"Managed Security",score:30,tier:"cold",source:"lead_form"};
    expect(selectCanonicalCategoryIntent([research,leadForm])).toEqual(leadForm);
  });
});