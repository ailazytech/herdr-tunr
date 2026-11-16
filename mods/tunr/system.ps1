# Combined WASAPI loopback audio capture + Windows SMTC bridge for tunr.
# Emits framed binary packets on stdout:
#   [0x54 'T'][tag][uint32LE length][payload]
#   tag 'R': ASCII sample rate (e.g. "48000")
#   tag 'P': 16-bit mono PCM (Int16LE)
#   tag 'M': UTF-8 JSON snapshot from SMTC
# Reads control commands (toggle, play, pause, next, prev) from stdin.
# Compatible with Windows PowerShell 5.1 and PowerShell 7+.
param(
    [int]$ParentPid = 0,
    [int]$MaxSeconds = 0
)

[Console]::InputEncoding = [System.Text.Encoding]::UTF8

$code = @"
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Text;
using System.Runtime.InteropServices;

namespace TunrAudio
{
    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
        int GetDevice(string pwstrId, out IMMDevice ppDevice);
        int RegisterEndpointNotificationCallback(IntPtr pClient);
        int UnregisterEndpointNotificationCallback(IntPtr pClient);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        int OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        int GetState(out int pdwState);
    }

    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        int Initialize(int ShareMode, int StreamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr AudioSessionGuid);
        int GetBufferSize(out uint pNumBufferFrames);
        int GetStreamLatency(out long phnsLatency);
        int GetCurrentPadding(out uint pNumPaddingFrames);
        int IsFormatSupported(int ShareMode, IntPtr pFormat, out IntPtr ppClosestMatch);
        int GetMixFormat(out IntPtr ppDeviceFormat);
        int GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr eventHandle);
        int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out int pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);
        int ReleaseBuffer(uint NumFramesRead);
        int GetNextPacketSize(out uint pNumFramesInNextPacket);
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    public static class SystemStream
    {
        private static readonly object WriteLock = new object();
        private static readonly byte[] HeaderBuf = new byte[6];
        private static Stream StdOut;
        private static volatile bool StopFlag = false;
        private static Thread CaptureThread = null;

        public static void WriteFrame(byte tag, byte[] data, int offset, int length)
        {
            lock (WriteLock)
            {
                if (StdOut == null) StdOut = Console.OpenStandardOutput();
                HeaderBuf[0] = (byte)'T';
                HeaderBuf[1] = tag;
                HeaderBuf[2] = (byte)(length & 0xFF);
                HeaderBuf[3] = (byte)((length >> 8) & 0xFF);
                HeaderBuf[4] = (byte)((length >> 16) & 0xFF);
                HeaderBuf[5] = (byte)((length >> 24) & 0xFF);
                StdOut.Write(HeaderBuf, 0, 6);
                if (length > 0 && data != null)
                {
                    StdOut.Write(data, offset, length);
                }
                StdOut.Flush();
            }
        }

        public static void WriteRate(int sampleRate)
        {
            byte[] b = Encoding.ASCII.GetBytes(sampleRate.ToString());
            WriteFrame((byte)'R', b, 0, b.Length);
        }

        public static void WriteMediaJson(string json)
        {
            if (string.IsNullOrEmpty(json)) return;
            byte[] b = Encoding.UTF8.GetBytes(json);
            WriteFrame((byte)'M', b, 0, b.Length);
        }

        public static void StartBackground(int parentPid, int maxSeconds)
        {
            lock (WriteLock)
            {
                if (StdOut == null) StdOut = Console.OpenStandardOutput();
            }
            StopFlag = false;
            CaptureThread = new Thread(() =>
            {
                try { RunCapture(parentPid, maxSeconds); } catch {}
            });
            CaptureThread.IsBackground = true;
            CaptureThread.SetApartmentState(ApartmentState.MTA);
            CaptureThread.Start();
        }

        public static void StopCapture()
        {
            StopFlag = true;
            if (CaptureThread != null)
            {
                try { CaptureThread.Join(300); } catch {}
                CaptureThread = null;
            }
        }

        private static int RunCapture(int parentPid, int maxSeconds)
        {
            Process parent = null;
            if (parentPid > 0)
            {
                try { parent = Process.GetProcessById(parentPid); } catch { return 1; }
            }

            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDevice dev = null;
            int hr = enumerator.GetDefaultAudioEndpoint(0, 0, out dev);
            if (hr != 0 || dev == null) return 2;

            Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
            object clientObj;
            hr = dev.Activate(ref IID_IAudioClient, 1, IntPtr.Zero, out clientObj);
            if (hr != 0 || clientObj == null) return 3;
            var client = (IAudioClient)clientObj;

            IntPtr pFormat;
            hr = client.GetMixFormat(out pFormat);
            if (hr != 0 || pFormat == IntPtr.Zero) return 4;

            WAVEFORMATEX wfx = (WAVEFORMATEX)Marshal.PtrToStructure(pFormat, typeof(WAVEFORMATEX));
            bool isFloat = (wfx.wBitsPerSample == 32);
            bool is16Bit = (wfx.wBitsPerSample == 16);

            int channels = wfx.nChannels;
            int sampleRate = (int)wfx.nSamplesPerSec;

            hr = client.Initialize(0, 0x00020000, 1000000, 0, pFormat, IntPtr.Zero);
            if (hr != 0) return 5;

            Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
            object captureObj;
            hr = client.GetService(ref IID_IAudioCaptureClient, out captureObj);
            if (hr != 0 || captureObj == null) return 6;
            var capture = (IAudioCaptureClient)captureObj;

            hr = client.Start();
            if (hr != 0) return 7;

            WriteRate(sampleRate);

            DateTime startTime = DateTime.UtcNow;
            float[] floatBuf = new float[16384];
            short[] shortBuf = new short[16384];
            byte[] outBytes = new byte[8192];
            int outIdx = 0;

            try
            {
                while (!StopFlag)
                {
                    if (parent != null && parent.HasExited) break;
                    if (maxSeconds > 0 && (DateTime.UtcNow - startTime).TotalSeconds >= maxSeconds) break;

                    uint packetLength;
                    hr = capture.GetNextPacketSize(out packetLength);
                    if (hr != 0 || packetLength == 0)
                    {
                        Thread.Sleep(15);
                        continue;
                    }

                    while (packetLength > 0 && !StopFlag)
                    {
                        IntPtr pData;
                        uint numFrames;
                        int flags;
                        ulong devPos, qpcPos;
                        hr = capture.GetBuffer(out pData, out numFrames, out flags, out devPos, out qpcPos);
                        if (hr != 0) break;

                        bool silent = (flags & 2) != 0;
                        int totalSamples = (int)numFrames * channels;

                        if (silent)
                        {
                            int neededBytes = (int)numFrames * 2;
                            while (neededBytes > 0)
                            {
                                int take = Math.Min(neededBytes, outBytes.Length - outIdx);
                                Array.Clear(outBytes, outIdx, take);
                                outIdx += take;
                                neededBytes -= take;
                                if (outIdx >= outBytes.Length)
                                {
                                    WriteFrame((byte)'P', outBytes, 0, outBytes.Length);
                                    outIdx = 0;
                                }
                            }
                        }
                        else if (isFloat)
                        {
                            if (totalSamples > floatBuf.Length) floatBuf = new float[totalSamples];
                            Marshal.Copy(pData, floatBuf, 0, totalSamples);

                            for (int i = 0; i < (int)numFrames; i++)
                            {
                                float sum = 0f;
                                int baseIdx = i * channels;
                                for (int ch = 0; ch < channels; ch++)
                                {
                                    sum += floatBuf[baseIdx + ch];
                                }
                                float avg = sum / channels;
                                short sample = (short)Math.Max(-32768, Math.Min(32767, (int)(avg * 32767f)));

                                outBytes[outIdx++] = (byte)(sample & 0xFF);
                                outBytes[outIdx++] = (byte)((sample >> 8) & 0xFF);
                                if (outIdx >= outBytes.Length)
                                {
                                    WriteFrame((byte)'P', outBytes, 0, outBytes.Length);
                                    outIdx = 0;
                                }
                            }
                        }
                        else if (is16Bit)
                        {
                            if (totalSamples > shortBuf.Length) shortBuf = new short[totalSamples];
                            Marshal.Copy(pData, shortBuf, 0, totalSamples);

                            for (int i = 0; i < (int)numFrames; i++)
                            {
                                int sum = 0;
                                int baseIdx = i * channels;
                                for (int ch = 0; ch < channels; ch++)
                                {
                                    sum += shortBuf[baseIdx + ch];
                                }
                                short sample = (short)(sum / channels);

                                outBytes[outIdx++] = (byte)(sample & 0xFF);
                                outBytes[outIdx++] = (byte)((sample >> 8) & 0xFF);
                                if (outIdx >= outBytes.Length)
                                {
                                    WriteFrame((byte)'P', outBytes, 0, outBytes.Length);
                                    outIdx = 0;
                                }
                            }
                        }

                        capture.ReleaseBuffer(numFrames);
                        hr = capture.GetNextPacketSize(out packetLength);
                        if (hr != 0) break;
                    }

                    if (outIdx > 0)
                    {
                        WriteFrame((byte)'P', outBytes, 0, outIdx);
                        outIdx = 0;
                    }
                }
            }
            finally
            {
                try { client.Stop(); } catch {}
            }

            return 0;
        }
    }
}
"@

Add-Type -TypeDefinition $code -ErrorAction Stop
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

[TunrAudio.SystemStream]::StartBackground($ParentPid, $MaxSeconds)

$mgr = $null
try {
    $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch {
    $mgr = $null
}

function Map-Status($st) {
    switch ([string]$st) {
        "Playing" { return "playing" }
        "Paused"  { return "paused" }
        "Stopped" { return "stopped" }
        default   { return "none" }
    }
}

function Read-Snapshot {
    if ($null -eq $mgr) {
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
    if ($null -eq $mgr) { return }
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
$startTime = [DateTime]::UtcNow

try {
    while ($true) {
        if ($null -ne $parent -and $parent.HasExited) { break }
        if ($MaxSeconds -gt 0 -and ([DateTime]::UtcNow - $startTime).TotalSeconds -ge $MaxSeconds) { break }

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
                [TunrAudio.SystemStream]::WriteMediaJson($json)
            }
        }

        Start-Sleep -Milliseconds 100
    }
}
finally {
    [TunrAudio.SystemStream]::StopCapture()
}
