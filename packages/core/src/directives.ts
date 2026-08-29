import { fileId, symbolId, type GraphEdge } from "./graph.js";
import type { Analysis } from "./liveness.js";
import { createMatcher, parseTarget } from "./paths.js";
import type { RootProvider } from "./roots.js";
import type { FindingKind, Suppression } from "./types.js";

/** A suppression together with where it was declared. */
export interface SuppressionRecord extends Suppression {
  origin: string;
}

/** A dormant marker that could not be applied as written. */
export interface DirectiveProblem {
  file: string;
  line?: number;
  message: string;
  target: string;
}

/** `// loose-ends: entry` and `// loose-ends-file: entry` comments become production roots. */
export const directiveRoots: RootProvider = {
  name: "directives",
  discover(ctx) {
    for (const [path, info] of ctx.build.graph.modules) {
      for (const d of info.directives) {
        if (d.action !== "entry") continue;
        const reason = `marked as an entry point at ${path}:${d.line}`;
        if (d.scope === "file") ctx.addFile(path, { kind: "production", source: "directive", reason }, "all");
        else for (const name of d.symbols) ctx.add({ node: symbolId(path, name), kind: "production", source: "directive", reason });
      }
    }
  },
};

/** Inline `ignore` directives as suppressions. Missing reasons are kept so they can be reported. */
export function inlineSuppressions(analysis: Analysis): SuppressionRecord[] {
  const out: SuppressionRecord[] = [];
  for (const [path, info] of analysis.graph.modules) {
    for (const d of info.directives) {
      if (d.action !== "ignore") continue;
      const origin = `${path}:${d.line}`;
      const kind = d.kind as FindingKind | undefined;
      if (d.scope === "file") out.push({ target: path, reason: d.reason, kind, origin });
      else for (const name of d.symbols) out.push({ target: `${path}#${name}`, reason: d.reason, kind, origin });
    }
  }
  return out;
}

export function allSuppressions(analysis: Analysis): SuppressionRecord[] {
  const fromConfig = analysis.config.suppressions.map((s) => ({ ...s, origin: analysis.config.source ?? "config" }));
  return [...fromConfig, ...inlineSuppressions(analysis)];
}

/**
 * Mark unreachable code covered by dormant rules or directives as dormant,
 * along with everything reachable only through it.
 */
export function applyDormant(analysis: Analysis): DirectiveProblem[] {
  const problems: DirectiveProblem[] = [];
  const seeds: Array<{ id: string; note: string }> = [];
  const graph = analysis.graph;

  for (const rule of analysis.config.dormant) {
    const { file, symbol } = parseTarget(rule.target);
    const match = createMatcher([file]);
    let hit = false;
    for (const path of graph.modules.keys()) {
      if (!match(path)) continue;
      const id = symbol ? symbolId(path, symbol) : fileId(path);
      if (!graph.nodes.has(id)) continue;
      hit = true;
      seeds.push({ id, note: `dormant: ${rule.reason} (${analysis.config.source ?? "config"})` });
      if (!symbol) for (const sym of graph.symbolsOf(path)) seeds.push({ id: sym.id, note: `dormant: ${rule.reason}` });
    }
    if (!hit) problems.push({ file: analysis.config.source ?? "config", target: rule.target, message: `dormant rule "${rule.target}" matches no code` });
  }

  for (const [path, info] of graph.modules) {
    for (const d of info.directives) {
      if (d.action !== "dormant") continue;
      if (!d.reason) {
        problems.push({ file: path, line: d.line, target: path, message: "dormant directive needs a reason" });
        continue;
      }
      const note = `dormant: ${d.reason} (${path}:${d.line})`;
      if (d.scope === "file") {
        seeds.push({ id: fileId(path), note });
        for (const sym of graph.symbolsOf(path)) seeds.push({ id: sym.id, note });
      } else {
        for (const name of d.symbols) seeds.push({ id: symbolId(path, name), note });
      }
    }
  }

  const queue: Array<{ id: string; note: string; via?: GraphEdge }> = [];
  for (const seed of seeds) queue.push(seed);
  for (let i = 0; i < queue.length; i++) {
    const { id, note, via } = queue[i]!;
    const state = analysis.states.get(id);
    if (!state || (state.liveness !== "orphaned" && state.liveness !== "test-only")) continue;
    analysis.states.set(id, { liveness: "dormant", note, via, root: state.root });
    for (const edge of graph.out(id)) {
      if (edge.kind === "contains") continue;
      queue.push({ id: edge.to, note: `only used by dormant code (${note.replace(/^dormant: /, "")})`, via: edge });
    }
  }
  return problems;
}
