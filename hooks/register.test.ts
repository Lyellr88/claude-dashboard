import { describe, expect, test, tier } from "claude-code/testing"
import { buildCommand, type ScriptEntry } from "./commands"

tier("user")

const HOLD_EDITOR: ScriptEntry = {
  name: "hold-editor.ps1",
  kind: "ps1",
  synopsis: "Opens the in-game pose editor.",
  description: "Opens the hold and reload pose editor.",
  examples: ["pwsh scripts/hold-editor.ps1 -Mode hold"],
  sets: [{ name: "__AllParameterSets", isDefault: true }],
  params: [{
    name: "Mode",
    type: "String",
    choices: ["hold", "reload", "empty"],
    sets: [{ set: "__AllParameterSets", mandatory: false, position: 0 }],
    help: "Select the editor mode."
  }]
}

const RELOAD_EDIT: ScriptEntry = {
  name: "reload-edit.ps1",
  kind: "ps1",
  synopsis: "Edit reload clips.",
  description: "",
  examples: [],
  sets: [
    { name: "Info", isDefault: false },
    { name: "Edit", isDefault: true }
  ],
  params: [
    { name: "Info", type: "switch", choices: [], sets: [{ set: "Info", mandatory: true, position: null }], help: "" },
    { name: "Action", type: "String", choices: ["open", "save"], sets: [{ set: "Edit", mandatory: true, position: null }], help: "" },
    { name: "Gun", type: "String", choices: ["gewehr43", "kar98k"], sets: [{ set: "Edit", mandatory: true, position: null }], help: "" },
    { name: "Hold", type: "switch", choices: [], sets: [{ set: "Edit", mandatory: false, position: null }, { set: "__AllParameterSets", mandatory: false, position: null }], help: "" },
    { name: "Harness", type: "String", choices: [], hasDefault: true, sets: [{ set: "__AllParameterSets", mandatory: false, position: null }], help: "" }
  ]
}

describe("dashboard command builder", () => {
  test("builds a named command and quotes PowerShell values", () => {
    const result = buildCommand(
      { ...HOLD_EDITOR, params: [{ ...HOLD_EDITOR.params[0], choices: [] }] },
      undefined,
      { Mode: "reload frame" }
    )
    expect(result.text).toBe("pwsh scripts/hold-editor.ps1 -Mode 'reload frame'")
    expect(result.missing).toEqual([])
  })

  test("shows unset required parameters in the command preview", () => {
    const result = buildCommand(RELOAD_EDIT, "Edit", {})
    expect(result.text).toBe("pwsh scripts/reload-edit.ps1 -Action <required> -Gun <required>")
    expect(result.missing).toEqual(["-Action", "-Gun"])
  })

  test("includes shared and selected-set flags only", () => {
    const edit = buildCommand(RELOAD_EDIT, "Edit", { Action: "open", Gun: "gewehr43", Hold: true })
    const info = buildCommand(RELOAD_EDIT, "Info", {})
    expect(edit.text).toBe("pwsh scripts/reload-edit.ps1 -Action open -Gun gewehr43 -Hold")
    expect(info.text).toBe("pwsh scripts/reload-edit.ps1 -Info")
    expect(info.missing).toEqual([])
  })

  test("formats a named list parameter as comma separated input", () => {
    const unwrap: ScriptEntry = {
      name: "unwrap-md.ps1",
      kind: "ps1",
      synopsis: "",
      description: "",
      examples: [],
      sets: [{ name: "__AllParameterSets", isDefault: true }],
      params: [{
        name: "Paths",
        type: "String[]",
        choices: [],
        sets: [{ set: "__AllParameterSets", mandatory: true, position: 0 }],
        help: ""
      }]
    }
    const result = buildCommand(unwrap, undefined, { Paths: "docs,README.md" })
    expect(result.text).toBe("pwsh scripts/unwrap-md.ps1 -Paths docs,README.md")
  })
})

describe("dashboard pane", () => {
  test("supports skills and script drill-down on terminal and desktop", async ($, on) => {
    const pluginState = {
      projectPath: "C:/games/demo",
      projectName: "demo",
      commands: [
        { name: "review", description: "Review changes", source: "user" },
        { name: "format", description: "Format source files", source: "plugin", plugin: "tools" },
        { name: "inspect", description: "Inspect project data", source: "mcp" },
        { name: "help", description: "Show built in help", source: "builtin" }
      ],
      commandsError: "",
      scripts: [HOLD_EDITOR, RELOAD_EDIT],
      scriptsError: "",
      scriptsLoading: false,
      query: "",
      path: {},
      values: {},
      draft: ""
    }
    let preferences: any = { tab: "skills", collapsed: { builtin: true } }
    let savedPrompt = ""
    let currentPrompt = ""
    const promptFills: { text: string; mode: string }[] = []
    const processCalls: { argv: readonly string[]; stdin?: string }[] = []
    const stored: Record<string, unknown> = {}

    on("session.id", () => ({ value: "session-1" }))
    on("store.get", ($, e) => ({
      value: e.key === "dashboard.session.session-1"
        ? stored[e.key] ?? pluginState
        : e.key === "dashboard.preferences" ? preferences : stored[e.key]
    }))
    on("store.set", ($, e) => {
      stored[e.key] = e.value
      if (e.key === "dashboard.preferences") preferences = e.value
      return { value: undefined }
    })
    on("ui.toast", () => ({ value: undefined }))
    on("prompt.read", () => ({ value: { text: currentPrompt, cursor: currentPrompt.length } }))
    on("prompt.fill", ($, e) => {
      promptFills.push({ text: e.text, mode: e.mode })
      currentPrompt = e.mode === "replace" ? e.text : currentPrompt + e.text
      savedPrompt = currentPrompt
      return { isFilled: true, text: e.text, cursor: e.text.length }
    })
    on("process.run", ($, e) => {
      processCalls.push({ argv: e.argv, stdin: e.init?.stdin })
      return { value: { exitCode: 0, stdout: "", stderr: "" } }
    })

    for (const surface of ["terminal", "desktop"] as const) {
      preferences = { tab: "skills", collapsed: { builtin: true } }
      stored["dashboard.session.session-1"] = pluginState
      currentPrompt = ""
      savedPrompt = ""
      promptFills.length = 0
      const ui = await $.ui.mount({
        plugin: "project-dashboard",
        surface,
        component: "Pane",
        requestId: "dashboard",
        props: {
          title: "Dashboard",
          isFocused: true,
          bodyColumns: 90,
          placement: "inline",
          scroll: { offset: 0, bodyRows: 30 },
          view: {}
        }
      })
      expect((await ui.find({ key: "skill-review" }))?.text).toBe("/review")
      expect(await ui.find({ key: "group-toggle-user" })).toBeDefined()
      expect(await ui.find({ key: "group-toggle-plugin" })).toBeDefined()
      expect(await ui.find({ key: "group-toggle-mcp" })).toBeDefined()
      expect(await ui.find({ key: "group-toggle-builtin" })).toBeDefined()
      expect(await ui.find({ key: "run-review" })).toBeUndefined()
      await ui.press({ key: "skill-review" })
      expect(savedPrompt).toBe("/review ")
      expect(promptFills.at(-1)).toEqual({ text: "/review ", mode: "replace" })
      currentPrompt = "keep this request"
      await ui.press({ key: "skill-review" })
      await ui.redraw()
      expect(await ui.find({ key: "prompt-replace-review" })).toBeDefined()
      expect(await ui.find({ key: "prompt-append-review" })).toBeDefined()
      await ui.press({ key: "prompt-append-review" })
      expect(savedPrompt).toBe("keep this request\n/review ")
      expect(promptFills.at(-1)?.mode).toBe("append")
      currentPrompt = "replace this request"
      await ui.press({ key: "skill-review" })
      await ui.redraw()
      await ui.press({ key: "prompt-replace-review" })
      expect(savedPrompt).toBe("/review ")
      expect(promptFills.at(-1)?.mode).toBe("replace")
      await ui.input({ key: "skill-filter", text: "review", kind: "change" })
      expect(await ui.find({ key: "skill-format" })).toBeUndefined()
      await ui.input({ key: "skill-filter", text: "", kind: "change" })
      await ui.press({ key: "tab-scripts" })
      await ui.redraw()
      expect((stored["dashboard.session.session-1"] as any)?.tab).toBe("scripts")
      expect((await ui.find({ key: "script-hold-editor.ps1" }))?.text).toBe("hold-editor.ps1")
      await ui.press({ key: "script-hold-editor.ps1" })
      await ui.redraw()
      expect((stored["dashboard.session.session-1"] as any)?.path.script).toBe("hold-editor.ps1")
      await ui.press({ key: "example-0" })
      expect(JSON.stringify(await ui.drawn())).toContain("pwsh scripts/hold-editor.ps1 -Mode hold")
      await ui.press({ key: "copy-command" })
      expect(processCalls.at(-1)?.stdin).toBe("pwsh scripts/hold-editor.ps1 -Mode hold")
      await ui.press({ key: "flag-Mode" })
      await ui.redraw()
      expect((stored["dashboard.session.session-1"] as any)?.path.flag).toBe("Mode")
      await ui.press({ key: "choice-reload" })
      await ui.redraw()
      expect((stored["dashboard.session.session-1"] as any)?.values["hold-editor.ps1"].Mode).toBe("reload")
      expect(JSON.stringify(await ui.drawn())).toContain("pwsh scripts/hold-editor.ps1 -Mode reload")
      await ui.press({ key: "clear-flag-Mode" })
      expect((stored["dashboard.session.session-1"] as any)?.values["hold-editor.ps1"].Mode).toBeUndefined()
      expect(JSON.stringify(await ui.drawn())).toContain("pwsh scripts/hold-editor.ps1")
      await ui.press({ key: "flag-Mode" })
      await ui.press({ key: "choice-reload" })
      await ui.press({ key: "copy-command" })
      expect(processCalls.at(-1)?.argv[0]).toBe("pwsh")
      expect(processCalls.at(-1)?.stdin).toBe("pwsh scripts/hold-editor.ps1 -Mode reload")
      await ui.press({ key: "crumb-scripts" })
      await ui.redraw()
      await ui.press({ key: "script-reload-edit.ps1" })
      await ui.redraw()
      expect(JSON.stringify(await ui.drawn())).toContain("has a default")
      await ui.press({ key: "set-Info" })
      await ui.redraw()
      expect(await ui.find({ key: "flag-Action" })).toBeUndefined()
      expect(await ui.find({ key: "flag-Gun" })).toBeUndefined()
      expect(JSON.stringify(await ui.drawn())).toContain("pwsh scripts/reload-edit.ps1 -Info")
      await ui.press({ key: "set-Edit" })
      await ui.press({ key: "flag-Action" })
      await ui.press({ key: "choice-open" })
      await ui.press({ key: "flag-Gun" })
      await ui.press({ key: "choice-gewehr43" })
      await ui.press({ key: "flag-Hold" })
      expect(JSON.stringify(await ui.drawn())).toContain("pwsh scripts/reload-edit.ps1 -Action open -Gun gewehr43 -Hold")
      await ui.unmount()
    }
  })
})
