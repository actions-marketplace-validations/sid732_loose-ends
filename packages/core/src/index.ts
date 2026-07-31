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
