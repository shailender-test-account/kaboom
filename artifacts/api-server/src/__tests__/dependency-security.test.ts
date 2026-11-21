import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parse } from "csv-parse/sync";
import nodemailer from "nodemailer";
import AdmZip from "adm-zip";

// Exercise the actual transitive dependency used by the proxy, not a separate
// test-only copy. pnpm applies the patch to every consumer of braces@3.0.3.
const require = createRequire(import.meta.url);
const proxyRequire = createRequire(require.resolve("http-proxy-middleware"));
const micromatchRequire = createRequire(proxyRequire.resolve("micromatch"));
const braces = micromatchRequire("braces");
const workspaceRoot = new URL("../../../../", import.meta.url);
const browserRequire = createRequire(new URL("artifacts/playforge/package.json", workspaceRoot));
const browserXLSX = browserRequire("xlsx") as typeof XLSX;

describe("dependency security compatibility", () => {
  it("keeps both spreadsheet consumers on the vendor-fixed distribution", () => {
    const tarball = "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz";
    for (const artifact of ["api-server", "playforge"]) {
      const manifest = JSON.parse(readFileSync(
        new URL(`artifacts/${artifact}/package.json`, workspaceRoot), "utf8",
      ));
      expect({ ...manifest.dependencies, ...manifest.devDependencies }.xlsx).toBe(tarball);
    }
    // The tarball pin alone does not protect against changed CDN contents.
    const lockfile = readFileSync(new URL("pnpm-lock.yaml", workspaceRoot), "utf8");
    expect(lockfile).toContain(
      `resolution: {integrity: sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==, tarball: ${tarball}}`,
    );
    expect(browserXLSX.version).toBe(XLSX.version);
  });

  it("preserves common brace compilation and expansion", () => {
    expect(braces("src/{api,web}/*.ts")).toEqual(["src/(api|web)/*.ts"]);
    expect(braces.expand("file-{1..3}.{csv,xlsx}")).toEqual([
      "file-1.csv", "file-1.xlsx", "file-2.csv", "file-2.xlsx",
      "file-3.csv", "file-3.xlsx",
    ]);
    expect(braces.stringify(braces.parse("a/{b,{c,d}}/e"))).toBe("a/{b,{c,d}}/e");
  });

  it.each(["compile", "expand", "parse", "stringify"])(
    "rejects deeply nested brace patterns in %s before stack exhaustion",
    (method) => {
      // Stay below the pre-existing 10,000-character cap to exercise the new
      // nesting guard rather than the unrelated length guard.
      const input = "{".repeat(4_000) + "a,b" + "}".repeat(4_000);
      expect(() => braces[method](input)).toThrow(SyntaxError);
      expect(() => braces[method](input)).toThrow(/maximum nesting depth/);
    },
  );

  it.each(["compile", "expand", "parse", "stringify"])(
    "also bounds parenthesis nesting in %s",
    (method) => {
      expect(() => braces[method]("(".repeat(4_000) + "x" + ")".repeat(4_000)))
        .toThrow(/maximum nesting depth/);
    },
  );

  it("protects the default API even when callers raise the character limit", () => {
    expect(() => braces("{".repeat(4_000) + "a,b" + "}".repeat(4_000), { maxLength: 100_000 }))
      .toThrow(/maximum nesting depth/);
  });

  it("still accepts reasonable nested patterns", () => {
    const input = "{".repeat(32) + "a,b" + "}".repeat(32);
    // Single-element enclosing braces are literal, not expansion groups.
    expect(braces.expand(input)).toEqual(
      ["a", "b"].map(value => "{".repeat(31) + value + "}".repeat(31)),
    );
    expect(braces.stringify(braces.parse(input))).toBe(input);
  });

  it.each(["compile", "expand", "stringify"])(
    "bounds externally supplied ASTs in %s",
    (method) => {
      const root: any = { type: "root", nodes: [] };
      let current = root;
      for (let i = 0; i < 10_000; i++) {
        const child = { type: "brace", nodes: [], parent: current };
        current.nodes.push(child);
        current = child;
      }
      expect(() => braces[method](root)).toThrow(/maximum nesting depth/);
    },
  );

  it.each([["server", XLSX], ["browser", browserXLSX]] as const)(
    "round-trips maintained SheetJS workbooks including dates and Unicode (%s)",
    (_consumer, sheetjs) => {
      expect(sheetjs.version).toBe("0.20.3");
      const rows = [{ Account: "München भारत", Units: 12, Date: new Date("2026-10-14T00:00:00Z") }];
      const book = sheetjs.utils.book_new();
      sheetjs.utils.book_append_sheet(book, sheetjs.utils.json_to_sheet(rows), "Accounts");
      const bytes = sheetjs.write(book, { type: "buffer", bookType: "xlsx" });
      const read = sheetjs.read(bytes, { type: "buffer", cellDates: true });
      expect(sheetjs.utils.sheet_to_json(read.Sheets.Accounts)).toEqual(rows);
    },
  );

  it("preserves CSV quoting and column inference after the major update", () => {
    expect(parse('Account,Notes\r\nAcme,"one, two"\r\n', { columns: true }))
      .toEqual([{ Account: "Acme", Notes: "one, two" }]);
  });

  it("builds MIME mail without making a network request", async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const result = await transport.sendMail({
      from: "sender@example.com", to: "recipient@example.com",
      subject: "Security compatibility", text: "Hello",
    });
    expect(result.message.toString()).toContain("Subject: Security compatibility");
  });

  it("preserves ZIP round trips", () => {
    const zip = new AdmZip();
    zip.addFile("data.txt", Buffer.from("safe contents"));
    expect(new AdmZip(zip.toBuffer()).readAsText("data.txt")).toBe("safe contents");
  });
});
