import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyze,
  applyCleanup,
  check,
  dependencyReport,
  gradleDependencies,
  loadConfig,
  mavenDependencies,
  parseJava,
  planCleanup,
  scan,
  stateOf,
  tokenizeJava,
} from "@loose-ends/core";
import { project, repo } from "./helpers/project.js";

const states = (root: string, ids: string[]) => {
  const analysis = analyze(loadConfig(root));
  return Object.fromEntries(ids.map((id) => [id, stateOf(analysis, id).liveness]));
};
const sym = (path: string, name?: string) => `sym:${path}#${name ?? path.split("/").pop()!.replace(/\.java$/, "")}`;
const cls = (pkg: string, name: string, body = "", head = "") => `package ${pkg};\n${head}\npublic class ${name} {\n${body}\n}\n`;

describe("Java parser", () => {
  it("tokenizes strings, text blocks, chars, and comments without mistaking them for code", () => {
    const { tokens, comments } = tokenizeJava('String s = "a { b"; /* class X { */ char c = \'}\';\nvar t = """\n  class Y {}\n  """; // tail');
    expect(tokens.filter((t) => t.kind === "name" && (t.value === "X" || t.value === "Y"))).toEqual([]);
    expect(tokens.map((t) => t.kind).filter((k) => k !== "name" && k !== "op")).toEqual(["string", "char", "string"]);
    expect(comments.map((c) => c.text)).toEqual(["/* class X { */", "// tail"]);
  });

  it("reads the package, imports, top-level types, and what they reference", () => {
    const info = parseJava(
      "src/main/java/com/acme/app/Users.java",
      [
        "package com.acme.app;",
        "import java.util.List;",
        "import static org.junit.Assert.assertEquals;",
        "import com.acme.util.*;",
        "// loose-ends: dormant kept for the v1 API",
        "@RestController",
        '@RequestMapping(value = "/users", produces = {"a"})',
        "public final class Users extends Base<User> implements Api {",
        '  private static final String PLUGIN = "com.acme.plugins.Extra";',
        "  record Pair(int a) {}",
        "  @GetMapping public List<User> list(@PathVariable String id) {",
        "    return Helpers.clean(com.acme.other.Fqn.CONST, Pair::new);",
        "  }",
        "  public static void main(String[] args) {}",
        "}",
        "@interface Marker { String value() default \"\"; }",
        "sealed interface Shape permits Circle {}",
        "non-sealed class Circle implements Shape {}",
      ].join("\n"),
    );
    expect(info.javaPackage).toBe("com.acme.app");
    expect(info.javaImports!.map((i) => `${i.name}${i.static ? " static" : ""}${i.wildcard ? " *" : ""}`)).toEqual(["java.util.List", "org.junit.Assert.assertEquals static", "com.acme.util *"]);
    expect(info.declarations.map((d) => `${d.name}:${d.kind}:${d.line}-${d.endLine}`)).toEqual(["Users:class:6-15", "Marker:interface:16-16", "Shape:interface:17-17", "Circle:class:18-18"]);
    expect(info.declarations[0]!.references).toEqual(expect.arrayContaining(["Api", "Base", "GetMapping", "Helpers.clean", "List", "Pair", "RestController", "User", "com.acme.other.Fqn.CONST"]));
    expect(info.declarations[3]!.references).toEqual(["Shape"]);
    expect(info.javaTypes!.map((t) => [t.name, t.kind, t.public, t.annotations.join(","), t.superTypes.join(","), t.hasMain, t.memberAnnotations.join(",")])).toEqual([
      ["Users", "class", true, "RestController,RequestMapping", "Base,Api", true, "GetMapping,PathVariable"],
      ["Marker", "annotation", false, "", "", false, ""],
      ["Shape", "interface", false, "", "", false, ""],
      ["Circle", "class", false, "", "Shape", false, ""],
    ]);
    expect(info.javaNested).toEqual(["Pair"]);
    expect(info.stringRefs!.map((s) => s.value)).toEqual(["com.acme.plugins.Extra"]);
    expect(info.directives.map((d) => [d.action, d.reason, d.symbols.join(",")])).toEqual([["dormant", "kept for the v1 API", "Users"]]);
  });
});

describe("Java resolution", () => {
  it("follows imports, same-package names, wildcards, static imports, and qualified names", () => {
    const root = project({
      "src/main/java/app/Main.java": cls("app", "Main", "public static void main(String[] a) { Service.run(); com.lib.Fq.go(); assertThat(); }", "import static com.lib.Asserts.assertThat;"),
      "src/main/java/app/Service.java": cls("app", "Service", "static void run() { new Helper(); new Wild(); }", "import com.lib.Helper;\nimport com.wild.*;"),
      "src/main/java/com/lib/Helper.java": cls("com.lib", "Helper"),
      "src/main/java/com/lib/Fq.java": cls("com.lib", "Fq", "static void go() {}"),
      "src/main/java/com/lib/Asserts.java": cls("com.lib", "Asserts", "static void assertThat() {}"),
      "src/main/java/com/wild/Wild.java": cls("com.wild", "Wild"),
      "src/main/java/com/wild/Unused.java": cls("com.wild", "Unused"),
      "src/main/java/app/Orphan.java": cls("app", "Orphan"),
    });
    expect(
      states(root, [
        sym("src/main/java/app/Service.java"),
        sym("src/main/java/com/lib/Helper.java"),
        sym("src/main/java/com/lib/Fq.java"),
        sym("src/main/java/com/lib/Asserts.java"),
        sym("src/main/java/com/wild/Wild.java"),
        sym("src/main/java/com/wild/Unused.java"),
        sym("src/main/java/app/Orphan.java"),
      ]),
    ).toEqual({
      [sym("src/main/java/app/Service.java")]: "live",
      [sym("src/main/java/com/lib/Helper.java")]: "live",
      [sym("src/main/java/com/lib/Fq.java")]: "live",
      [sym("src/main/java/com/lib/Asserts.java")]: "live",
      [sym("src/main/java/com/wild/Wild.java")]: "live",
      [sym("src/main/java/com/wild/Unused.java")]: "orphaned",
      [sym("src/main/java/app/Orphan.java")]: "orphaned",
    });
  });

  it("keeps a type that is only imported, since deleting it would break the build", () => {
    const root = project({
      "src/main/java/app/Main.java": cls("app", "Main", "public static void main(String[] a) {}", "import app.model.Kept;"),
      "src/main/java/app/model/Kept.java": cls("app.model", "Kept"),
    });
    expect(states(root, [sym("src/main/java/app/model/Kept.java")])).toEqual({ [sym("src/main/java/app/model/Kept.java")]: "live" });
  });

  it("picks the closest type when modules repeat a fully qualified name", () => {
    const root = project({
      "a/src/main/java/org/acme/Main.java": cls("org.acme", "Main", "public static void main(String[] x) { new Model(); }"),
      "a/src/main/java/org/acme/Model.java": cls("org.acme", "Model"),
      "b/src/main/java/org/acme/Model.java": cls("org.acme", "Model"),
    });
    expect(states(root, [sym("a/src/main/java/org/acme/Model.java"), sym("b/src/main/java/org/acme/Model.java")])).toEqual({
      [sym("a/src/main/java/org/acme/Model.java")]: "live",
      [sym("b/src/main/java/org/acme/Model.java")]: "orphaned",
    });
  });

  it("follows Class.forName strings and does not resolve nested type names outward", () => {
    const root = project({
      "src/main/java/app/Main.java": cls("app", "Main", 'public static void main(String[] a) throws Exception { Class.forName("app.plugins.Loaded"); new Item(); }\nstatic class Item {}'),
      "src/main/java/app/plugins/Loaded.java": cls("app.plugins", "Loaded"),
      "src/main/java/app/Item.java": cls("app", "Item"),
    });
    expect(states(root, [sym("src/main/java/app/plugins/Loaded.java"), sym("src/main/java/app/Item.java")])).toEqual({
      [sym("src/main/java/app/plugins/Loaded.java")]: "live",
      [sym("src/main/java/app/Item.java")]: "orphaned",
    });
  });
});

describe("Java roots", () => {
  it("treats framework-managed types as roots", () => {
    const root = project({
      "pom.xml": "<project><artifactId>app</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>",
      "src/main/java/app/Application.java": cls("app", "Application", "public static void main(String[] a) {}", "@SpringBootApplication"),
      "src/main/java/app/web/UserController.java": cls("app.web", "UserController", "@Autowired UserService service;", "@RestController"),
      "src/main/java/app/web/UserService.java": cls("app.web", "UserService"),
      "src/main/java/app/data/UserRepository.java": "package app.data;\npublic interface UserRepository extends JpaRepository<User, Long> {}",
      "src/main/java/app/events/Listener.java": cls("app.events", "Listener", "@KafkaListener(topics = \"x\") void on(String m) {}"),
      "src/main/java/app/graphql/Fetcher.java": cls("app.graphql", "Fetcher", "", "@DgsComponent"),
      "src/main/java/app/Unused.java": cls("app", "Unused"),
    });
    const ids = ["web/UserController", "web/UserService", "data/UserRepository", "events/Listener", "graphql/Fetcher", "Unused"].map((p) => sym(`src/main/java/app/${p}.java`));
    expect(Object.values(states(root, ids))).toEqual(["live", "live", "live", "live", "live", "orphaned"]);
  });

  it("finds classes named in resources, Android manifests and layouts, and package scans", () => {
    const root = project({
      "src/main/resources/META-INF/services/javax.annotation.processing.Processor": "app.proc.MyProcessor\n",
      "src/main/resources/application.properties": "mybatis.type-handlers-package=app.handlers\nlogging.level.app.Other=DEBUG\n",
      "src/main/resources/beans.xml": '<bean class="app.xml.Configured"/>',
      "app/src/main/AndroidManifest.xml": '<manifest package="com.example"><application><activity android:name=".ui.MainActivity"/></application></manifest>',
      "app/src/main/res/layout/main.xml": "<com.example.views.FancyView android:layout_width=\"match_parent\"/>",
      "src/main/java/app/proc/MyProcessor.java": cls("app.proc", "MyProcessor"),
      "src/main/java/app/handlers/DateHandler.java": cls("app.handlers", "DateHandler"),
      "src/main/java/app/xml/Configured.java": cls("app.xml", "Configured"),
      "src/main/java/app/Other.java": cls("app", "Other"),
      "app/src/main/java/com/example/ui/MainActivity.java": cls("com.example.ui", "MainActivity"),
      "app/src/main/java/com/example/views/FancyView.java": cls("com.example.views", "FancyView"),
    });
    const ids = [
      sym("src/main/java/app/proc/MyProcessor.java"),
      sym("src/main/java/app/handlers/DateHandler.java"),
      sym("src/main/java/app/xml/Configured.java"),
      sym("src/main/java/app/Other.java"),
      sym("app/src/main/java/com/example/ui/MainActivity.java"),
      sym("app/src/main/java/com/example/views/FancyView.java"),
    ];
    // A logging level key names a class without using it.
    expect(Object.values(states(root, ids))).toEqual(["live", "live", "live", "orphaned", "live", "live"]);
  });

  it("publishes the public types of a library module and treats tests as test roots", () => {
    const root = project({
      "pom.xml": "<project><artifactId>lib</artifactId></project>",
      "src/main/java/lib/Api.java": cls("lib", "Api", "Internal x;"),
      "src/main/java/lib/Internal.java": "package lib;\nclass Internal {}",
      "src/main/java/lib/Dead.java": "package lib;\nclass Dead {}",
      "src/main/java/lib/Helper.java": "package lib;\nclass Helper {}",
      "src/test/java/lib/ApiTest.java": "package lib;\nclass ApiTest { @Test void t() { new Helper(); } }",
    });
    expect(states(root, [sym("src/main/java/lib/Api.java"), sym("src/main/java/lib/Internal.java"), sym("src/main/java/lib/Dead.java"), sym("src/main/java/lib/Helper.java")])).toEqual({
      [sym("src/main/java/lib/Api.java")]: "live",
      [sym("src/main/java/lib/Internal.java")]: "live",
      [sym("src/main/java/lib/Dead.java")]: "orphaned",
      [sym("src/main/java/lib/Helper.java")]: "test-only",
    });
  });

  it("counts Java types that Kotlin code imports or names in its package", () => {
    const root = project({
      "build.gradle.kts": 'plugins { id("com.android.application") }',
      "src/main/java/app/Main.java": cls("app", "Main", "public static void main(String[] a) {}"),
      "src/main/java/app/util/FromKotlin.java": cls("app.util", "FromKotlin"),
      "src/main/java/app/SamePackage.java": cls("app", "SamePackage"),
      "src/main/java/app/util/NotUsed.java": cls("app.util", "NotUsed"),
      "src/main/kotlin/app/Screen.kt": "package app\nimport app.util.FromKotlin\nclass Screen { val a = FromKotlin(); val b = SamePackage() }\n// NotUsed is only mentioned in a package that cannot see it\n",
    });
    expect(states(root, [sym("src/main/java/app/util/FromKotlin.java"), sym("src/main/java/app/SamePackage.java"), sym("src/main/java/app/util/NotUsed.java")])).toEqual({
      [sym("src/main/java/app/util/FromKotlin.java")]: "live",
      [sym("src/main/java/app/SamePackage.java")]: "live",
      [sym("src/main/java/app/util/NotUsed.java")]: "orphaned",
    });
  });

  it("honors directives and the languages option", () => {
    const root = project({
      "src/main/java/app/Main.java": cls("app", "Main", "public static void main(String[] a) {}"),
      "src/main/java/app/Kept.java": "package app;\n// loose-ends: dormant used by the v1 importer\npublic class Kept {}",
      "src/main/java/app/Plugin.java": "// loose-ends-file: entry\npackage app;\npublic class Plugin {}",
    });
    expect(states(root, [sym("src/main/java/app/Kept.java"), sym("src/main/java/app/Plugin.java")])).toEqual({
      [sym("src/main/java/app/Kept.java")]: "dormant",
      [sym("src/main/java/app/Plugin.java")]: "live",
    });
    const off = project({ "loose-ends.config.json": { languages: ["javascript"] }, "A.java": "class A {}", "index.js": "1" });
    expect(analyze(loadConfig(off)).build.files.map((f) => f.path)).toEqual(["index.js"]);
  });
});

describe("Java dependencies", () => {
  it("reads compile-scope Maven dependencies outside dependencyManagement and build", () => {
    const pom = `<project>
  <parent><groupId>org.springframework.boot</groupId><artifactId>parent</artifactId></parent>
  <artifactId>app</artifactId>
  <dependencyManagement><dependencies><dependency><groupId>x</groupId><artifactId>managed</artifactId></dependency></dependencies></dependencyManagement>
  <dependencies>
    <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId></dependency>
    <!-- <dependency><groupId>c</groupId><artifactId>commented</artifactId></dependency> -->
    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><scope>test</scope></dependency>
    <dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId><scope>runtime</scope></dependency>
  </dependencies>
  <build><plugins><plugin><dependencies><dependency><groupId>p</groupId><artifactId>plugin-dep</artifactId></dependency></dependencies></plugin></plugins></build>
</project>`;
    expect(mavenDependencies(pom).map((d) => `${d.group}:${d.artifact}@${d.line}`)).toEqual(["com.google.guava:guava@6"]);
  });

  it("reads Gradle dependencies, including version catalog aliases", () => {
    const gradle = [
      'implementation "com.squareup.okhttp3:okhttp:4.12.0"',
      "implementation(libs.jackson.databind)",
      "api group: 'org.slf4j', name: 'slf4j-api', version: '2'",
      'testImplementation "junit:junit:4"',
      "implementation platform('org.springframework.boot:spring-boot-dependencies:3')",
      "implementation project(':core')",
      '// implementation "x:commented:1"',
    ].join("\n");
    const catalog = new Map([["jackson.databind", { group: "com.fasterxml.jackson.core", artifact: "jackson-databind" }]]);
    expect(gradleDependencies(gradle, catalog).map((d) => `${d.group}:${d.artifact}@${d.line}`)).toEqual([
      "com.squareup.okhttp3:okhttp@1",
      "com.fasterxml.jackson.core:jackson-databind@2",
      "org.slf4j:slf4j-api@3",
    ]);
  });

  it("classifies dependency use from imported packages and resources", () => {
    const root = project({
      "gradle/libs.versions.toml": '[libraries]\njackson-databind = { module = "com.fasterxml.jackson.core:jackson-databind", version = "2" }\n',
      "build.gradle": [
        "plugins { id 'application' }",
        "dependencies {",
        "  implementation 'com.google.guava:guava:33'",
        "  implementation libs.jackson.databind",
        "  implementation 'org.apache.commons:commons-text:1'",
        "  implementation 'org.springframework.boot:spring-boot-starter-web:3'",
        "  implementation 'com.example:named-in-config:1'",
        "  implementation 'org.assertj:assertj-core:3'",
        "}",
      ].join("\n"),
      "src/main/resources/application.properties": "driver=com.example.Driver\n",
      "src/main/java/app/Main.java": cls("app", "Main", "public static void main(String[] a) { ImmutableList.of(); new ObjectMapper(); }", "import com.google.common.collect.ImmutableList;\nimport com.fasterxml.jackson.databind.ObjectMapper;"),
      "src/test/java/app/MainTest.java": "package app;\nimport org.assertj.core.api.Assertions;\nclass MainTest {}",
    });
    const uses = Object.fromEntries(dependencyReport(analyze(loadConfig(root))).map((r) => [r.name, r.use]));
    expect(uses).toEqual({
      "com.google.guava:guava": "live",
      "com.fasterxml.jackson.core:jackson-databind": "live",
      "org.apache.commons:commons-text": "unused",
      "org.springframework.boot:spring-boot-starter-web": "ignored",
      "com.example:named-in-config": "config",
      "org.assertj:assertj-core": "test-only",
    });
  });
});

describe("Java check and cleanup", () => {
  const base = {
    "src/main/java/app/Main.java": cls("app", "Main", "public static void main(String[] a) { new Formatter().format(1); }"),
    "src/main/java/app/Formatter.java": cls(
      "app",
      "Formatter",
      "  String format(int value) {\n    String text = String.valueOf(value).trim();\n    if (text.isEmpty()) { return \"-\"; }\n    return text.toLowerCase();\n  }",
    ),
  };

  it("fails a change that leaves a new class unused and passes one that wires it in", () => {
    expect(check({ root: repo(base, { "src/main/java/app/Extra.java": cls("app", "Extra") }), base: "HEAD" }).findings.map((f) => `${f.kind} ${f.target}`)).toEqual([
      "orphaned-addition src/main/java/app/Extra.java",
    ]);
    const wired = repo(base, {
      "src/main/java/app/Extra.java": cls("app", "Extra"),
      "src/main/java/app/Main.java": cls("app", "Main", "public static void main(String[] a) { new Formatter().format(1); new Extra(); }"),
    });
    expect(check({ root: wired, base: "HEAD" }).passed).toBe(true);
  });

  it("reads resource files from git snapshots when comparing two commits", () => {
    const root = repo(
      base,
      {
        "src/main/resources/META-INF/services/app.Plugin": "app.plugins.LoadedByServiceLoader\n",
        "src/main/java/app/plugins/LoadedByServiceLoader.java": cls("app.plugins", "LoadedByServiceLoader"),
        "app/src/main/res/layout/main.xml": "<app.views.CustomView/>",
        "src/main/java/app/views/CustomView.java": cls("app.views", "CustomView"),
      },
      { commitHead: true },
    );
    const result = check({ root, base: "main", head: "feature" });
    expect(result.findings).toEqual([]);
  });

  it("reports a replaced class that was left behind", () => {
    const root = repo(base, {
      "src/main/java/app/FormatterV2.java": cls(
        "app",
        "FormatterV2",
        "  String format(int value) {\n    String text = String.valueOf(value).trim();\n    if (text.isEmpty()) { return \"-\"; }\n    return text.toLowerCase();\n  }",
      ),
      "src/main/java/app/Main.java": cls("app", "Main", "public static void main(String[] a) { new FormatterV2().format(1); }"),
    });
    expect(check({ root, base: "HEAD" }).findings.map((f) => `${f.kind} ${f.target}`)).toEqual(["superseded src/main/java/app/Formatter.java"]);
  });

  it("deletes an orphaned class file and keeps a second type in a shared file", () => {
    const root = project({
      "src/main/java/app/Main.java": cls("app", "Main", "public static void main(String[] a) { new Used(); }"),
      "src/main/java/app/Dead.java": cls("app", "Dead"),
      "src/main/java/app/Used.java": "package app;\n\npublic class Used {}\n\n/** Old helper. */\nclass Leftover {}\n",
    });
    const analysis = analyze(loadConfig(root));
    const plan = planCleanup(analysis, scan({ root }).findings);
    expect(plan.actions.map((a) => (a.type === "delete-file" ? `delete ${a.path}` : `remove ${a.symbol}`))).toEqual(["delete src/main/java/app/Dead.java", "remove Leftover"]);
    applyCleanup(root, plan);
    expect(readFileSync(join(root, "src/main/java/app/Used.java"), "utf8")).toBe("package app;\n\npublic class Used {}\n");
  });
});
