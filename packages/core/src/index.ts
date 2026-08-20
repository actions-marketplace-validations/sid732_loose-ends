export const VERSION = "0.1.0";

export * from "./types.js";
export {
  CONFIG_FILES,
  ConfigError,
  DEFAULT_EXCLUDE,
  DEFAULT_FAIL_ON,
  DEFAULT_INCLUDE,
  DEFAULT_TEST_PATTERNS,
  SOURCE_EXTENSIONS,
  defaultConfig,
  loadConfig,
  parseConfig,
} from "./config.js";
export { createMatcher, parseTarget, targetMatches, toRelative } from "./paths.js";
export type { Matcher } from "./paths.js";
export { discoverFiles } from "./discover.js";
export type { SourceFile } from "./discover.js";
export { MODULE_BODY, collectReferences, createSource, parseModule, scriptKindFor } from "./parse.js";
export type { Declaration, DeclarationKind, ImportBinding, ImportKind, ImportRecord, LocalExport, ModuleInfo } from "./parse.js";
export { Resolver, splitPackage } from "./resolve.js";
export type { Resolution } from "./resolve.js";
export { discoverPackages, flattenTarget, manifestEntries, readPackageJson, resolveExports } from "./workspace.js";
export type { PackageJson, WorkspacePackage } from "./workspace.js";
export { LivenessGraph, buildGraph, dependencyId, fileId, symbolId } from "./graph.js";
export type { BuildResult, EdgeKind, GraphEdge, GraphNode, NodeKind, UnresolvedImport } from "./graph.js";
export { DEFAULT_PROVIDERS, configRoots, discoverRoots, packageRoots, scriptTargets, testRoots } from "./roots.js";
export type { Root, RootContext, RootKind, RootProvider } from "./roots.js";
export {
  FRAMEWORK_PROVIDERS,
  NEXT_ROUTE_EXPORTS,
  detectFrameworks,
  nextRoots,
  serverlessRoots,
  storybookRoots,
  toolConfigRoots,
  viteRoots,
} from "./frameworks.js";
