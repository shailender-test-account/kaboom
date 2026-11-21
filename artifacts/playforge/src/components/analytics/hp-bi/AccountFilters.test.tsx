// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AccountFilters from "./AccountFilters";
import { hpBiQuery } from "./api";

afterEach(cleanup);
it("groups account search, all three statuses and response source choices", () => {
  const onSearch = vi.fn(), onQualification = vi.fn(), onSource = vi.fn();
  render(<AccountFilters search="" qualification={undefined} gtmSource={undefined}
    onSearch={onSearch} onQualification={onQualification} onSource={onSource} onClear={vi.fn()} />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Adidas" } });
  expect(onSearch).toHaveBeenCalledWith("Adidas");
  const status = screen.getByLabelText("Filter accounts by qualification");
  expect([...status.querySelectorAll("option")].map(o => o.textContent)).toEqual(["All statuses", "Hot", "Warm", "Cold"]);
  for (const value of ["Hot", "Warm", "Cold", ""]) {
    fireEvent.change(status, { target: { value } });
    expect(onQualification).toHaveBeenLastCalledWith(value || undefined);
  }
  const source = screen.getByLabelText("Filter accounts by GTM source");
  expect([...source.querySelectorAll("option")].map(o => o.textContent)).toEqual(["All sources", "Lead Form", "Event Feedback Form"]);
  for (const value of ["lead_form", "event_feedback", ""]) {
    fireEvent.change(source, { target: { value } });
    expect(onSource).toHaveBeenLastCalledWith(value || undefined);
  }
  expect(screen.getByRole("button", { name: "Clear" }).hasAttribute("disabled")).toBe(true);
});

it("clears active controls and serializes combined filters without blank source values", () => {
  const clear = vi.fn();
  render(<AccountFilters search="Adidas" qualification="Hot" gtmSource="lead_form"
    onSearch={vi.fn()} onQualification={vi.fn()} onSource={vi.fn()} onClear={clear} />);
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(clear).toHaveBeenCalledOnce();
  const query = new URLSearchParams(hpBiQuery({ clientId: 9, search: "Adidas", qualification: "Hot", gtmSource: "lead_form", page: 1, pageSize: 5 }));
  expect(query.get("gtmSource")).toBe("lead_form");
  expect(query.get("qualification")).toBe("Hot");
  expect(query.get("search")).toBe("Adidas");
  expect(query.get("pageSize")).toBe("5");
  expect(new URLSearchParams(hpBiQuery({ clientId: 9 })).has("gtmSource")).toBe(false);
});

it("offers read-only coverage filters and serializes their intersections", () => {
  const onMonitoring = vi.fn();
  render(<AccountFilters search="" qualification={undefined} gtmSource={undefined} monitoring="never"
    onSearch={vi.fn()} onQualification={vi.fn()} onSource={vi.fn()} onMonitoring={onMonitoring} onClear={vi.fn()} />);
  const select = screen.getByLabelText("Filter accounts by monitoring coverage");
  for (const value of ["overdue", "never", ""]) {
    fireEvent.change(select, { target: { value } });
    expect(onMonitoring).toHaveBeenLastCalledWith(value || undefined);
  }
  expect(screen.getByText(/exactly 7 days is still fresh/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Clear" }).hasAttribute("disabled")).toBe(false);
  const query = new URLSearchParams(hpBiQuery({ clientId: 9, segment: "GCC", monitoring: "overdue", page: 1 }));
  expect(query.get("monitoring")).toBe("overdue");
  expect(query.get("segment")).toBe("GCC");
  expect(new URLSearchParams(hpBiQuery({ clientId: 9 })).has("monitoring")).toBe(false);
});
