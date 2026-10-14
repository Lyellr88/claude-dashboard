export type ParameterSet = {
  set: string
  mandatory: boolean
  position: number | null
}

export type ScriptParameter = {
  name: string
  type: string
  choices: string[]
  sets: ParameterSet[]
  help: string
  hasDefault?: boolean
}

export type ScriptEntry = {
  name: string
  kind: string
  synopsis: string
  description: string
  examples: string[]
  sets: { name: string; isDefault: boolean }[]
  params: ScriptParameter[]
  error?: string
  warning?: string
}

export type ScriptValue = string | boolean
export type ScriptValues = Record<string, ScriptValue>

export function quotePowerShell(value: string): string {
  if (!/[\s\u0060$'";&|(){}<>]/.test(value)) return value
  return "'" + value.replace(/'/g, "''") + "'"
}

export function parameterType(parameter: ScriptParameter): "switch" | "choice" | "number" | "list" | "text" {
  if (parameter.type === "switch" || parameter.type === "SwitchParameter") return "switch"
  if (parameter.choices.length > 0) return "choice"
  if (/^(Int|UInt)\d*|^(Double|Single|Decimal)$/i.test(parameter.type)) return "number"
  if (parameter.type.endsWith("[]")) return "list"
  return "text"
}

export function activeParameters(entry: ScriptEntry, setName?: string): ScriptParameter[] {
  if (!setName || setName === "__AllParameterSets") return entry.params
  return entry.params.filter(parameter =>
    parameter.sets.length === 0 ||
    parameter.sets.some(set => set.set === "__AllParameterSets" || set.set === setName)
  )
}

export function isRequired(parameter: ScriptParameter, setName?: string): boolean {
  return parameter.sets.some(set =>
    set.mandatory && (set.set === "__AllParameterSets" || !setName || set.set === setName)
  )
}

export function parameterSets(entry: ScriptEntry): { name: string; isDefault: boolean }[] {
  return entry.sets.filter(set => set.name !== "__AllParameterSets")
}

export function defaultParameterSet(entry: ScriptEntry): string | undefined {
  const sets = parameterSets(entry)
  if (sets.length === 0) return undefined
  return (sets.find(set => set.isDefault) ?? sets[0]).name
}

export function buildCommand(entry: ScriptEntry, setName: string | undefined, values: ScriptValues): { text: string; missing: string[] } {
  const shellByKind: Record<string, string> = { ps1: "pwsh", mjs: "node", js: "node", py: "python", sh: "bash" }
  const shell = shellByKind[entry.kind] ?? "pwsh"
  const file = quotePowerShell("scripts/" + entry.name)
  const parts = [shell, file]
  const missing: string[] = []

  for (const parameter of activeParameters(entry, setName)) {
    const value = values[parameter.name]
    if (parameterType(parameter) === "switch") {
      if (value === true || isRequired(parameter, setName)) parts.push("-" + parameter.name)
      continue
    }
    if (typeof value === "string" && value.length > 0) {
      parts.push("-" + parameter.name, quotePowerShell(value))
    } else if (isRequired(parameter, setName)) {
      parts.push("-" + parameter.name, "<required>")
      missing.push("-" + parameter.name)
    }
  }

  return { text: parts.join(" "), missing }
}
