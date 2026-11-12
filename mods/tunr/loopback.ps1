# WASAPI loopback audio capture script for tunr.
# Captures system audio from the default playback device and writes 16-bit mono PCM to stdout.
# Compatible with Windows PowerShell 5.1 and PowerShell 7+.
param(
    [int]$ParentPid = 0,
    [int]$MaxSeconds = 0
)

$code = @"
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
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

    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEFORMATEXTENSIBLE
    {
        public WAVEFORMATEX Format;
        public ushort wValidBitsPerSample;
        public uint dwChannelMask;
        public Guid SubFormat;
    }

    public class LoopbackCapture
    {
        static readonly Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = new Guid("00000003-0000-0010-8000-00aa00389b71");

        public static int Start(int parentPid, int maxSeconds)
        {
            Process parent = null;
            if (parentPid > 0)
            {
                try { parent = Process.GetProcessById(parentPid); } catch { return 1; }
            }

            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDevice dev = null;
            // 0: eRender, 0: eConsole
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
            int bitsPerSample = wfx.wBitsPerSample;

            // Buffer duration: 100ms (1,000,000 in 100ns units)
            // Stream flags: AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
            hr = client.Initialize(0, 0x00020000, 1000000, 0, pFormat, IntPtr.Zero);
            if (hr != 0) return 5;

            Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
            object captureObj;
            hr = client.GetService(ref IID_IAudioCaptureClient, out captureObj);
            if (hr != 0 || captureObj == null) return 6;
            var capture = (IAudioCaptureClient)captureObj;

            hr = client.Start();
            if (hr != 0) return 7;

            Stream stdout = Console.OpenStandardOutput();
            byte[] header = System.Text.Encoding.ASCII.GetBytes("RATE " + sampleRate + "\n");
            stdout.Write(header, 0, header.Length);
            stdout.Flush();

            DateTime startTime = DateTime.UtcNow;
            float[] floatBuf = new float[16384];
            short[] shortBuf = new short[16384];
            byte[] outBytes = new byte[8192];
            int outIdx = 0;

            try
            {
                while (true)
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

                    while (packetLength > 0)
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
                                    stdout.Write(outBytes, 0, outBytes.Length);
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
                                    stdout.Write(outBytes, 0, outBytes.Length);
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
                                    stdout.Write(outBytes, 0, outBytes.Length);
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
                        stdout.Write(outBytes, 0, outIdx);
                        stdout.Flush();
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
$exitCode = [TunrAudio.LoopbackCapture]::Start($ParentPid, $MaxSeconds)
exit $exitCode
