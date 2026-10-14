param([Parameter(Mandatory)] [string]$Dir)

$common = [System.Management.Automation.PSCmdlet]::CommonParameters + [System.Management.Automation.PSCmdlet]::OptionalCommonParameters
$files = Get-ChildItem -LiteralPath $Dir -File | Sort-Object Name
$entries = foreach ($file in $files) {
    $entry = [ordered]@{
        name = $file.Name
        kind = $file.Extension.TrimStart('.').ToLowerInvariant()
        synopsis = ''
        description = ''
        examples = @()
        sets = @()
        params = @()
    }

    if ($file.Extension -ne '.ps1') {
        $comment = Get-Content -LiteralPath $file.FullName -TotalCount 5 |
            Where-Object { $_ -match '^\s*(//|#)(?!!)' } |
            Select-Object -First 1
        if ($comment) {
            $entry.synopsis = ($comment -replace '^\s*(//|#)\s*', '').Trim()
        }
        $entry
        continue
    }

    $tokens = $null
    $parseErrors = $null
    $scriptAst = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
    $defaultedParameters = @()
    if ($scriptAst.ParamBlock) {
        foreach ($parameterAst in $scriptAst.ParamBlock.Parameters) {
            if ($null -ne $parameterAst.DefaultValue) {
                $defaultedParameters += $parameterAst.Name.VariablePath.UserPath
            }
        }
    }

    $source = Get-Content -LiteralPath $file.FullName -Raw
    if ($scriptAst.DynamicParamBlock) {
        $extent = $scriptAst.DynamicParamBlock.Extent
        $dynamicText = $source.Substring($extent.StartOffset, $extent.EndOffset - $extent.StartOffset)
        $safeDynamicText = [regex]::Replace($dynamicText, '[^\r\n]', ' ')
        $source = $source.Substring(0, $extent.StartOffset) + $safeDynamicText + $source.Substring($extent.EndOffset)
        $entry.warning = 'Dynamic parameters were not evaluated; only static options are shown.'
    }

    $helpPath = Join-Path ([IO.Path]::GetTempPath()) ("claude-dashboard-" + [guid]::NewGuid().ToString('N') + ".ps1")
    try {
        $helpSource = $source -replace '^#![^\r\n]*\r?\n', ''
        Set-Content -LiteralPath $helpPath -Value $helpSource -NoNewline
        $command = Get-Command -Name $helpPath -ErrorAction Stop
        $help = Get-Help -Name $helpPath -Full -ErrorAction SilentlyContinue
    } catch {
        $entry.error = "$($_.Exception.Message)"
        $entry
        continue
    } finally {
        Remove-Item -LiteralPath $helpPath -ErrorAction SilentlyContinue
    }

    if ($help -and $help -isnot [string]) {
        $entry.synopsis = "$($help.Synopsis)".Trim()
        $entry.description = (($help.description | ForEach-Object { $_.Text }) -join [Environment]::NewLine).Trim()
        $entry.examples = @(
            $help.examples.example |
                ForEach-Object { "$($_.code)" -split "\r?\n" } |
                ForEach-Object { $_.Trim() } |
                Where-Object { $_ }
        )
    }

    $entry.sets = @(
        $command.ParameterSets |
            ForEach-Object { [ordered]@{ name = $_.Name; isDefault = $_.IsDefault } }
    )
    $entry.params = @(
        foreach ($parameter in $command.Parameters.Values) {
            if ($common -contains $parameter.Name) { continue }
            $validateSet = $parameter.Attributes |
                Where-Object { $_ -is [System.Management.Automation.ValidateSetAttribute] } |
                Select-Object -First 1
            $choices = [string[]]@()
            if ($validateSet) { $choices = [string[]]$validateSet.ValidValues }
            $attributes = @(
                $parameter.Attributes |
                    Where-Object { $_ -is [System.Management.Automation.ParameterAttribute] }
            )
            $parameterHelp = ''
            if ($help -and $help -isnot [string]) {
                $parameterHelp = (
                    $help.parameters.parameter |
                        Where-Object name -eq $parameter.Name |
                        ForEach-Object { ($_.description | ForEach-Object Text) -join ' ' }
                ) -join ' '
            }

            [ordered]@{
                name = $parameter.Name
                type = if ($parameter.SwitchParameter) { 'switch' } else { $parameter.ParameterType.Name }
                choices = $choices
                hasDefault = $defaultedParameters -contains $parameter.Name
                sets = @(
                    $attributes |
                        ForEach-Object {
                            [ordered]@{
                                set = $_.ParameterSetName
                                mandatory = $_.Mandatory
                                position = if ($_.Position -ge 0) { $_.Position } else { $null }
                            }
                        }
                )
                help = "$parameterHelp".Trim()
            }
        }
    )
    $entry
}

@{ entries = @($entries) } | ConvertTo-Json -Depth 10 -Compress
