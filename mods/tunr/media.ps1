# Windows SMTC (GlobalSystemMediaTransportControlsSessionManager) bridge for tunr.
# Emits one JSON line per change to stdout (max 1 poll/sec) and reads control commands from stdin.
# Compatible with Windows PowerShell 5.1.
param(
    [int]$ParentPid = 0
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus, Windows.Media.Control, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.IsGenericMethodDefinition -and
    $_.GetGenericArguments().Count -eq 1 -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
})[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

$parent = $null
if ($ParentPid -gt 0) {
    try { $parent = [System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { exit 1 }
}

$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
if ($null -eq $mgr) { exit 2 }

function Map-Status($st) {
    switch ([string]$st) {
        "Playing" { return "playing" }
        "Paused"  { return "paused" }
        "Stopped" { return "stopped" }
        default   { return "none" }
    }
}

function Read-Snapshot {
    $session = $null
    try { $session = $mgr.GetCurrentSession() } catch {}
    if ($null -eq $session) {
        return @{
            status = "none"
            title = ""
            artist = ""
            app = ""
            canPlay = $false
            canPause = $false
            canNext = $false
            canPrev = $false
        }
    }

    $pb = $null
    try { $pb = $session.GetPlaybackInfo() } catch {}
    $status = if ($pb) { Map-Status $pb.PlaybackStatus } else { "none" }
    $ctrl = if ($pb) { $pb.Controls } else { $null }
    $canToggle = if ($ctrl) { [bool]$ctrl.IsPlayPauseToggleEnabled } else { $false }
    $canPlay = if ($ctrl) { [bool]($ctrl.IsPlayEnabled -or $canToggle) } else { $false }
    $canPause = if ($ctrl) { [bool]($ctrl.IsPauseEnabled -or $canToggle) } else { $false }
    $canNext = if ($ctrl) { [bool]$ctrl.IsNextEnabled } else { $false }
    $canPrev = if ($ctrl) { [bool]$ctrl.IsPreviousEnabled } else { $false }

    $title = ""
    $artist = ""
    try {
        $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        if ($props) {
            if ($props.Title) { $title = [string]$props.Title }
            if ($props.Artist) { $artist = [string]$props.Artist }
        }
    } catch {}

    $app = ""
    try {
        if ($session.SourceAppUserModelId) { $app = [string]$session.SourceAppUserModelId }
    } catch {}

    return @{
        status = $status
        title = $title
        artist = $artist
        app = $app
        canPlay = $canPlay
        canPause = $canPause
        canNext = $canNext
        canPrev = $canPrev
    }
}

function Handle-Command([string]$cmd) {
    $session = $null
    try { $session = $mgr.GetCurrentSession() } catch {}
    if ($null -eq $session) { return }
    try {
        switch ($cmd.Trim().ToLowerInvariant()) {
            "toggle" {
                $pb = $session.GetPlaybackInfo()
                $isPlaying = ($pb -and [string]$pb.PlaybackStatus -eq "Playing")
                if ($isPlaying -and $pb.Controls -and $pb.Controls.IsPauseEnabled) {
                    $null = Await ($session.TryPauseAsync()) ([bool])
                } elseif (-not $isPlaying -and $pb.Controls -and $pb.Controls.IsPlayEnabled) {
                    $null = Await ($session.TryPlayAsync()) ([bool])
                } else {
                    $null = Await ($session.TryTogglePlayPauseAsync()) ([bool])
                }
            }
            "play"  { $null = Await ($session.TryPlayAsync()) ([bool]) }
            "pause" { $null = Await ($session.TryPauseAsync()) ([bool]) }
            "next"  { $null = Await ($session.TrySkipNextAsync()) ([bool]) }
            "prev"  { $null = Await ($session.TrySkipPreviousAsync()) ([bool]) }
        }
    } catch {}
}

$stdinStream = [Console]::OpenStandardInput()
$stdinReader = New-Object System.IO.StreamReader($stdinStream, [System.Text.Encoding]::UTF8)
$readTask = $stdinReader.ReadLineAsync()
$lastJson = ""
$lastPoll = [DateTime]::MinValue

while ($true) {
    if ($null -ne $parent -and $parent.HasExited) { break }

    $cmdHandled = $false
    while ($readTask.IsCompleted) {
        $line = $null
        try { $line = $readTask.Result } catch {}
        if ($null -eq $line) { break }
        if ($line.Trim().Length -gt 0) {
            Handle-Command $line
            $cmdHandled = $true
        }
        $readTask = $stdinReader.ReadLineAsync()
    }
    if ($readTask.IsCompleted -and $null -eq $readTask.Result) { break }

    $now = [DateTime]::UtcNow
    if ($cmdHandled -or ($now - $lastPoll).TotalMilliseconds -ge 1000) {
        $lastPoll = $now
        $snap = Read-Snapshot
        $json = $snap | ConvertTo-Json -Compress
        if ($json -ne $lastJson) {
            $lastJson = $json
            [Console]::Out.WriteLine($json)
            [Console]::Out.Flush()
        }
    }

    Start-Sleep -Milliseconds 100
}
