# @localhost-aliases/core — exact public API

Every consumer (helper, web, mcp, tray scripts, tests) codes against these signatures.
Implementations must match them exactly. All imports use explicit `.ts` extensions.

```ts
// validation.ts
export function normalizeName(raw: string): string;                  // trim, lowercase, strip trailing dots
export function validateName(name: string): ValidationIssue[];       // [] when valid
export function validatePort(port: unknown): ValidationIssue[];
export function validateTarget(target: string): ValidationIssue[];
export function validateTld(tld: string): ValidationIssue[];
/** Throws ValidationError. `excludeId` skips self when updating. */
export function assertValidAlias(
  input: CreateAliasInput,
  existing: Alias[],
  opts?: { excludeId?: string }
): void;
export function hostnameFor(name: string, tld: string): string;      // "myapp" + "local" -> "myapp.local"
export function urlFor(name: string, tld: string, https: boolean, port: number): string;

// store.ts
export function loadConfig(): Promise<Config>;                       // seeds defaults if missing
export function saveConfig(config: Config): Promise<Config>;         // atomic write
export function listAliases(): Promise<Alias[]>;
export function getAlias(idOrName: string): Promise<Alias | null>;
export function createAlias(input: CreateAliasInput): Promise<{ config: Config; alias: Alias }>;
export function updateAlias(id: string, input: UpdateAliasInput): Promise<{ config: Config; alias: Alias }>;
export function deleteAlias(id: string): Promise<{ config: Config; alias: Alias }>;
export function updateSettings(patch: Partial<Omit<Config, "aliases" | "version">>): Promise<Config>;
/** Serializes all mutations; exported for tests. */
export function withConfigLock<T>(fn: () => Promise<T>): Promise<T>;

// hosts.ts
export function renderBlock(hostnames: string[]): string;            // includes BEGIN/END markers, trailing \n
export function parseBlock(content: string): string[];               // hostnames inside markers, [] if absent
export function applyBlock(content: string, hostnames: string[]): string; // pure, idempotent; [] removes block
export function isValidHostname(host: string): boolean;              // helper-side defence-in-depth check
export async function readHosts(): Promise<string>;                  // HOSTS_PATH
export async function writeHosts(content: string): Promise<void>;    // atomic, 0644
export async function flushDns(): Promise<boolean>;                  // dscacheutil + killall -HUP mDNSResponder

// certs.ts
export const CA_COMMON_NAME = "localhost-aliases Local CA";
export function caExists(): boolean;
export async function ensureCA(): Promise<{ certPath: string; keyPath: string; created: boolean }>;
export function buildSans(hostnames: string[]): string[];            // dedup + localhost + 127.0.0.1 + ::1
export async function issueLeaf(hostnames: string[]): Promise<{ cert: string; key: string }>; // PEM strings
export async function isCATrusted(): Promise<boolean>;
export function trustCommand(): string;                              // sudo one-liner shown in the UI

// helper-client.ts
export type HelperResult<T> = { ok: true; data: T } | { ok: false; error: string; code: "unreachable" | "error" };
export async function helperStatus(): Promise<HelperResult<HelperStatus>>;
export async function helperApply(req: ApplyRequest): Promise<HelperResult<ApplyResponse>>;
export async function helperAvailability(): Promise<HelperUnavailable>;   // never throws
export function buildRoutes(config: Config): Route[];                     // enabled aliases only
export function buildApplyRequest(config: Config, tls: { cert: string; key: string } | null): ApplyRequest;

// workspace.ts
export async function readWorkspace(dir: string): Promise<WorkspaceFile | null>;
export async function writeWorkspace(dir: string, file: WorkspaceFile): Promise<void>;
export async function mergeWorkspaceAliases(dir: string, entries: WorkspaceAliasEntry[]): Promise<WorkspaceFile>;
export function workspacePath(dir: string): string;

// mcp-install.ts
/** Throws when the MCP entrypoint cannot be found on disk; `LA_MCP_ENTRYPOINT` overrides the search. */
export function mcpServerSpec(): { command: string; args: string[]; env: Record<string, string> };
export function claudeSnippet(): string;                             // pretty JSON the user can paste
export function codexSnippet(): string;                              // TOML the user can paste
export function detectClients(): Promise<{ claude: McpClientState; codex: McpClientState }>;
export async function installMcp(client: McpClientId): Promise<{ ok: true; configPath: string; backupPath: string | null; snippet: string }>;
export function upsertCodexToml(existing: string, snippet: string): string;   // pure, unit-tested
export function upsertClaudeJson(existing: string): string;                   // pure, unit-tested

// probe.ts
export async function probePort(host: string, port: number, timeoutMs?: number): Promise<AliasStatus>;
export async function probeAll(aliases: Alias[], timeoutMs?: number): Promise<Map<string, AliasStatus>>; // keyed by alias id
export function toView(alias: Alias, config: Config, status: AliasStatus): AliasView;
```
