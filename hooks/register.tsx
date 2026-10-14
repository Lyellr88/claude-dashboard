import type { Register } from "claude-code"
import {
  activeParameters,
  buildCommand,
  defaultParameterSet,
  isRequired,
  parameterSets,
  parameterType,
  type ScriptEntry,
  type ScriptParameter,
  type ScriptValue,
  type ScriptValues
} from "./commands"

type CommandEntry = {
  name: string
  description: string
  source: "builtin" | "plugin" | "user" | "mcp"
  plugin?: string
}

type Preferences = {
  tab: "skills" | "scripts"
  collapsed: Record<string, boolean>
}

type DashboardState = {
  tab: "skills" | "scripts"
  collapsed: Record<string, boolean>
  projectPath: string
  projectName: string
  commands: CommandEntry[]
  commandsError: string
  scripts: ScriptEntry[]
  scriptsError: string
  scriptsLoading: boolean
  query: string
  path: { script?: string; set?: string; flag?: string }
  values: Record<string, ScriptValues>
  draft: string
  pendingPrompt?: string
  exampleCommand?: string
}

const PANE_ID = "dashboard"
const STATE_KEY = "dashboard.session."
const PREFS_KEY = "dashboard.preferences"
const CACHE_KEY = "dashboard.script-cache."
const SCRIPT_EXTENSIONS = [".ps1", ".mjs", ".js", ".py", ".sh"]

function defaultState(): DashboardState {
  return {
    tab: "skills",
    collapsed: { builtin: true },
    projectPath: "",
    projectName: "current project",
    commands: [],
    commandsError: "",
    scripts: [],
    scriptsError: "",
    scriptsLoading: true,
    query: "",
    path: {},
    values: {},
    draft: "",
    pendingPrompt: undefined,
    exampleCommand: undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function normalizePreferences(value: unknown): Preferences {
  if (!isRecord(value)) return { tab: "skills", collapsed: { builtin: true } }
  const tab = value.tab === "scripts" ? "scripts" : "skills"
  const collapsed = isRecord(value.collapsed) ? value.collapsed as Record<string, boolean> : {}
  return { tab, collapsed: { builtin: true, ...collapsed } }
}

function normalizeState(value: unknown): DashboardState {
  const base = defaultState()
  if (!isRecord(value)) return base
  const path = isRecord(value.path) ? value.path : {}
  return {
    ...base,
    projectPath: typeof value.projectPath === "string" ? value.projectPath : base.projectPath,
    projectName: typeof value.projectName === "string" ? value.projectName : base.projectName,
    commands: Array.isArray(value.commands) ? value.commands as CommandEntry[] : [],
    commandsError: typeof value.commandsError === "string" ? value.commandsError : "",
    scripts: Array.isArray(value.scripts) ? value.scripts as ScriptEntry[] : [],
    scriptsError: typeof value.scriptsError === "string" ? value.scriptsError : "",
    scriptsLoading: value.scriptsLoading === true,
    query: typeof value.query === "string" ? value.query : "",
    path: {
      script: typeof path.script === "string" ? path.script : undefined,
      set: typeof path.set === "string" ? path.set : undefined,
      flag: typeof path.flag === "string" ? path.flag : undefined
    },
    values: isRecord(value.values) ? value.values as Record<string, ScriptValues> : {},
    draft: typeof value.draft === "string" ? value.draft : "",
    pendingPrompt: typeof value.pendingPrompt === "string" ? value.pendingPrompt : undefined,
    exampleCommand: typeof value.exampleCommand === "string" ? value.exampleCommand : undefined
  }
}

async function readPreferences($: any): Promise<Preferences> {
  return normalizePreferences(await $.store.get(PREFS_KEY))
}

async function readState($: any): Promise<DashboardState> {
  const sessionId = await $.session.id()
  const stored = normalizeState(await $.store.get(STATE_KEY + sessionId))
  const preferences = await readPreferences($)
  return { ...stored, ...preferences }
}

async function writeState($: any, update: (state: DashboardState) => DashboardState, preferenceUpdate?: (preferences: Preferences) => Preferences): Promise<void> {
  const sessionId = await $.session.id()
  const state = await readState($)
  const next = update(state)
  const preferences = preferenceUpdate ? preferenceUpdate(await readPreferences($)) : undefined
  if (preferences) {
    await $.store.set(PREFS_KEY, preferences)
    next.tab = preferences.tab
    next.collapsed = preferences.collapsed
  }
  await $.store.set(STATE_KEY + sessionId, next)
  $.ui.invalidate("ui.render")
}

function shortPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "")
  const pieces = normalized.split("/")
  return pieces[pieces.length - 1] || path
}

function commandGroup(source: string): string {
  if (source === "user") return "user"
  if (source === "plugin") return "plugin"
  if (source === "mcp") return "mcp"
  return "builtin"
}

function commandGroupLabel(group: string): string {
  if (group === "user") return "Your skills"
  if (group === "plugin") return "Plugins"
  if (group === "mcp") return "MCP"
  return "Built in"
}

function truncate(text: string, width: number): string {
  const value = text.replace(/\s+/g, " ").trim()
  if (width < 8 || value.length <= width) return value
  return value.slice(0, width - 1) + "…"
}

function currentScript(state: DashboardState): ScriptEntry | undefined {
  return state.scripts.find(entry => entry.name === state.path.script)
}

function currentValues(state: DashboardState): ScriptValues {
  if (!state.path.script) return {}
  return state.values[state.path.script] ?? {}
}

function selectedSet(entry: ScriptEntry, state: DashboardState): string | undefined {
  return state.path.set ?? defaultParameterSet(entry)
}

function commandPreview(entry: ScriptEntry, state: DashboardState): { text: string; missing: string[] } {
  if (state.exampleCommand !== undefined) return { text: state.exampleCommand, missing: [] }
  return buildCommand(entry, selectedSet(entry, state), currentValues(state))
}

function setValue(state: DashboardState, scriptName: string, parameterName: string, value: ScriptValue | undefined): DashboardState {
  const scriptValues = { ...(state.values[scriptName] ?? {}) }
  if (value === undefined) delete scriptValues[parameterName]
  else scriptValues[parameterName] = value
  return { ...state, values: { ...state.values, [scriptName]: scriptValues } }
}

function saveValue($: any, scriptName: string, parameterName: string, value: ScriptValue | undefined): Promise<void> {
  return writeState($, state => ({
    ...setValue(state, scriptName, parameterName, value),
    path: { ...state.path, flag: undefined },
    draft: "",
    exampleCommand: undefined
  }))
}

function filterCommands(commands: CommandEntry[], query: string): CommandEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return commands
  return commands.filter(command =>
    command.name.toLowerCase().includes(needle) ||
    command.description.toLowerCase().includes(needle) ||
    (command.plugin ?? "").toLowerCase().includes(needle)
  )
}

function buildEntryList(files: { name: string; size: number; mtimeMs?: number }[]): { signature: string; names: string[] } {
  const allowed = files
    .filter(file => SCRIPT_EXTENSIONS.some(extension => file.name.toLowerCase().endsWith(extension)))
    .sort((a, b) => a.name.localeCompare(b.name))
  const signature = allowed.map(file => file.name + ":" + file.size + ":" + (file.mtimeMs ?? "")).join("|")
  return { signature, names: allowed.map(file => file.name) }
}

async function listScriptFiles($: any): Promise<{ signature: string; names: string[]; exists: boolean }> {
  try {
    const entries = await $.fs.list("scripts")
    const files = entries.filter((entry: any) => entry.kind === "file")
    const stats = await Promise.all(files.map(async (file: any) => {
      try {
        const stat = await $.fs.stat("scripts/" + file.name)
        return { name: file.name, size: stat.size, mtimeMs: stat.mtimeMs }
      } catch {
        return { name: file.name, size: file.size }
      }
    }))
    const list = buildEntryList(stats)
    return { ...list, exists: true }
  } catch {
    return { signature: "", names: [], exists: false }
  }
}

function genericScriptEntries(names: string[], message: string): ScriptEntry[] {
  return names.map(name => ({
    name,
    kind: name.split(".").pop()?.toLowerCase() ?? "",
    synopsis: "",
    description: "",
    examples: [],
    sets: [],
    params: [],
    error: message
  }))
}

async function describeScripts($: any, names: string[], cwd: string): Promise<{ entries: ScriptEntry[]; error: string }> {
  if (names.length === 0) return { entries: [], error: "" }
  const args = ["-NoProfile", "-File", $.plugin.root + "/bin/describe-scripts.ps1", "-Dir", "scripts"]
  const attempts: string[][] = [["pwsh", ...args], ["powershell.exe", ...args]]
  let failure = ""
  for (const argv of attempts) {
    try {
      const result = await $.process.run(argv, { cwd })
      if (result.exitCode !== 0) {
        failure = result.stderr || "PowerShell could not read script metadata."
        continue
      }
      const parsed = JSON.parse(result.stdout)
      const entries = Array.isArray(parsed) ? parsed : parsed.entries
      if (!Array.isArray(entries)) throw new Error("The script describer returned an unexpected result.")
      return { entries: entries as ScriptEntry[], error: "" }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
  }
  return {
    entries: genericScriptEntries(names, "Parameter details unavailable."),
    error: failure || "PowerShell is not installed. Script names are still available."
  }
}

async function refreshDashboard($: any, force: boolean): Promise<void> {
  const cwd = await $.session.cwd()
  const files = await listScriptFiles($)
  let commands: CommandEntry[] = []
  let commandsError = ""
  try {
    commands = (await $.command.list())
      .filter((command: CommandEntry) => command.name !== "dash")
      .map((command: CommandEntry) => ({
        name: command.name,
        description: command.description ?? "",
        source: command.source,
        plugin: command.plugin
      }))
  } catch (error) {
    commandsError = error instanceof Error ? error.message : String(error)
  }

  const scriptCacheKey = CACHE_KEY + encodeURIComponent(cwd)
  const cached = await $.store.get(scriptCacheKey)
  let scripts = genericScriptEntries(files.names, "")
  let scriptsError = ""
  if (!files.exists) {
    scripts = []
    scriptsError = "This project has no scripts folder."
  } else if (files.names.length === 0) {
    scriptsError = "No supported scripts were found in scripts/."
  } else if (!force && isRecord(cached) && cached.signature === files.signature && Array.isArray(cached.entries)) {
    scripts = cached.entries as ScriptEntry[]
  } else {
    const described = await describeScripts($, files.names, cwd)
    scripts = described.entries
    scriptsError = described.error
    if (!described.error) {
      await $.store.set(scriptCacheKey, { signature: files.signature, entries: scripts })
    }
  }

  const sessionId = await $.session.id()
  const state = await readState($)
  const sameProject = state.projectPath === cwd
  const next: DashboardState = {
    ...state,
    projectPath: cwd,
    projectName: shortPath(cwd),
    commands,
    commandsError,
    scripts,
    scriptsError,
    scriptsLoading: false,
    path: sameProject ? state.path : {},
    values: sameProject ? state.values : {},
    draft: ""
  }
  await $.store.set(STATE_KEY + sessionId, next)
  $.ui.invalidate("ui.render")
}

async function fillPrompt($: any, command: CommandEntry, choice?: "replace" | "append"): Promise<void> {
  const prompt = await $.prompt.read()
  const hasText = prompt.text.trim().length > 0
  if (hasText && !choice) {
    await writeState($, state => ({ ...state, pendingPrompt: command.name }))
    return
  }
  const mode: "replace" | "append" = hasText ? choice! : "replace"
  const prefix = mode === "append" && prompt.text && !/\s$/.test(prompt.text) ? "\n" : ""
  const text = prefix + "/" + command.name + " "
  const result = await $.prompt.fill({ text, mode })
  await writeState($, state => ({ ...state, pendingPrompt: undefined }))
  const action = mode === "replace" ? "replaced the prompt with" : "added to the prompt"
  $.ui.toast(result.isFilled ? "/" + command.name + " " + action + "." : "The prompt box is not available.")
}

async function copyToClipboard($: any, text: string): Promise<boolean> {
  const powershellCommand = "Set-Clipboard -Value ([Console]::In.ReadToEnd())"
  const attempts: string[][] = [
    ["pwsh", "-NoProfile", "-Command", powershellCommand],
    ["powershell.exe", "-NoProfile", "-Command", powershellCommand],
    ["pbcopy"],
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"]
  ]
  for (const argv of attempts) {
    try {
      const result = await $.process.run(argv, { stdin: text })
      if (result.exitCode === 0) return true
    } catch {
      continue
    }
  }
  return false
}

async function copyCommand($: any, state: DashboardState): Promise<void> {
  const entry = currentScript(state)
  if (!entry) return
  const result = commandPreview(entry, state)
  const copied = await copyToClipboard($, result.text)
  if (!copied) {
    $.ui.toast("Clipboard access failed. Use Fill prompt or copy the preview manually.")
    return
  }
  $.ui.toast(result.missing.length ? "Copied. Fill required: " + result.missing.join(", ") : "Command copied.")
}

async function fillCommand($: any, state: DashboardState): Promise<void> {
  const entry = currentScript(state)
  if (!entry) return
  const result = commandPreview(entry, state)
  const prompt = await $.prompt.read()
  const prefix = prompt.text && !/\s$/.test(prompt.text) ? "\n" : ""
  const filled = await $.prompt.fill({ text: prefix + result.text, mode: "append" })
  const message = result.missing.length ? "Missing " + result.missing.join(", ") + "." : "Command added to the prompt."
  $.ui.toast(filled.isFilled ? message : "The prompt box is not available. " + message)
}

function renderBreadcrumb($: any, Box: any, Text: any, Button: any, state: DashboardState): any {
  const crumbs = [<Button key="crumb-scripts" label="Scripts" plain onPress={() => writeState($, current => ({ ...current, path: {}, exampleCommand: undefined }))} />]
  if (state.path.script) {
    crumbs.push(<Text key="crumb-sep-1" dimColor> / </Text>)
    crumbs.push(<Button key="crumb-script" label={state.path.script} plain onPress={() => writeState($, current => ({ ...current, path: { script: current.path.script }, exampleCommand: undefined }))} />)
  }
  if (state.path.set) {
    crumbs.push(<Text key="crumb-sep-2" dimColor> / </Text>)
    crumbs.push(<Button key="crumb-set" label={state.path.set} plain onPress={() => writeState($, current => ({ ...current, path: { script: current.path.script, set: current.path.set }, exampleCommand: undefined }))} />)
  }
  if (state.path.flag) {
    crumbs.push(<Text key="crumb-sep-3" dimColor> / </Text>)
    crumbs.push(<Text key="crumb-current" color="cyan">{state.path.flag}</Text>)
  }
  return <Box flexDirection="row" marginBottom={1}>{crumbs}</Box>
}

function renderScriptList($: any, Box: any, Text: any, Button: any, state: DashboardState, width: number): any {
  if (state.scriptsLoading) return <Text dimColor>Reading scripts and PowerShell parameter metadata…</Text>
  if (state.scripts.length === 0) {
    return <Box><Text color={state.scriptsError ? "yellow" : "gray"}>{state.scriptsError || "No supported scripts were found in scripts/."}</Text></Box>
  }

  return <Box flexDirection="column">
    <Text dimColor>{state.scripts.length} scripts in {state.projectName}/scripts</Text>
    {state.scripts.map(entry => {
      const flagCount = entry.params.length
      const synopsis = entry.error ? "Parameter details unavailable" : (entry.synopsis || "No synopsis provided")
      return <Box key={"script-card-" + entry.name} borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1} hover={{ borderColor: "cyan" }}>
        <Box flexDirection="row" justifyContent="space-between">
          <Button key={"script-" + entry.name} label={entry.name} plain onPress={() => writeState($, current => ({
            ...current,
            path: { script: entry.name, set: defaultParameterSet(entry), flag: undefined },
            draft: "",
            exampleCommand: undefined
          }))} />
          <Text color={entry.error ? "yellow" : "cyan"}>{entry.error ? "metadata" : flagCount + " flags"}</Text>
        </Box>
        <Text dimColor>{truncate(synopsis, Math.max(10, width - 8))}</Text>
        {entry.error ? <Text color="yellow">{entry.error}</Text> : null}
        {entry.warning ? <Text color="yellow">{entry.warning}</Text> : null}
      </Box>
    })}
  </Box>
}

function renderSkillGroups($: any, Box: any, Text: any, Button: any, Input: any, state: DashboardState, width: number): any {
  const filtered = filterCommands(state.commands, state.query)
  const groups = ["user", "plugin", "mcp", "builtin"]
  return <Box flexDirection="column">
    {Input ? <Input key="skill-filter" label="Filter" placeholder="Search skills and commands" value={state.query} submitLabel="filter" onInput={(value: string) => void writeState($, current => ({ ...current, query: value }))} onSubmit={(value: string) => void writeState($, current => ({ ...current, query: value }))} /> : <Text dimColor>Search is available on terminal and desktop.</Text>}
    {groups.map(group => {
      const rows = filtered.filter(command => commandGroup(command.source) === group)
      if (rows.length === 0 && state.query) return null
      const collapsed = state.collapsed[group] ?? (group === "builtin")
      return <Box key={"group-" + group} flexDirection="column" marginTop={1}>
        <Button key={"group-toggle-" + group} label={(collapsed ? "+ " : "- ") + commandGroupLabel(group) + "  " + rows.length} plain onPress={() => {
          return writeState(
            $,
            current => current,
            preferences => ({ ...preferences, collapsed: { ...preferences.collapsed, [group]: !preferences.collapsed[group] } })
          )
        }} />
        {!collapsed ? rows.map(command => <Box key={"skill-row-" + command.name} flexDirection="column" paddingLeft={1} marginBottom={1} hover={{ backgroundColor: "gray" }}>
          <Button key={"skill-" + command.name} label={"/" + command.name} plain onPress={() => fillPrompt($, command)} />
          {state.pendingPrompt === command.name ? <Box key={"prompt-choice-" + command.name} flexDirection="row">
            <Text dimColor>Prompt already has text:</Text>
            <Button key={"prompt-replace-" + command.name} label="Replace" plain onPress={() => fillPrompt($, command, "replace")} />
            <Button key={"prompt-append-" + command.name} label="Add to end" plain onPress={() => fillPrompt($, command, "append")} />
            <Button key={"prompt-cancel-" + command.name} label="Cancel" dimColor onPress={() => writeState($, current => ({ ...current, pendingPrompt: undefined }))} />
          </Box> : null}
          <Text dimColor>{truncate(command.description || command.plugin || "No description", Math.max(10, width - 8))}{command.source === "plugin" && command.plugin ? "  · " + command.plugin : ""}</Text>
        </Box>) : null}
      </Box>
    })}
    {filtered.length === 0 ? <Text color="yellow">No commands match: {state.query}</Text> : null}
    {state.commandsError ? <Text color="yellow">{state.commandsError}</Text> : null}
  </Box>
}

function renderScriptDetail($: any, Box: any, Text: any, Button: any, Input: any, state: DashboardState, width: number): any {
  const entry = currentScript(state)
  if (!entry) return renderScriptList($, Box, Text, Button, state, width)
  const setName = selectedSet(entry, state)
  const sets = parameterSets(entry)
  const parameters = activeParameters(entry, setName)
  const parameterValues = currentValues(state)
  const selectedFlag = state.path.flag ? parameters.find(parameter => parameter.name === state.path.flag) : undefined
  const command = commandPreview(entry, state)
  const missing = command.missing.length > 0
  return <Box flexDirection="column">
    {renderBreadcrumb($, Box, Text, Button, state)}
    <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text bold>{entry.name}</Text>
      <Text dimColor>{entry.synopsis || "No synopsis provided."}</Text>
      {entry.description ? <Text dimColor>{truncate(entry.description, Math.max(10, width - 6))}</Text> : null}
      {entry.error ? <Text color="yellow">{entry.error}</Text> : null}
      {entry.warning ? <Text color="yellow">{entry.warning}</Text> : null}
      {entry.examples.length ? <Box flexDirection="column" marginTop={1}>
        <Text color="cyan">Examples</Text>
        {entry.examples.map((example, index) => <Button key={"example-" + index} label={truncate(example, Math.max(10, width - 8))} plain onPress={() => writeState($, current => ({
          ...current,
          path: { script: entry.name, set: selectedSet(entry, current), flag: undefined },
          values: { ...current.values, [entry.name]: {} },
          draft: "",
          exampleCommand: example
        }))} />)}
      </Box> : null}
    </Box>
    {sets.length > 1 ? <Box flexDirection="column" marginBottom={1}>
      <Text color="yellow">Choose a parameter set</Text>
      <Box flexDirection="row">
        {sets.map(set => <Button key={"set-" + set.name} label={(setName === set.name ? "[x] " : "[ ] ") + set.name} plain onPress={() => writeState($, current => ({ ...current, path: { script: entry.name, set: set.name }, exampleCommand: undefined }))} />)}
      </Box>
    </Box> : null}
    {selectedFlag ? <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text bold>-{selectedFlag.name}  <Text dimColor>{parameterType(selectedFlag)}</Text></Text>
      {selectedFlag.help ? <Text dimColor>{selectedFlag.help}</Text> : null}
      {parameterType(selectedFlag) === "choice" ? <Box flexDirection="row" flexWrap="wrap">
        {selectedFlag.choices.map(choice => <Button key={"choice-" + choice} label={(parameterValues[selectedFlag.name] === choice ? "[x] " : "[ ] ") + choice} plain onPress={() => saveValue($, entry.name, selectedFlag.name, choice)} />)}
      </Box> : parameterType(selectedFlag) === "switch" ? <Button key="switch-toggle" label={parameterValues[selectedFlag.name] === true ? "On" : "Off"} plain onPress={() => saveValue($, entry.name, selectedFlag.name, parameterValues[selectedFlag.name] === true ? undefined : true)} /> : <Box flexDirection="column">
        {Input ? <Input key={"value-" + selectedFlag.name} label={parameterType(selectedFlag) === "list" ? "Values (comma separated)" : "Value"} placeholder={parameterType(selectedFlag)} value={state.draft} submitLabel="set" autoFocus onInput={(value: string) => void writeState($, current => ({ ...current, draft: value }))} onSubmit={(value: string) => {
          const nextValue = parameterType(selectedFlag) === "list" ? value.split(",").map(item => item.trim()).filter(Boolean).join(",") : value
          saveValue($, entry.name, selectedFlag.name, nextValue)
        }} /> : <Text color="yellow">Text entry is available on terminal and desktop.</Text>}
      </Box>}
    </Box> : null}
    <Text bold color="cyan">Options</Text>
    {parameters.length === 0 ? <Text dimColor>This script has no configurable options.</Text> : parameters.map((parameter: ScriptParameter) => {
      const value = parameterValues[parameter.name]
      const required = isRequired(parameter, setName)
      const selected = state.path.flag === parameter.name
      const valueLabel = value === true || (required && parameterType(parameter) === "switch") ? "on" : typeof value === "string" ? value : required ? "required" : parameter.hasDefault ? "has a default" : parameterType(parameter)
      return <Box key={"parameter-row-" + parameter.name} flexDirection="row" justifyContent="space-between" hover={{ backgroundColor: "gray" }}>
        <Button key={"flag-" + parameter.name} label={"-" + parameter.name + (selected ? "  >" : "")} plain onPress={() => {
          if (parameterType(parameter) === "switch") {
            return saveValue($, entry.name, parameter.name, value === true ? undefined : true)
          } else {
            return writeState($, current => ({ ...current, path: { ...current.path, flag: parameter.name }, draft: typeof value === "string" ? value : "", exampleCommand: undefined }))
          }
        }} />
        <Box flexDirection="row">
          <Text color={required && value === undefined && parameterType(parameter) !== "switch" ? "yellow" : value === undefined && !required ? (parameter.hasDefault ? "cyan" : "gray") : "green"}>{valueLabel}</Text>
          {value !== undefined ? <Button key={"clear-flag-" + parameter.name} label="×" plain onPress={() => saveValue($, entry.name, parameter.name, undefined)} /> : null}
        </Box>
      </Box>
    })}
    <Box borderStyle="round" borderColor={missing ? "yellow" : "gray"} paddingX={1} marginTop={1}>
      <Text bold>Command preview</Text>
      <Text key="command-preview" color={missing ? "yellow" : "white"}>{command.text}</Text>
      {missing ? <Text color="yellow">Required: {command.missing.join(", ")}</Text> : null}
    </Box>
    <Box flexDirection="row" marginTop={1}>
      <Button key="copy-command" label="Copy command" plain onPress={() => copyCommand($, state)} />
      <Button key="fill-command" label="Fill prompt" plain onPress={() => fillCommand($, state)} />
      <Button key="clear-command" label="Clear options" dimColor onPress={() => writeState($, current => ({
        ...current,
        values: { ...current.values, [entry.name]: {} },
        path: { script: entry.name, set: setName },
        exampleCommand: undefined
      }))} />
    </Box>
  </Box>
}

export const register: Register = on => {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "dash", description: "Open the skills and scripts dashboard." })
    return next(e)
  })

  on("command.run", { command: "dash" }, async $ => {
    const sessionId = await $.session.id()
    const state = await readState($)
    await $.store.set(STATE_KEY + sessionId, { ...state, scriptsLoading: true })
    await $.ui.open({ id: PANE_ID, title: "Dashboard", focus: true, closeOnEscape: true })
    await refreshDashboard($, false)
    return { text: "Dashboard opened." }
  })

  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const Input = ($.ui.resolve(e) as any).Input
    const state = await readState($)
    const width = Number((e.props as any).bodyColumns ?? 80)
    const content = state.tab === "scripts"
      ? <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
            <Text color="cyan" bold>PROJECT SCRIPTS</Text>
            <Button key="refresh-scripts" label="Refresh" plain onPress={() => {
              return writeState($, current => ({ ...current, scriptsLoading: true }))
                .then(() => refreshDashboard($, true))
                .catch(error => $.ui.toast(error instanceof Error ? error.message : String(error)))
            }} />
          </Box>
          {state.scriptsLoading ? <Text dimColor>Refreshing project scripts…</Text> : state.path.script ? renderScriptDetail($, Box, Text, Button, Input, state, width) : renderScriptList($, Box, Text, Button, state, width)}
          {state.scriptsError && state.scripts.length > 0 ? <Text color="yellow">{state.scriptsError}</Text> : null}
        </Box>
      : renderSkillGroups($, Box, Text, Button, Input, state, width)

    return <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text bold color="cyan">PROJECT DASHBOARD</Text>
        <Text dimColor>{state.projectName}</Text>
      </Box>
      <Box flexDirection="row" marginBottom={1}>
        <Button key="tab-skills" label={state.tab === "skills" ? "[ Skills ]" : "Skills"} plain onPress={() => writeState($, current => ({ ...current, query: "", pendingPrompt: undefined }), preferences => ({ ...preferences, tab: "skills" }))} />
        <Button key="tab-scripts" label={state.tab === "scripts" ? "[ Scripts ]" : "Scripts"} plain onPress={() => writeState($, current => ({ ...current, path: {}, exampleCommand: undefined, pendingPrompt: undefined }), preferences => ({ ...preferences, tab: "scripts" }))} />
      </Box>
      {content}
    </Box>
  })
}
