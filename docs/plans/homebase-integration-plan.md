# MemoryApi HomeBase Integration — Phase 5 Plan (revised)

## Context

HomeBase's Phase 5 (`docs/TASKS.md`) requires each sibling application to get
its own approved plan before integration work begins. LMApi is Done and is
the reference pattern (`LMApi/docs/plans/2026-08-16-homebase-integration.md`);
DevPlanner is functionally integrated but stays **In progress**, unrelated to
this plan. This revision supersedes the original draft below (kept
superficially in spirit, but corrected after direct investigation of
MemoryApi's code — the original was written from HomeBase's side without
that access). Two concrete problems were found and confirmed empirically.
The rest of the original decisions hold: consolidate MemoryApi's databases
onto this Docker host (replacing the remote `192.168.7.40` "Blue-Mini" host),
reach LMApi over loopback once co-hosted, and treat data as a fresh start
rather than migrating anything off Blue-Mini.

## What the original draft got right (unchanged)

- HomeBase already has a `memoryapi` entry in `config/homebase.json`
  (`enabled: false`, `adapterPath: "dist/host/index.js"`) and the
  `memoryapi-node-modules` volume / `/workspace/MemoryApi` mount in both
  compose files — no HomeBase-side compose changes needed.
- `HostedApplication`/`HostedApplicationOptions` contract
  (`HomeBase/src/contracts/hostedApplication.ts`, `contractVersion: 1`):
  factory `(options) => HostedApplication`, optional `initialize()`,
  `router`, `staticAssets`, `attachRealtime()`, required `getStatus()`,
  optional `getActiveWork()`/`dispose()`. `ApplicationHost.ts` dynamic-
  `import()`s the adapter and reads `imported.default`, mounts the router at
  `options.basePath` (always trailing-slash, e.g. `/memoryapi/`) via
  `app.use(basePath, router)`.
- MemoryApi's `Config` class (`src/services/configService.ts:70-186`)
  already supports constructor overrides — a real asset to build on.
- LMApi's `src/host/{contracts.ts,config.ts,adapter.ts,index.ts,
  __tests__/adapter.test.ts}` remains the structural template (factory
  closure, lazy router, idempotent `dispose()`/`getStatus()`).
- MemoryApi is genuinely ESM (`"type": "module"`, `tsconfig.json` targets
  `module: ES2022`) — a plain `export default createMemoryApiAdapter(...)`
  in `src/host/index.ts` resolves correctly via `imported.default` under
  Node's dynamic `import()` and should NOT be replaced with LMApi's CJS
  `export =` trick. (LMApi needs `export =` only because it compiles to
  CommonJS, where `export default` produces a wrapped
  `{ default: fn, __esModule: true }` object instead of `fn` itself.)

## Two corrections found by direct investigation

### 1. A plain `tsc` host build will not run under plain Node — verified

Running the existing compiled `dist/` output directly:

```
$ node -e "import('./dist/services/sqlService.js')..."
FAIL: ERR_MODULE_NOT_FOUND Cannot find module '...\dist\services\configService'
      imported from '...\dist\services\sqlService.js'
```

MemoryApi's source uses extensionless relative imports everywhere (e.g.
`from './configService'`), and `tsconfig.json` uses `moduleResolution: node`
(not `nodenext`), so `tsc` copies those specifiers into the compiled output
unchanged. `tsx` (used for `npm run dev`/`api`) tolerates this; Node's native
ESM loader does not — it requires explicit extensions on relative specifiers.
LMApi never hits this because it compiles to CommonJS, and `require()`
resolution is extension-tolerant. A `tsc -p tsconfig.host.json` build:host
step would produce an adapter that HomeBase's `ApplicationHost.ts` fails to
`import()` at all.

**Fix:** bundle the host entry point with esbuild instead of plain `tsc`.
Add `esbuild` as a devDependency; `build:host` runs
`esbuild src/host/index.ts --bundle --platform=node --format=esm
--outfile=dist/host/index.js --packages=external`. This inlines the entire
local `src/**` import graph into one file — no unresolved bare relative
specifiers remain — while marking everything in `package.json` dependencies
(express, neo4j-driver, sqlite3, @qdrant/js-client-rest, etc.) external so
they still resolve normally via `node_modules` at runtime. This keeps the
ESM `export default` approach intact without touching import syntax in any
of the ~40+ existing source files.

### 2. The import-time side-effect chain goes deeper than `app/index.ts`

- `src/app/memoryAPI.ts:11-12` — `const memorySystem = new MemoryRAGSystem();`
  at **module scope**. `reviewAPI.ts:9` similarly builds
  `new ReviewMemoriesService(memorySystem)` at module scope, importing
  `memoryAPI.ts` transitively.
- `MemoryRAGSystem`'s constructor (`memoryRAGSystem.ts:36-66`) builds
  `RAGOrchestrator`, which (`ragOrchestrator.ts:17-25`) constructs
  `VectorService`/`GraphService` reading `config.QDRANT_URL`/`NEO4J_URI`/etc,
  and assigns the `sqlService` singleton.
- `sqlService.ts:535` — `export const sqlService = new SqlService();` at
  module scope. `SqlService`'s constructor calls `openConnection()`
  (`sqlService.ts:58-75`), which does `fs.mkdirSync(...)` and
  `new sqlite3.Database(dbPath, ...)` — a real file handle opened on first
  import, using whatever `config.SQLITE_DB_PATH` resolves to at that moment.

Simply importing `memoryAPI.ts` — needed to build the router at all — opens
a SQLite connection to the wrong path before HomeBase's injected
`options.dataPath`/`repositoryRoot` can take effect, unless import is
carefully sequenced.

There's also a sharper bug hiding here: `Config`'s
`applyEnvironmentStorageTargets()` (`configService.ts:140-158`)
unconditionally recomputes `SQLITE_DB_PATH` from
`ENVIRONMENT_STORAGE_TARGETS` (itself `path.join(process.cwd(), 'data', env,
'memory.db')`, computed once at module load) **unless the key is present in
the constructor's `overrides` object** — a plain `process.env.SQLITE_DB_PATH`
assignment is silently overwritten. Only a genuine constructor-level override
survives.

**Fix:** add one exported function to `configService.ts`:

```ts
export function reconfigure(overrides: Partial<ConfigValues>): void {
  Object.assign(config, new Config(overrides));
}
```

This reuses the existing override-bypass logic correctly (since `overrides`
is now real, not just `process.env`), and every other module already holds a
live reference to the same exported `config` object, so mutating it in place
propagates everywhere. The adapter's `initialize()` then:

1. Dynamically imports **only** `../services/configService.js` first.
2. Calls `reconfigure({ SQLITE_DB_PATH: join(options.dataPath, 'memory.db'),
   PROMPT_TEMPLATE_BASE_PATH: join(options.repositoryRoot, 'src', 'prompts'),
   LLM_HOST: <loopback URL, see below> })` — leaving `QDRANT_URL`/
   `NEO4J_*_URI` to plain `process.env` (Docker Compose already sets these
   correctly per-container).
3. Only then dynamically imports the composition root (`../app/index.js`) to
   build the router — by this point every downstream singleton construction
   sees the corrected config.

This keeps every service class (`MemoryRAGSystem`, `RAGOrchestrator`,
`SqlService`, `GraphService`, `VectorService`) untouched — no constructor
signatures change — and satisfies the HostedApplication contract's
expectation that the factory itself stays side-effect-free until
`initialize()` runs.

## Simplification found for base-path frontend rewiring

Rather than computing paths from `document.baseURI` or injecting a
`<base href>` tag, change every fetch in `public/app.js` (13 call sites:
lines 9-11, 24, 72, 114, 127, 140, 153, 537, 584, 619, 644) from `/api/...`
(leading slash, host-root-relative) to `api/...` (no leading slash, relative
to the current page URL). Since HomeBase's `basePath` contract guarantees a
trailing slash (`/memoryapi/`) and standalone mode serves the page at `/`
(also trailing-slash), the browser resolves `api/review/queue` correctly in
each mode with no runtime detection code needed at all.

## Implementation phases

1. **`configService.ts`**: add `reconfigure(overrides)` as described above.
2. **Composition-root split** (`src/app/index.ts`): extract a
   `buildApp(basePath: string, repositoryRoot: string): Promise<{ app: Express; dispose: () => Promise<void> }>`
   that calls `initializeMemorySystem()`, mounts
   `express.static(path.join(repositoryRoot, 'public'))` and
   `app.use(path.posix.join(basePath, 'api'), memoryRouter)` /
   `reviewRouter`, and returns `dispose`. Keep a standalone guard
   (`import.meta.url === pathToFileURL(process.argv[1]).href`) that calls
   `buildApp('/', process.cwd())` and `app.listen(config.PORT)` — preserves
   today's `/api/...` URLs exactly for `npm run dev`/`api`/`start`.
3. **`public/app.js`**: change all 13 fetch call sites from `/api/...` to
   `api/...`.
4. **LMApi reachability**: in the adapter's `reconfigure()` call, set
   `LLM_HOST` to `` `http://127.0.0.1:${process.env.HOMEBASE_PORT ?? 17106}/lmapi` ``
   (no trailing slash — `LMApiClient` in `src/services/modelClients.ts:241`
   appends `/api/generate/any` directly). `process.env.HOMEBASE_PORT` is
   read directly since the adapter runs in-process with HomeBase.
   Standalone mode keeps its `.env`-driven `LLM_HOST` untouched.
5. **Dispose**: `SqlService.close()` (`sqlService.ts:515`) and
   `GraphService.close()` (`graphService.ts:23`) already exist. Add a small
   cascading `dispose()` to `RAGOrchestrator`/`MemoryRAGSystem` that calls
   both (Qdrant's REST client needs no explicit close). `buildApp()`'s
   returned `dispose` calls `memorySystem.dispose()`; the adapter's
   `dispose()` calls that, guarded idempotent.
6. **Hosted adapter entry point**: new `src/host/{contracts.ts, config.ts,
   adapter.ts, index.ts, __tests__/adapter.test.ts}`, mirroring LMApi's
   shape. `adapter.ts`'s `initialize()` follows the sequenced-import order
   above. `getStatus()` reports `degraded` if Qdrant/Neo4j/SQLite is
   unreachable. `getActiveWork()` is optional on the contract — omit it.
7. **`tsconfig.host.json` + `build:host`**: extends the base ESM config
   (keep `module: ES2022`). Add `esbuild` devDependency; `build:host`
   bundles `src/host/index.ts` per the fix above. Verify empirically after
   building: `node -e "import('./dist/host/index.js').then(m => console.log(typeof m.default))"`
   must print `function`.
8. **Tests**: `src/host/__tests__/adapter.test.ts` — factory has no side
   effects before `initialize()`, `dispose()` is idempotent, `getStatus()`
   reflects a forced-degraded dependency, `reconfigure()` correctly
   overrides `SQLITE_DB_PATH` despite `applyEnvironmentStorageTargets`
   (regression test for the bug found above).
9. **Registry + live verification**: flip `config/homebase.json`'s
   `memoryapi.enabled` to `true` locally, run HomeBase with LMApi +
   MemoryApi both enabled, verify: page load, review-queue UI loads under
   `/memoryapi/` with working relative fetches, core endpoints work
   end-to-end, `/memoryapi/api/status/*` reflects real DB reachability, a
   `dispose()` cycle leaves no open handles, and LMApi calls succeed via
   loopback.

## Database consolidation (non-blocking)

Can happen before/during/after the adapter work; recommend first so live
verification (phase 9) runs against local DBs.

1. New `MemoryApi/docker-compose.databases.yml`: single Qdrant service
   (none exists today — `QDRANT_URL` currently points at
   `192.168.7.40:6333`) plus the three Neo4j Community instances currently
   in `docker-compose.neo4j-community.yml` (prod/dev/test on
   7474/7687, 7475/7688, 7476/7689), all published on `127.0.0.1` only.
2. Remove `docker-compose.neo4j-community.yml`; replace
   `neo4j:community:up/down/ps` npm scripts (`package.json:24-26`) with
   `databases:up/down/ps` pointed at the new file.
3. Update `.env` (`QDRANT_URL`, `NEO4J_PROD_URI`, `NEO4J_DEV_URI`,
   `NEO4J_TEST_URI` — currently all `192.168.7.40`) to point at `localhost`.
4. Fresh start, no data migration from Blue-Mini (reseed via `npm run
   seed:dev`/`seed:prod`).
5. Short "starting MemoryApi's databases" section in `README.md`.

**Security note (pre-existing):** `.env` stores the Neo4j password and a
Todoist API token in plaintext; already gitignored, no action needed beyond
flagging it.

## Files touched

**MemoryApi:**
- `src/services/configService.ts` — add `reconfigure()`.
- `src/app/index.ts` — composition-root split (`buildApp`), standalone
  guard.
- `src/services/memoryRAGSystem.ts`, `src/services/ragOrchestrator.ts` —
  add cascading `dispose()`.
- `public/app.js` — 13 fetch call sites, drop leading `/`.
- New: `src/host/contracts.ts`, `config.ts`, `adapter.ts`, `index.ts`,
  `__tests__/adapter.test.ts`, `tsconfig.host.json`.
- `package.json` — `esbuild` devDependency, `build:host` script,
  `databases:up/down/ps` replacing `neo4j:community:*`.
- New `docker-compose.databases.yml`; remove
  `docker-compose.neo4j-community.yml`.
- `.env`, `README.md` — updated DB hosts, new database-setup section, note
  on HomeBase-hosted base path and loopback LMApi URL.

**HomeBase:**
- `config/homebase.json` (git-ignored) — flip `memoryapi.enabled: true`
  once the adapter is ready.
- `docs/TASKS.md` — check off MemoryApi's Phase 5 line, update its
  "Plan:" pointer once implementation and live verification are complete.

## Verification

- `npm run build` and `npm run build:host` compile/bundle cleanly.
- **Specific regression check**:
  `node -e "import('./dist/host/index.js').then(m => console.log(typeof m.default))"`
  prints `function` (guards against the extensionless-import failure found
  above).
- `npm test` still passes unchanged.
- Standalone `npm run dev` still serves `/api/...` exactly as today.
- `docker compose -f docker-compose.databases.yml up -d` brings up Qdrant +
  3 Neo4j instances; `npm run seed:dev` succeeds against them.
- With `homebase.json`'s `memoryapi` entry enabled and HomeBase running,
  confirm live: dashboard card renders ready/degraded correctly,
  review-queue UI loads and works under `/memoryapi/`, a memory can be
  added/searched/committed end-to-end through HomeBase, `dispose()` on
  HomeBase shutdown leaves no hung process, and LMApi calls succeed over
  loopback.
