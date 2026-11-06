import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import fg from "fast-glob";
import { symbolId } from "../graph.js";
import type { RootContext, RootProvider } from "../roots.js";
import { discoverJavaModules, type JavaModule } from "./project.js";

/** Annotations that make a framework create or call the type without any code naming it. */
const FRAMEWORK_ANNOTATIONS = new Set(
  [
    // Spring
    "SpringBootApplication", "Component", "Service", "Repository", "Controller", "RestController", "Configuration", "AutoConfiguration",
    "ControllerAdvice", "RestControllerAdvice", "ConfigurationProperties", "JsonComponent", "EnableAutoConfiguration", "SpringBootConfiguration",
    "Endpoint", "WebEndpoint", "FeignClient", "Aspect", "Document", "Node", "RepositoryRestResource", "Route",
    // Jakarta EE / JPA / CDI / JAX-RS / servlets
    "Entity", "Embeddable", "MappedSuperclass", "Converter", "Path", "Provider", "ApplicationPath", "ApplicationScoped", "RequestScoped",
    "SessionScoped", "Singleton", "Dependent", "Named", "Startup", "Stateless", "Stateful", "MessageDriven", "WebServlet", "WebFilter",
    "WebListener", "ServerEndpoint", "Interceptor", "Decorator", "Alternative", "Produces",
    // Quarkus, Micronaut, MyBatis, MapStruct, Dagger/Hilt, Room, AutoService, Maven plugins, picocli
    "QuarkusMain", "Factory", "Introspected", "Serdeable", "Mapper", "Module", "InstallIn", "HiltAndroidApp", "AndroidEntryPoint",
    "HiltViewModel", "Database", "Dao", "AutoService", "Mojo", "Command", "MappedTypes", "MappedJdbcTypes",
    "SearchExtension", "RegisterForReflection", "ResourceProperties", "ProtoSchema", "AutoProtoSchemaBuilder", "GraphQLApi", "WebSocket",
    "WebSocketClient", "RegisterRestClient", "RegisterProvider", "ApplicationModule", "SpringBootTest",
  ],
);
/** Method and parameter annotations that make a framework call into the type (`@Incoming`, `@Scheduled`, `@Observes`). */
const MEMBER_ANNOTATIONS = new Set([
  "Funq", "Route", "RouteFilter", "Incoming", "Outgoing", "Scheduled", "EventListener", "TransactionalEventListener", "KafkaListener",
  "RabbitListener", "JmsListener", "SqsListener", "StreamListener", "Observes", "ObservesAsync", "Bean", "Produces", "ConsumeEvent",
  "ServerExceptionMapper", "ServerRequestFilter", "ServerResponseFilter", "DgsQuery", "DgsMutation", "DgsData", "DgsSubscription",
  "QueryMapping", "MutationMapping", "SchemaMapping", "OnOpen", "OnTextMessage", "OnBinaryMessage", "OnMessage", "OnClose", "OnError",
  "JobWorker", "Tool", "WebMethod", "GET", "POST", "PUT", "DELETE", "PATCH", "Startup", "Shutdown",
]);
/** Stereotype-style annotations from other frameworks (`@DgsComponent`, `@KafkaListenerContainer`...). */
const FRAMEWORK_ANNOTATION_SUFFIX = /^\w+(Component|Controller|Service|Repository|Endpoint|Configuration|Application|Mapper|Entity|Listener)$/;
/** Supertypes whose subclasses a framework instantiates by convention or from configuration. */
const FRAMEWORK_SUPERTYPE =
  /(^|\.)(\w*Repository|Panache\w*|HttpServlet|GenericServlet|Filter|SpringBootServletInitializer|Application|Activity|AppCompatActivity|FragmentActivity|ComponentActivity|Service|IntentService|JobService|BroadcastReceiver|ContentProvider|Worker|ListenableWorker|AbstractMojo|ServletContextListener|ApplicationListener|ApplicationRunner|CommandLineRunner|Plugin|CodecProvider|ExceptionMapper|ContainerRequestFilter|ContainerResponseFilter|ParamConverterProvider|MessageBodyReader|MessageBodyWriter|ConfigSource|ConfigSourceProvider|ConstraintProvider)(<.*)?$/;
/** Member annotations that mark a test class outside the usual test folders. */
const TEST_ANNOTATIONS = new Set(["Test", "ParameterizedTest", "RepeatedTest", "TestFactory", "TestTemplate"]);
/** Files whose text names classes: Spring XML, `META-INF/services`, `spring.factories`, Android manifests, web.xml, build files. */
const RESOURCE_FILES = [
  "**/src/*/resources/**",
  "**/src/main/webapp/**",
  "**/src/*/res/**/*.xml",
  "**/AndroidManifest.xml",
  "**/META-INF/**",
  "**/pom.xml",
  "**/build.gradle",
  "**/build.gradle.kts",
  "**/*.properties",
];
const RESOURCE_IGNORE = ["**/node_modules/**", "**/.git/**", "**/target/**", "**/build/**", "**/.gradle/**", "**/*.{png,jpg,jpeg,gif,svg,ico,webp,ttf,woff,woff2,jar,zip,class,so,pdf}"];
const CLASS_NAME = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g;

/** Roots for Java: main methods, framework-managed types, classes named in resources, and published APIs. */
export const javaRoots: RootProvider = {
  name: "java",
  discover(ctx) {
    const java = ctx.build.java;
    if (!java) return;
    const javaFiles = ctx.files.filter((f) => f.endsWith(".java"));
    const modules = discoverJavaModules(ctx.config.root);
    const mainModules = new Set<string>();

    for (const path of javaFiles) {
      const info = ctx.build.graph.modules.get(path);
      if (!info) continue;
      const name = posix.basename(path);
      if (name === "module-info.java" || name === "package-info.java") {
        ctx.addFile(path, { kind: "tooling", source: "java", reason: `${name} is read by the compiler` });
        continue;
      }
      for (const type of info.javaTypes ?? []) {
        const node = symbolId(path, type.name);
        if (type.hasMain) {
          ctx.add({ node, kind: "production", source: "java#main", reason: `${type.name} has a main method` });
          const owner = moduleOf(modules, path);
          if (owner) mainModules.add(owner.dir);
        }
        const annotation = type.annotations.find((a) => FRAMEWORK_ANNOTATIONS.has(a) || FRAMEWORK_ANNOTATION_SUFFIX.test(a));
        if (annotation) ctx.add({ node, kind: "production", source: `java#@${annotation}`, reason: `annotated @${annotation}, so the framework creates it` });
        const supertype = type.superTypes.find((s) => FRAMEWORK_SUPERTYPE.test(s));
        if (supertype && !annotation) ctx.add({ node, kind: "production", source: "java#supertype", reason: `extends ${supertype}, which a framework instantiates` });
        const member = type.memberAnnotations.find((a) => MEMBER_ANNOTATIONS.has(a));
        if (member && !annotation && !supertype) ctx.add({ node, kind: "production", source: `java#@${member}`, reason: `has a @${member} member, which the framework calls` });
        if (type.memberAnnotations.some((a) => TEST_ANNOTATIONS.has(a))) ctx.add({ node, kind: "test", source: "java#@Test", reason: "has test methods" });
      }
    }

    resourceRoots(ctx);
    kotlinRoots(ctx);

    // Spring Boot, Quarkus, and servlet containers serve these folders by URL.
    for (const path of ctx.files) {
      if (/(^|\/)src\/main\/(resources\/(static|public|resources|META-INF\/resources)|webapp)\/.+\.(js|mjs|cjs)$/.test(path)) {
        ctx.addScript(path, { kind: "production", source: "java#static", reason: "served as a static web resource" });
      }
    }

    // A library module (no application plugin, no main) publishes its public types.
    for (const module of modules) {
      if (module.app || mainModules.has(module.dir) || /<packaging>\s*pom\s*<\/packaging>/.test(module.text)) continue;
      const prefix = `${module.dir ? module.dir + "/" : ""}src/main/java/`;
      for (const path of javaFiles) {
        if (!path.startsWith(prefix) || moduleOf(modules, path) !== module) continue;
        for (const type of ctx.build.graph.modules.get(path)?.javaTypes ?? []) {
          if (type.public) ctx.add({ node: symbolId(path, type.name), kind: "production", source: module.buildFile, reason: `public type of the ${module.name || "root"} library` });
        }
      }
    }
  },
};

/** The innermost build module containing a file. */
function moduleOf(modules: JavaModule[], path: string): JavaModule | undefined {
  let best: JavaModule | undefined;
  for (const m of modules) {
    if (m.dir !== "" && !path.startsWith(m.dir + "/")) continue;
    if (!best || m.dir.length > best.dir.length) best = m;
  }
  return best;
}

/** Fully qualified class names in resource and build files. Android manifests may use `.RelativeName`. */
function resourceRoots(ctx: RootContext): void {
  const java = ctx.build.java!;
  const files = fg.sync(RESOURCE_FILES, { cwd: ctx.config.root, ignore: RESOURCE_IGNORE, onlyFiles: true, dot: true, deep: 12 });
  for (const file of files.sort()) {
    let text: string;
    try {
      text = readFileSync(join(ctx.config.root, file), "utf8");
    } catch {
      continue;
    }
    if (text.length > 1024 * 1024 || text.includes("\u0000")) continue;
    const add = (fqn: string) => {
      const exact = java.all(fqn).length ? fqn : fqn.includes("$") ? fqn.split("$")[0]! : fqn;
      const hit = java.lookup(exact, file);
      if (hit && java.all(exact).length) ctx.add({ node: symbolId(hit.file, hit.name), kind: "production", source: file, reason: `named in ${file}` });
    };
    // `mybatis.type-handlers-package=io.app.handlers`, `<context:component-scan base-package="io.app"/>`
    for (const line of text.split(/\r?\n/)) {
      if (!/package|scan/i.test(line)) continue;
      for (const m of line.matchAll(/[a-z_][\w]*(?:\.[a-z_][\w]*)+/g)) {
        for (const ref of java.typesIn(m[0])) ctx.add({ node: symbolId(ref.file, ref.name), kind: "production", source: file, reason: `package ${m[0]} is scanned (${file})` });
      }
    }
    for (const m of text.matchAll(CLASS_NAME)) {
      // Exact names only, plus their outer type for `Outer$Inner` and `Outer.Inner`.
      add(m[0]);
      const parts = m[0].split(".");
      if (parts.length > 2 && /^[A-Z]/.test(parts[parts.length - 1]!) && /^[A-Z]/.test(parts[parts.length - 2]!)) add(parts.slice(0, -1).join("."));
    }
    if (file.endsWith("AndroidManifest.xml")) {
      const pkg = /\bpackage\s*=\s*"([\w.]+)"/.exec(text)?.[1] ?? namespaceFor(ctx, file);
      if (pkg) for (const m of text.matchAll(/android:name\s*=\s*"(\.[\w.$]+)"/g)) add(pkg + m[1]);
    }
  }
}

/** Android Gradle `namespace` for the module that owns a manifest. */
function namespaceFor(ctx: RootContext, manifest: string): string | undefined {
  let dir = posix.dirname(manifest);
  while (dir !== "." && dir !== "") {
    for (const name of ["build.gradle", "build.gradle.kts"]) {
      try {
        const text = readFileSync(join(ctx.config.root, dir, name), "utf8");
        const ns = /\bnamespace\s*=?\s*['"]([\w.]+)['"]/.exec(text)?.[1];
        if (ns) return ns;
      } catch {
        // keep looking
      }
    }
    dir = posix.dirname(dir);
  }
  return undefined;
}

/**
 * Kotlin is not analyzed, but Java code it uses is not dead. A Java type
 * imported by a Kotlin file, or named in one, counts as a root.
 */
function kotlinRoots(ctx: RootContext): void {
  const java = ctx.build.java!;
  const kotlin = fg.sync(["**/*.kt", "**/*.kts"], { cwd: ctx.config.root, ignore: ["**/node_modules/**", "**/.git/**", "**/build/**", "**/.gradle/**"], onlyFiles: true });
  if (kotlin.length === 0) return;
  // Kotlin sees Java types it imports (exactly or with `.*`), types in its own package, and fully qualified names.
  const exact = new Set<string>();
  const visible = new Map<string, Set<string>>();
  const texts: string[] = [];
  for (const file of kotlin) {
    let text: string;
    try {
      text = readFileSync(join(ctx.config.root, file), "utf8");
    } catch {
      continue;
    }
    texts.push(text);
    const words = new Set(text.match(/\b[A-Z][\w]*\b/g) ?? []);
    const packages = [/^\s*package\s+([\w.]+)/m.exec(text)?.[1] ?? ""];
    for (const m of text.matchAll(/^\s*import\s+([\w.]+)(\.\*)?/gm)) {
      if (m[2]) packages.push(m[1]!);
      else {
        // `import a.b.Outer.Inner` uses `a.b.Outer` too.
        const parts = m[1]!.split(".");
        for (let k = 2; k <= parts.length; k++) exact.add(parts.slice(0, k).join("."));
      }
    }
    for (const pkg of packages) {
      let set = visible.get(pkg);
      if (!set) visible.set(pkg, (set = new Set()));
      for (const w of words) set.add(w);
    }
  }
  const all = texts.join("\n");
  for (const [fqn, refs] of java.index) {
    const pkg = fqn.includes(".") ? fqn.slice(0, fqn.lastIndexOf(".")) : "";
    for (const ref of refs) {
      if (exact.has(fqn) || visible.get(pkg)?.has(ref.name) || (pkg && all.includes(fqn))) {
        ctx.add({ node: symbolId(ref.file, ref.name), kind: "production", source: "kotlin", reason: "used from Kotlin code (Kotlin is not analyzed)" });
      }
    }
  }
}
