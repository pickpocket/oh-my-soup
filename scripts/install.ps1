#Requires -Version 5.1

<#
.SYNOPSIS
    Installs the prebuilt oms binary from the newest (or a pinned) GitHub release.

.DESCRIPTION
    Downloads the fastest oms binary this machine can run from the
    pickpocket/oh-my-soup release feed: the modern (AVX2) build first, falling
    back to the baseline build when the release predates the modern asset or
    the CPU cannot launch it. The binary's own smoke test is the capability
    probe - no CPUID guessing. The script then moves the binary into the
    install directory, installs its local GNU objdump dependency, adds that
    directory to the user PATH, and points oms at a bash shell when one exists.

    The release tag comes from the releases/latest HTTP redirect, not the GitHub
    REST API, so the script is immune to the API's 60-requests-per-hour
    unauthenticated rate limit. The download streams straight to disk through
    one HttpClient with no progress-bar overhead.

    Install directory precedence: OMS_INSTALL_DIR, PI_INSTALL_DIR, then
    %LOCALAPPDATA%\oms. A binary that is currently running is replaced by
    renaming the mapped image aside and moving the new file into place; stale
    renamed images are cleaned up on the next run.

.PARAMETER Ref
    Release tag to install, for example v17.2.13. Defaults to the newest release.

.EXAMPLE
    irm https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/scripts/install.ps1 | iex

.EXAMPLE
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/scripts/install.ps1))) -Ref v17.2.13

.INPUTS
    None.

.OUTPUTS
    None. Progress is written to the host; failures throw.

.NOTES
    Supports Windows PowerShell 5.1 and PowerShell 7 on Windows x64/arm64
    (x64 emulation). Never call exit: under the piped-iex install flow there is
    no script process, so exit would close the caller's terminal.
#>
[CmdletBinding(SupportsShouldProcess = $true, PositionalBinding = $false)]
param(
    [Parameter()]
    [ValidatePattern('^$|^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$Ref
)

function Write-OmsStep {
    # Installer UX is deliberately host-rendered: color and immediacy matter,
    # and the success stream must stay empty so `irm | iex` callers capture
    # nothing. Single sanctioned Write-Host site for the whole script.
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Display-only entry-point UX; the success stream stays pure.')]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Message,

        [Parameter()]
        [System.ConsoleColor]$Color
    )

    if ($PSBoundParameters.ContainsKey('Color')) {
        Write-Host -Object $Message -ForegroundColor $Color
        return
    }
    Write-Host -Object $Message
}

function Initialize-OmsNetwork {
    # Older Windows PowerShell 5.1 hosts default to SSL3/TLS1.0 and GitHub
    # rejects the handshake ("Could not create SSL/TLS secure channel").
    # OR-ing the flag in keeps any stronger protocol the session already has.
    # The System.Net.Http assembly load must happen here, before any function
    # whose attributes or bodies name those types is invoked: 5.1 does not
    # load the assembly by default and type literals resolve at call time.
    if ($PSVersionTable.PSEdition -ne 'Desktop') {
        return
    }
    $Current = [System.Net.ServicePointManager]::SecurityProtocol
    [System.Net.ServicePointManager]::SecurityProtocol = $Current -bor [System.Net.SecurityProtocolType]::Tls12
    # Assembly load only (no compilation); ~30 ms once per session.
    Add-Type -AssemblyName System.Net.Http
}

function New-OmsHttpClient {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Creates an in-memory HttpClient; no external state changes.')]
    [OutputType('System.Net.Http.HttpClient')]
    param(
        [Parameter(Mandatory)]
        [int]$TimeoutSeconds,

        [Parameter()]
        [switch]$AllowRedirect
    )

    $Handler = [System.Net.Http.HttpClientHandler]::new()
    $Handler.AllowAutoRedirect = [bool]$AllowRedirect
    $Client = [System.Net.Http.HttpClient]::new($Handler)
    $Client.Timeout = [timespan]::FromSeconds($TimeoutSeconds)
    $Client.DefaultRequestHeaders.UserAgent.ParseAdd('oms-installer')
    $Client
}

function Resolve-OmsReleaseTag {
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string]$Repo,

        [Parameter()]
        [AllowEmptyString()]
        [string]$Ref
    )

    if (-not [string]::IsNullOrWhiteSpace($Ref)) {
        return $Ref
    }

    # One ~300-byte HEAD against the releases/latest redirect replaces the
    # GitHub REST API call: no JSON payload to parse and no unauthenticated
    # 60-requests-per-hour rate limit (the 403s users saw were that limit).
    $LatestUri = [uri]"https://github.com/$Repo/releases/latest"
    $Client = New-OmsHttpClient -TimeoutSeconds 30
    try {
        $Request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Head, $LatestUri)
        try {
            $Response = $Client.SendAsync($Request).GetAwaiter().GetResult()
        } catch {
            throw "Could not reach $LatestUri to resolve the newest release. Check connectivity and proxy settings, then retry. ($($_.Exception.GetBaseException().Message))"
        }
        try {
            $Status = [int]$Response.StatusCode
            if ($Status -lt 300 -or $Status -ge 400 -or $null -eq $Response.Headers.Location) {
                throw "Expected a redirect from $LatestUri but got HTTP $Status. The repository may have no published releases: https://github.com/$Repo/releases"
            }
            $Location = $Response.Headers.Location
            if (-not $Location.IsAbsoluteUri) {
                $Location = [uri]::new($LatestUri, $Location)
            }
            $Tag = [uri]::UnescapeDataString($Location.AbsoluteUri.TrimEnd('/').Split('/')[-1])
            if ([string]::IsNullOrWhiteSpace($Tag) -or $Tag -eq 'releases') {
                throw "Could not parse a release tag from redirect target '$($Location.AbsoluteUri)'."
            }
            $Tag
        } finally {
            $Response.Dispose()
        }
    } finally {
        $Client.Dispose()
    }
}

function Save-OmsAsset {
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [uri]$Uri,

        [Parameter(Mandatory)]
        [string]$DestinationPath
    )

    # HttpClient with ResponseHeadersRead streams the body straight into the
    # destination FileStream: first byte hits disk immediately, nothing
    # buffers the ~160 MB binary in memory, and there is no progress-bar
    # repaint tax (Invoke-WebRequest's bar slows 5.1 downloads 50-100x).
    $Client = New-OmsHttpClient -TimeoutSeconds 900 -AllowRedirect
    try {
        $Request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Uri)
        $Response = $Client.SendAsync($Request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        try {
            if ([int]$Response.StatusCode -eq 404) {
                throw "404: no asset at $Uri"
            }
            if (-not $Response.IsSuccessStatusCode) {
                throw "Download of $Uri failed with HTTP $([int]$Response.StatusCode)."
            }
            $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
            $Source = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $Target = [System.IO.FileStream]::new(
                $DestinationPath,
                [System.IO.FileMode]::Create,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None,
                1MB)
            try {
                $Source.CopyTo($Target, 1MB)
            } finally {
                $Target.Dispose()
                $Source.Dispose()
            }
            $Stopwatch.Stop()
            $Bytes = ([System.IO.FileInfo]$DestinationPath).Length
            $Seconds = [math]::Max($Stopwatch.Elapsed.TotalSeconds, 0.001)
            [pscustomobject]@{
                Bytes = $Bytes
                Seconds = [math]::Round($Seconds, 1)
                MegabytesPerSecond = [math]::Round(($Bytes / 1MB) / $Seconds, 1)
            }
        } finally {
            $Response.Dispose()
        }
    } finally {
        $Client.Dispose()
    }
}

function Invoke-OmsBinary {
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [string]$ExePath,

        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    # Native command. EAP stays 'Continue' in this scope: under 'Stop',
    # Windows PowerShell 5.1 turns any stderr byte of a redirected native
    # command into a terminating NativeCommandError, failing installs whose
    # binary works. The exit code is the only authority here. A binary that
    # cannot launch at all reports exit -1 with the launch error as output.
    $ErrorActionPreference = 'Continue'
    try {
        $Lines = & $ExePath @Arguments 2>&1
        $ExitCode = $LASTEXITCODE
    } catch {
        return [pscustomobject]@{
            ExitCode = -1
            Output = @($_.Exception.GetBaseException().Message)
        }
    }
    $Text = @()
    foreach ($Line in @($Lines)) {
        $Text += [string]$Line
    }
    [pscustomobject]@{
        ExitCode = $ExitCode
        Output = $Text
    }
}

function Install-OmsBinary {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory)]
        [string]$TempPath,

        [Parameter(Mandatory)]
        [string]$TargetPath
    )

    if (-not $PSCmdlet.ShouldProcess($TargetPath, 'Install binary')) {
        return
    }
    try {
        Move-Item -LiteralPath $TempPath -Destination $TargetPath -Force
        return
    } catch {
        $MoveError = $_
    }

    # A running oms.exe (TUI or background daemon broker) keeps the image
    # mapped: Windows forbids overwrite/delete but allows rename. Rename the
    # live image aside and retry; the orphan is reaped by Clear-OmsStaleBackup
    # on the next install once its processes exit.
    $BackupPath = "$TargetPath.old-$([datetime]::UtcNow.ToString('yyyyMMddHHmmssfff'))"
    try {
        Rename-Item -LiteralPath $TargetPath -NewName ([System.IO.Path]::GetFileName($BackupPath))
        Move-Item -LiteralPath $TempPath -Destination $TargetPath -Force
    } catch {
        throw "Could not replace $TargetPath ($($MoveError.Exception.GetBaseException().Message)). Close running oms processes (or stop oms daemons) and rerun the installer."
    }
}

function Clear-OmsStaleBackup {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory)]
        [string]$InstallDir
    )

    if (-not [System.IO.Directory]::Exists($InstallDir)) {
        return
    }
    $Stale = @(Get-ChildItem -LiteralPath $InstallDir -Filter 'oms.exe.old-*' -File -ErrorAction SilentlyContinue)
    foreach ($Item in $Stale) {
        if ($PSCmdlet.ShouldProcess($Item.FullName, 'Remove stale renamed binary')) {
            # Best-effort by design: a backup whose process is still alive
            # stays mapped and undeletable until that process exits.
            Remove-Item -LiteralPath $Item.FullName -ErrorAction SilentlyContinue
        }
    }
}

function Add-OmsPathEntry {
    [CmdletBinding(SupportsShouldProcess = $true)]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [string]$Directory
    )

    $Normalized = $Directory.TrimEnd('\')
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $UserPath) {
        $UserPath = ''
    }
    $Entries = @($UserPath.Split(';'))
    foreach ($Entry in $Entries) {
        if ($Entry.TrimEnd('\') -eq $Normalized) {
            return $false
        }
    }

    if (-not $PSCmdlet.ShouldProcess($Normalized, 'Append to user PATH')) {
        return $false
    }
    # Registry write + WM_SETTINGCHANGE broadcast; runs only when the entry is
    # genuinely missing, so reinstalls never pay the broadcast stall.
    $Separator = ';'
    if ($UserPath -eq '' -or $UserPath.EndsWith(';')) {
        $Separator = ''
    }
    [Environment]::SetEnvironmentVariable('Path', $UserPath + $Separator + $Normalized, 'User')
    $true
}

function Find-OmsBashShell {
    [OutputType([string])]
    param()

    $Roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432)
    foreach ($Root in $Roots) {
        if ([string]::IsNullOrWhiteSpace($Root)) {
            continue
        }
        $Candidate = Join-Path -Path $Root -ChildPath 'Git\bin\bash.exe'
        if ([System.IO.File]::Exists($Candidate)) {
            return $Candidate
        }
    }
    $Command = Get-Command -Name bash.exe -ErrorAction SilentlyContinue
    if ($null -ne $Command) {
        return $Command.Source
    }
    $null
}

function Set-OmsShellConfig {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()

    $SettingsDir = Join-Path -Path $env:USERPROFILE -ChildPath '.oms\agent'
    $SettingsFile = Join-Path -Path $SettingsDir -ChildPath 'settings.json'

    $Settings = @{}
    if ([System.IO.File]::Exists($SettingsFile)) {
        try {
            $Parsed = [System.IO.File]::ReadAllText($SettingsFile) | ConvertFrom-Json
            foreach ($Property in $Parsed.PSObject.Properties) {
                $Settings[$Property.Name] = $Property.Value
            }
        } catch {
            Write-Warning -Message "Existing $SettingsFile is not valid JSON; it will be rewritten."
            $Settings = @{}
        }
    }
    if ($Settings.ContainsKey('shellPath') -and -not [string]::IsNullOrWhiteSpace([string]$Settings['shellPath'])) {
        Write-OmsStep -Message "Bash shell already configured: $($Settings['shellPath'])" -Color Cyan
        return
    }

    $BashPath = Find-OmsBashShell
    if ($null -eq $BashPath) {
        Write-OmsStep -Message ''
        Write-OmsStep -Message 'No bash shell found - oms will use its built-in shell.' -Color Cyan
        Write-OmsStep -Message '  For shell snapshots and interactive terminals, install Git for Windows:' -Color Cyan
        Write-OmsStep -Message '    https://git-scm.com/download/win' -Color Cyan
        Write-OmsStep -Message "  Or set a custom path in: $SettingsFile" -Color Cyan
        Write-OmsStep -Message '    { "shellPath": "C:\\path\\to\\bash.exe" }' -Color Cyan
        return
    }

    Write-OmsStep -Message "Found bash shell: $BashPath" -Color Cyan
    if (-not $PSCmdlet.ShouldProcess($SettingsFile, 'Write shellPath')) {
        return
    }
    if (-not [System.IO.Directory]::Exists($SettingsDir)) {
        [void][System.IO.Directory]::CreateDirectory($SettingsDir)
    }
    $Settings['shellPath'] = $BashPath
    $Json = $Settings | ConvertTo-Json -Depth 10
    # BOM-less UTF-8 on both editions; 5.1's Set-Content -Encoding UTF8 writes
    # a BOM while 7 does not, and the config should not vary by installer host.
    [System.IO.File]::WriteAllText($SettingsFile, $Json, [System.Text.UTF8Encoding]::new($false))
    Write-OmsStep -Message "[OK] Configured shell path in $SettingsFile" -Color Green
}

function Install-Oms {
    # PSUseSingularNouns misreads the product name oms as a plural noun.
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseSingularNouns', '', Justification = 'Oms is the product name, not a plural.')]
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter()]
        [AllowEmptyString()]
        [string]$Ref
    )

    Set-StrictMode -Version 3.0
    $ErrorActionPreference = 'Stop'
    $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    $Repo = 'pickpocket/oh-my-soup'
    # Asset preference order. The smoke test below is the CPU-capability
    # detector: a pre-AVX2 CPU kills the modern build at launch with
    # STATUS_ILLEGAL_INSTRUCTION (0xC000001D, surfacing as a negative exit
    # code), which triggers the baseline fallback. Releases that predate the
    # modern asset 404 and fall back the same way.
    $Variants = @(
        [pscustomobject]@{ Name = 'oms-windows-x64-modern.exe'; Label = 'modern'; IsFallback = $false },
        [pscustomobject]@{ Name = 'oms-windows-x64.exe'; Label = 'baseline'; IsFallback = $true }
    )
    $InstallDir = $env:OMS_INSTALL_DIR
    if ([string]::IsNullOrWhiteSpace($InstallDir)) {
        $InstallDir = $env:PI_INSTALL_DIR
    }
    if ([string]::IsNullOrWhiteSpace($InstallDir)) {
        $InstallDir = Join-Path -Path $env:LOCALAPPDATA -ChildPath 'oms'
    }
    $TargetPath = Join-Path -Path $InstallDir -ChildPath 'oms.exe'
    # The temp name must keep the .exe extension: PowerShell's call operator
    # refuses to launch non-PATHEXT files, and the download is smoke-tested
    # before it replaces the target.
    $TempPath = Join-Path -Path $InstallDir -ChildPath 'oms.new.exe'

    Initialize-OmsNetwork
    Clear-OmsStaleBackup -InstallDir $InstallDir

    if ([string]::IsNullOrWhiteSpace($Ref)) {
        Write-OmsStep -Message 'Resolving newest release...'
    } else {
        Write-OmsStep -Message "Using pinned release $Ref..."
    }
    $Tag = Resolve-OmsReleaseTag -Repo $Repo -Ref $Ref
    Write-OmsStep -Message "Installing oms $Tag"

    if (-not $PSCmdlet.ShouldProcess($TargetPath, "Install oms $Tag")) {
        return
    }
    if (-not [System.IO.Directory]::Exists($InstallDir)) {
        [void][System.IO.Directory]::CreateDirectory($InstallDir)
    }

    $Smoke = $null
    $Variant = $null
    foreach ($Candidate in $Variants) {
        $AssetUri = [uri]"https://github.com/$Repo/releases/download/$Tag/$($Candidate.Name)"
        Write-OmsStep -Message "Downloading $($Candidate.Name)..."
        try {
            $Download = Save-OmsAsset -Uri $AssetUri -DestinationPath $TempPath
        } catch {
            if ([System.IO.File]::Exists($TempPath)) {
                Remove-Item -LiteralPath $TempPath -ErrorAction SilentlyContinue
            }
            if (-not $_.Exception.Message.StartsWith('404:')) {
                throw
            }
            if (-not $Candidate.IsFallback) {
                Write-OmsStep -Message "Release $Tag has no modern (AVX2) asset; using the baseline build." -Color Cyan
                continue
            }
            throw "Release $Tag has no $($Candidate.Name) asset. See https://github.com/$Repo/releases/tag/$Tag for what it ships, or omit -Ref for the newest release."
        }
        Write-OmsStep -Message ("Downloaded {0:N0} MB in {1}s ({2} MB/s)" -f ($Download.Bytes / 1MB), $Download.Seconds, $Download.MegabytesPerSecond)

        try {
            # MotW off before anything executes the file: a zone-tagged exe pays a
            # SmartScreen/Defender deep scan on every launch, including the smoke
            # test below.
            Unblock-File -LiteralPath $TempPath -ErrorAction SilentlyContinue

            # Smoke-test the download BEFORE it replaces a working install: a bad
            # asset must never take out the binary the user already has.
            $Smoke = Invoke-OmsBinary -ExePath $TempPath -Arguments '--version'
        } catch {
            Remove-Item -LiteralPath $TempPath -ErrorAction SilentlyContinue
            throw
        }
        if ($Smoke.ExitCode -eq 0) {
            $Variant = $Candidate.Label
            break
        }

        Remove-Item -LiteralPath $TempPath -ErrorAction SilentlyContinue
        if (-not $Candidate.IsFallback -and $Smoke.ExitCode -lt 0) {
            # Launch failure (-1) or crash-class NTSTATUS exit (negative, e.g.
            # 0xC000001D illegal instruction): this CPU cannot run the modern
            # build. The baseline build is the answer, not an error.
            Write-OmsStep -Message "Modern (AVX2) build cannot run on this CPU (exit $($Smoke.ExitCode)); using the baseline build." -Color Cyan
            continue
        }
        $Detail = ($Smoke.Output -join '; ')
        throw "Downloaded binary failed its start check (exit $($Smoke.ExitCode)): $Detail"
    }

    Install-OmsBinary -TempPath $TempPath -TargetPath $TargetPath
    $SetupHelp = Invoke-OmsBinary -ExePath $TargetPath -Arguments @('setup', '--help')
    if ($SetupHelp.ExitCode -ne 0) {
        foreach ($Line in $SetupHelp.Output) {
            Write-OmsStep -Message $Line
        }
        $Detail = ($SetupHelp.Output -join '; ')
        throw "oms was installed, but setup capability detection failed (exit $($SetupHelp.ExitCode)): $Detail"
    }
    # The public installer can be newer than the downloaded release.
    if (($SetupHelp.Output -join "`n") -cmatch '(^|[\s|()])objdump($|[\s|()])') {
        Write-OmsStep -Message 'Installing local GNU objdump...'
        $Setup = Invoke-OmsBinary -ExePath $TargetPath -Arguments @('setup', 'objdump')
        foreach ($Line in $Setup.Output) {
            Write-OmsStep -Message $Line
        }
        if ($Setup.ExitCode -ne 0) {
            $Detail = ($Setup.Output -join '; ')
            throw "oms was installed, but GNU objdump setup failed (exit $($Setup.ExitCode)): $Detail. Check the error above, then retry: & `"$TargetPath`" setup objdump"
        }
    } else {
        Write-OmsStep -Message "Release $Tag does not support managed GNU objdump setup; skipping objdump installation." -Color Cyan
    }
    Write-OmsStep -Message ''
    Write-OmsStep -Message "[OK] Installed oms $($Smoke.Output -join ' ') ($Variant) to $TargetPath" -Color Green

    $PathAdded = Add-OmsPathEntry -Directory $InstallDir
    if ($PathAdded) {
        # Make `oms` work in this session immediately; new shells read the
        # updated user PATH, only other already-open terminals need a restart.
        $env:Path = $InstallDir + ';' + $env:Path
        Write-OmsStep -Message "Added $InstallDir to PATH (other open terminals need a restart to see it)."
    }

    Set-OmsShellConfig

    $Stopwatch.Stop()
    Write-OmsStep -Message ("Done in {0:N1}s. Run 'oms' to get started!" -f $Stopwatch.Elapsed.TotalSeconds)
}

Install-Oms -Ref $Ref
