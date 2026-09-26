import type { CheckResult } from "../check.js";
import type { FindingKind, Severity } from "../types.js";
import { SEVERITY } from "../findings.js";
import { TOOL } from "./common.js";
import { RULES } from "./rules.js";

const LEVEL: Record<Severity, "error" | "warning" | "note"> = { error: "error", warning: "warning", info: "note" };

export interface SarifOptions {
  /** Prefix added to file paths so they are relative to the repository root. */
  pathPrefix?: string;
}

/** SARIF 2.1.0 log for GitHub code scanning and other SARIF consumers. */
export function toSarif(result: CheckResult, options: SarifOptions = {}) {
  const prefix = options.pathPrefix ? options.pathPrefix.replace(/\/?$/, "/") : "";
  const kinds = Object.keys(RULES) as FindingKind[];
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: TOOL.name,
            version: TOOL.version,
            informationUri: TOOL.url,
            rules: kinds.map((kind) => ({
              id: kind,
              name: kind.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase()),
              shortDescription: { text: RULES[kind].title },
              fullDescription: { text: RULES[kind].description },
              helpUri: `${TOOL.url}/blob/main/docs/findings.md#${kind}`,
              defaultConfiguration: { level: LEVEL[SEVERITY[kind]] },
            })),
          },
        },
        results: result.findings.map((f) => ({
          ruleId: f.kind,
          ruleIndex: kinds.indexOf(f.kind),
          level: LEVEL[f.severity],
          message: { text: f.message },
          locations: f.file
            ? [
                {
                  physicalLocation: {
                    artifactLocation: { uri: prefix + f.file, uriBaseId: "%SRCROOT%" },
                    region: { startLine: f.line ?? 1, ...(f.endLine ? { endLine: f.endLine } : {}) },
                  },
                },
              ]
            : [],
          partialFingerprints: { "looseEnds/v1": f.id },
          properties: { target: f.target, evidence: f.evidence, blocking: result.failing.includes(f) },
          ...(f.suppressed ? { suppressions: [{ kind: "external", justification: f.suppressed.reason }] } : {}),
        })),
      },
    ],
  };
}

export function formatSarif(result: CheckResult, options: SarifOptions = {}): string {
  return JSON.stringify(toSarif(result, options), null, 2) + "\n";
}
