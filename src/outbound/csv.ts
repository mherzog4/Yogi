import type { Prospect, ProspectStatus } from "./model.js";

export interface ProspectImportRejection {
  readonly row: number;
  readonly reason:
    | "missing-email"
    | "invalid-email"
    | "missing-company"
    | "missing-source"
    | "invalid-status"
    | "duplicate-email";
}

export interface ProspectImportResult {
  readonly prospects: readonly Prospect[];
  readonly rejections: readonly ProspectImportRejection[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES = new Set<ProspectStatus>([
  "prospect",
  "contacted",
  "replied",
  "unsubscribed",
  "bounced",
]);

const parseCsvRows = (input: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    const next = input[index + 1];

    if (quoted) {
      if (character === '"' && next === '"') {
        field += '"';
        index++;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

const optional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const parseProspectsCsv = (input: string): ProspectImportResult => {
  const rows = parseCsvRows(input);
  const header = rows.shift()?.map((value) => value.trim().toLowerCase());
  if (!header) throw new Error("CSV must include a header row");

  const index = new Map(header.map((name, position) => [name, position]));
  for (const required of ["email", "company", "source"]) {
    if (!index.has(required)) {
      throw new Error(`CSV is missing required column: ${required}`);
    }
  }

  const value = (row: string[], name: string): string | undefined => {
    const position = index.get(name);
    return position === undefined ? undefined : row[position];
  };
  const prospects: Prospect[] = [];
  const rejections: ProspectImportRejection[] = [];
  const seen = new Set<string>();

  for (const [offset, row] of rows.entries()) {
    const rowNumber = offset + 2;
    if (row.every((item) => item.trim() === "")) continue;

    const email = value(row, "email")?.trim().toLowerCase();
    const company = value(row, "company")?.trim();
    const source = value(row, "source")?.trim();
    const rawStatus = value(row, "status")?.trim().toLowerCase() || "prospect";

    if (!email) {
      rejections.push({ row: rowNumber, reason: "missing-email" });
    } else if (!EMAIL_PATTERN.test(email)) {
      rejections.push({ row: rowNumber, reason: "invalid-email" });
    } else if (!company) {
      rejections.push({ row: rowNumber, reason: "missing-company" });
    } else if (!source) {
      rejections.push({ row: rowNumber, reason: "missing-source" });
    } else if (!STATUSES.has(rawStatus as ProspectStatus)) {
      rejections.push({ row: rowNumber, reason: "invalid-status" });
    } else if (seen.has(email)) {
      rejections.push({ row: rowNumber, reason: "duplicate-email" });
    } else {
      seen.add(email);
      prospects.push({
        email,
        domain: email.split("@")[1]!,
        company,
        source,
        status: rawStatus as ProspectStatus,
        ...(optional(value(row, "first_name"))
          ? { firstName: optional(value(row, "first_name"))! }
          : {}),
        ...(optional(value(row, "last_name"))
          ? { lastName: optional(value(row, "last_name"))! }
          : {}),
        ...(optional(value(row, "role"))
          ? { role: optional(value(row, "role"))! }
          : {}),
        ...(optional(value(row, "source_url"))
          ? { sourceUrl: optional(value(row, "source_url"))! }
          : {}),
        ...(optional(value(row, "personalization"))
          ? { personalization: optional(value(row, "personalization"))! }
          : {}),
      });
    }
  }

  return { prospects, rejections };
};
