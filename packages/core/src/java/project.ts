import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import fg from "fast-glob";
import { parseToml } from "../python/toml.js";

export interface JavaDependency {
  group: string;
  artifact: string;
  line?: number;
}

export interface JavaModule {
  /** Directory relative to the repository root ("" for the root). */
  dir: string;
  /** `pom.xml`, `build.gradle`, or `build.gradle.kts`, relative to the root. */
  buildFile: string;
  name: string;
  /** Compile-scope dependencies on artifacts outside this repository. */
  dependencies: JavaDependency[];
  /** The build applies an application plugin (Spring Boot, `application`, Android app, Quarkus, Micronaut) or packages a war. */
  app: boolean;
  /** Text of the build file, for class names in plugin configuration. */
  text: string;
}

const IGNORE = ["**/node_modules/**", "**/.git/**", "**/target/**", "**/build/**", "**/.gradle/**", "**/src/test/**"];
const APP_SIGNAL =
  /spring-boot-maven-plugin|org\.springframework\.boot['"]?\s*\)?\s*(version|$)|id\s*\(?\s*['"]org\.springframework\.boot['"]|apply plugin:\s*['"](application|org\.springframework\.boot|com\.android\.application)['"]|\bid\s*\(?\s*['"](application|com\.android\.application|io\.quarkus|io\.micronaut\.application)['"]|^\s*application\s*$|\bapplication\s*\{|<packaging>\s*war\s*<\/packaging>|quarkus-maven-plugin|micronaut-maven-plugin|<mainClass>|Main-Class|mainClass\s*[.=(]/m;
/** Gradle configurations whose dependencies production code must import. */
const GRADLE_CONFIGS = "implementation|api|compile";

export function discoverJavaModules(root: string): JavaModule[] {
  const files = fg.sync(["{,*/,*/*/,*/*/*/,*/*/*/*/}{pom.xml,build.gradle,build.gradle.kts}"], { cwd: root, ignore: IGNORE, onlyFiles: true }).sort();
  const catalog = readCatalog(root);
  const modules: JavaModule[] = [];
  const texts = new Map<string, string>();
  for (const buildFile of files) {
    try {
      texts.set(buildFile, readFileSync(join(root, buildFile), "utf8"));
    } catch {
      // Unreadable build file: skipped.
    }
  }
  // Scopes set in any <dependencyManagement> (usually the parent pom) apply where a module omits <scope>.
  const managed = new Map<string, string>();
  for (const [file, t] of texts) {
    if (!file.endsWith("pom.xml")) continue;
    for (const section of xmlBlocks(t, "<dependencyManagement>", "</dependencyManagement>")) {
      for (const m of xmlBlocks(section.inner, "<dependency>", "</dependency>")) {
        const tag = (name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(m.inner)?.[1];
        const scope = tag("scope");
        if (scope && tag("groupId") && tag("artifactId")) managed.set(`${tag("groupId")}:${tag("artifactId")}`, scope);
      }
    }
  }
  for (const buildFile of files) {
    const text = texts.get(buildFile);
    if (text === undefined) continue;
    const dir = posix.dirname(buildFile) === "." ? "" : posix.dirname(buildFile);
    const isMaven = buildFile.endsWith("pom.xml");
    const name = (isMaven ? /<artifactId>([^<]+)<\/artifactId>/.exec(stripMaven(text, false))?.[1] : undefined) ?? (dir ? posix.basename(dir) : "");
    const dependencies = isMaven ? mavenDependencies(text, managed) : gradleDependencies(text, catalog);
    const hasManifest = existsSync(join(root, dir, "src/main/AndroidManifest.xml"));
    modules.push({ dir, buildFile, name, dependencies, app: APP_SIGNAL.test(text) || (hasManifest && /com\.android\.application/.test(text)), text });
  }
  // Dependencies on other modules of the same build are not external.
  const internal = new Set(modules.map((m) => m.name));
  for (const m of modules) m.dependencies = m.dependencies.filter((d) => !internal.has(d.artifact) && !d.group.includes("${"));
  return modules;
}

interface XmlBlock {
  index: number;
  end: number;
  inner: string;
}

/** Each `open ... close` span, nearest close first. A linear scan: lazy regexes backtrack on many unclosed tags. */
function xmlBlocks(text: string, open: string, close: string): XmlBlock[] {
  const out: XmlBlock[] = [];
  let i = 0;
  for (;;) {
    const start = text.indexOf(open, i);
    if (start === -1) break;
    const stop = text.indexOf(close, start + open.length);
    if (stop === -1) break;
    out.push({ index: start, end: stop + close.length, inner: text.slice(start + open.length, stop) });
    i = stop + close.length;
  }
  return out;
}

/** Replace spans with spaces, keeping line breaks so line numbers hold. */
function blankBlocks(text: string, open: string, close: string, first = false): string {
  let out = "";
  let i = 0;
  for (const b of xmlBlocks(text, open, close)) {
    out += text.slice(i, b.index) + text.slice(b.index, b.end).replace(/[^\n]/g, " ");
    i = b.end;
    if (first) break;
  }
  return out + text.slice(i);
}

function stripMaven(text: string, dropSections = true): string {
  let out = blankBlocks(text, "<!--", "-->");
  // The parent's coordinates come first; drop them so the module's own artifactId is found.
  out = blankBlocks(out, "<parent>", "</parent>", true);
  if (dropSections) {
    for (const section of ["dependencyManagement", "build", "pluginRepositories", "reporting"]) {
      out = blankBlocks(out, `<${section}>`, `</${section}>`);
    }
  }
  return out;
}

/** Compile-scope `<dependency>` entries outside `<dependencyManagement>` and `<build>`. */
export function mavenDependencies(text: string, managed: Map<string, string> = new Map()): JavaDependency[] {
  const body = stripMaven(text);
  const out: JavaDependency[] = [];
  for (const m of xmlBlocks(body, "<dependency>", "</dependency>")) {
    const block = m.inner;
    const tag = (name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(block)?.[1];
    const group = tag("groupId");
    const artifact = tag("artifactId");
    const scope = tag("scope") ?? (group && artifact ? managed.get(`${group}:${artifact}`) : undefined) ?? "compile";
    if (!group || !artifact || scope !== "compile" || tag("type") === "pom" || tag("optional") === "true") continue;
    const line = body.slice(0, m.index + body.slice(m.index, m.end).indexOf("<artifactId>")).split("\n").length;
    out.push({ group, artifact, line });
  }
  return out;
}

/** `implementation "g:a:v"`, `api(group = "g", name = "a")`, and `implementation(libs.some.alias)`. */
export function gradleDependencies(text: string, catalog: Map<string, { group: string; artifact: string }> = new Map()): JavaDependency[] {
  const out: JavaDependency[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\/\/.*$/, "");
    const config = new RegExp(`(?:^|\\s)(?:${GRADLE_CONFIGS})\\s*\\(?\\s*(.*)$`).exec(line);
    if (!config) continue;
    const rest = config[1]!;
    if (/^(platform|enforcedPlatform|project|files|fileTree|kotlin|gradleApi|localGroovy)\b/.test(rest)) continue;
    const coords = /^['"]([^'":\s]+):([^'":\s]+)(?::[^'"]*)?['"]/.exec(rest);
    const named = /group\s*[:=]\s*['"]([^'"]+)['"]\s*,\s*name\s*[:=]\s*['"]([^'"]+)['"]/.exec(rest);
    const alias = /^libs\.([\w.]+)/.exec(rest);
    if (coords) out.push({ group: coords[1]!, artifact: coords[2]!, line: i + 1 });
    else if (named) out.push({ group: named[1]!, artifact: named[2]!, line: i + 1 });
    else if (alias) {
      const hit = catalog.get(alias[1]!.replace(/\.get$/, ""));
      if (hit) out.push({ ...hit, line: i + 1 });
    }
  }
  return out;
}

/** Libraries in `gradle/libs.versions.toml`, keyed the way build scripts refer to them (`libs.spring.web`). */
function readCatalog(root: string): Map<string, { group: string; artifact: string }> {
  const out = new Map<string, { group: string; artifact: string }>();
  const file = join(root, "gradle/libs.versions.toml");
  if (!existsSync(file)) return out;
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(readFileSync(file, "utf8"));
  } catch {
    return out;
  }
  for (const [alias, value] of Object.entries((doc.libraries ?? {}) as Record<string, unknown>)) {
    let coords: string | undefined;
    if (typeof value === "string") coords = value;
    else if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if (typeof v.module === "string") coords = v.module;
      else if (typeof v.group === "string" && typeof v.name === "string") coords = `${v.group}:${v.name}`;
    }
    const [group, artifact] = (coords ?? "").split(":");
    if (group && artifact) out.set(alias.replace(/[-_]/g, "."), { group, artifact });
  }
  return out;
}
