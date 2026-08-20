# gen-audio.ps1 - Generate client audio assets (re-runnable).
#   Outputs (into client\XiangqiClient\Assets):
#     move.wav      - piece move sound ("clack")
#     capture.wav   - piece capture sound (duller "thud")
#     bgm.wav       - lobby BGM placeholder (original pentatonic pluck loop,
#                     ~100 BPM / 16 bars / seamless loop)
# NOTE: bgm.wav is an ORIGINAL placeholder. To use the real Tencent QQ xiangqi
# music, place the original audio as bgm.mp3 (or bgm.wav) next to the exe and
# the client will prefer it over the embedded placeholder.
# IMPORTANT: keep this file ASCII-only so it parses correctly on any PowerShell.
$ErrorActionPreference = 'Stop'

$cs = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

public static class AudioGen
{
    private static readonly Dictionary<string, double> F = new Dictionary<string, double>
    {
        { "G2", 98.00 }, { "A2", 110.00 },
        { "C3", 130.81 }, { "D3", 146.83 }, { "E3", 164.81 }, { "G3", 196.00 }, { "A3", 220.00 },
        { "C4", 261.63 }, { "D4", 293.66 }, { "E4", 329.63 }, { "G4", 392.00 }, { "A4", 440.00 },
        { "C5", 523.25 }, { "D5", 587.33 }, { "E5", 659.26 }, { "G5", 783.99 }, { "A5", 880.00 },
        { "C6", 1046.50 }, { "D6", 1174.66 }, { "E6", 1318.51 }, { "G6", 1567.98 }, { "A6", 1760.00 },
    };

    public static void GenerateAll(string dir)
    {
        Directory.CreateDirectory(dir);
        GenMove(Path.Combine(dir, "move.wav"));
        GenCapture(Path.Combine(dir, "capture.wav"));
        GenBgm(Path.Combine(dir, "bgm.wav"));
    }

    private static void WriteWav(string path, int sr, float[] s)
    {
        using (FileStream fs = File.Create(path))
        using (BinaryWriter bw = new BinaryWriter(fs))
        {
            int dataSize = s.Length * 2;
            bw.Write(Encoding.ASCII.GetBytes("RIFF"));
            bw.Write(36 + dataSize);
            bw.Write(Encoding.ASCII.GetBytes("WAVE"));
            bw.Write(Encoding.ASCII.GetBytes("fmt "));
            bw.Write(16);
            bw.Write((short)1);          // PCM
            bw.Write((short)1);          // mono
            bw.Write(sr);
            bw.Write(sr * 2);            // byte rate
            bw.Write((short)2);          // block align
            bw.Write((short)16);         // bits per sample
            bw.Write(Encoding.ASCII.GetBytes("data"));
            bw.Write(dataSize);
            foreach (float v in s)
            {
                int x = (int)(Math.Max(-1.0f, Math.Min(1.0f, v)) * 32767);
                bw.Write((short)x);
            }
        }
    }

    // Plucked-string timbre: first 4 harmonics, higher partials decay faster,
    // lower registers ring longer.
    private static float[] Pluck(double freq, double sr, double dur, double amp, double attack)
    {
        int n = (int)Math.Ceiling(dur * sr);
        float[] buf = new float[n];
        double decBase = 7.0 * Math.Sqrt(freq / 261.6);
        for (int i = 0; i < n; i++)
        {
            double t = i / sr;
            double env = t < attack ? t / attack : 1.0;
            double v = 0.0;
            for (int k = 1; k <= 4; k++)
            {
                v += (1.0 / k) * Math.Sin(2.0 * Math.PI * freq * k * t) * Math.Exp(-t * (decBase + 3.5 * k));
            }
            buf[i] = (float)(v * env * amp);
        }
        return buf;
    }

    // Exponentially-decaying noise (piece landing transient).
    private static float[] Noise(double sr, double dur, double amp, double decayRate, int seed)
    {
        int n = (int)Math.Ceiling(dur * sr);
        float[] buf = new float[n];
        Random rng = new Random(seed);
        for (int i = 0; i < n; i++)
        {
            double t = i / sr;
            buf[i] = (float)((rng.NextDouble() * 2.0 - 1.0) * Math.Exp(-t * decayRate) * amp);
        }
        return buf;
    }

    private static void AddAt(float[] dst, float[] src, double startSec, double sr)
    {
        int start = (int)Math.Floor(startSec * sr);
        for (int i = 0; i < src.Length; i++)
        {
            int idx = start + i;
            if (idx >= dst.Length) break;
            if (idx < 0) continue;
            dst[idx] += src[i];
        }
    }

    private static void Normalize(float[] buf, float peak)
    {
        float m = 0f;
        for (int i = 0; i < buf.Length; i++)
        {
            float a = Math.Abs(buf[i]);
            if (a > m) m = a;
        }
        if (m <= 0f) return;
        float scale = peak / m;
        for (int i = 0; i < buf.Length; i++) buf[i] *= scale;
    }

    private static void FadeOut(float[] buf, double sr, double dur)
    {
        int n = (int)Math.Min(dur * sr, buf.Length);
        for (int i = 0; i < n; i++)
        {
            buf[buf.Length - 1 - i] *= (float)(i / (double)n);
        }
    }

    // Move sound: short mid-frequency "clack" (~0.16 s).
    private static void GenMove(string path)
    {
        int sr = 44100;
        float[] buf = new float[(int)(0.16 * sr)];
        AddAt(buf, Pluck(430, sr, 0.14, 0.80, 0.002), 0.004, sr);
        AddAt(buf, Pluck(860, sr, 0.09, 0.18, 0.002), 0.004, sr);
        AddAt(buf, Noise(sr, 0.022, 0.55, 90, 11), 0.0, sr);
        Normalize(buf, 0.80f);
        FadeOut(buf, sr, 0.012);
        WriteWav(path, sr, buf);
    }

    // Capture sound: lower, duller "thud" (~0.30 s).
    private static void GenCapture(string path)
    {
        int sr = 44100;
        float[] buf = new float[(int)(0.30 * sr)];
        AddAt(buf, Pluck(175, sr, 0.28, 0.85, 0.003), 0.005, sr);
        AddAt(buf, Pluck(262, sr, 0.18, 0.32, 0.003), 0.005, sr);
        AddAt(buf, Noise(sr, 0.035, 0.60, 70, 23), 0.0, sr);
        Normalize(buf, 0.85f);
        FadeOut(buf, sr, 0.025);
        WriteWav(path, sr, buf);
    }

    private static void AddMel(List<Tuple<string, double>> mel, string n, double b)
    {
        mel.Add(Tuple.Create(n, b));
    }

    // Lobby BGM placeholder: C-pentatonic, 16 bars, resolves to the tonic so the loop is seamless.
    private static void GenBgm(string path)
    {
        int sr = 22050;
        double bpm = 100.0;
        double beat = 60.0 / bpm;
        double total = 64 * beat + 1.5;   // 64 beats + tail
        float[] buf = new float[(int)(total * sr)];

        List<Tuple<string, double>> mel = new List<Tuple<string, double>>();

        // Bars 1-4
        AddMel(mel, "E5", 1); AddMel(mel, "G5", 0.5); AddMel(mel, "A5", 0.5); AddMel(mel, "G5", 1); AddMel(mel, "E5", 1);
        AddMel(mel, "D5", 1); AddMel(mel, "E5", 1); AddMel(mel, "G5", 1); AddMel(mel, "E5", 0.5); AddMel(mel, "D5", 0.5);
        AddMel(mel, "C5", 1); AddMel(mel, "D5", 0.5); AddMel(mel, "E5", 0.5); AddMel(mel, "G5", 1); AddMel(mel, "A5", 1);
        AddMel(mel, "G5", 1.5); AddMel(mel, "E5", 0.5); AddMel(mel, "D5", 1); AddMel(mel, "C5", 1);
        // Bars 5-8
        AddMel(mel, "E5", 1); AddMel(mel, "G5", 0.5); AddMel(mel, "A5", 0.5); AddMel(mel, "G5", 1); AddMel(mel, "E5", 1);
        AddMel(mel, "D5", 1); AddMel(mel, "E5", 1); AddMel(mel, "G5", 1); AddMel(mel, "A5", 1);
        AddMel(mel, "G5", 1.5); AddMel(mel, "E5", 0.5); AddMel(mel, "D5", 1); AddMel(mel, "C5", 1);
        AddMel(mel, "D5", 2); AddMel(mel, "C5", 1); AddMel(mel, "D5", 1);
        // Bars 9-12
        AddMel(mel, "E5", 1); AddMel(mel, "G5", 0.5); AddMel(mel, "A5", 0.5); AddMel(mel, "C6", 1); AddMel(mel, "A5", 1);
        AddMel(mel, "G5", 1); AddMel(mel, "E5", 1); AddMel(mel, "D5", 1); AddMel(mel, "C5", 1);
        AddMel(mel, "D5", 1); AddMel(mel, "E5", 0.5); AddMel(mel, "G5", 0.5); AddMel(mel, "A5", 1); AddMel(mel, "G5", 0.5); AddMel(mel, "E5", 0.5);
        AddMel(mel, "D5", 1.5); AddMel(mel, "C5", 0.5); AddMel(mel, "D5", 1); AddMel(mel, "E5", 1);
        // Bars 13-16
        AddMel(mel, "G5", 1); AddMel(mel, "A5", 1); AddMel(mel, "G5", 0.5); AddMel(mel, "E5", 0.5); AddMel(mel, "D5", 1);
        AddMel(mel, "C5", 1); AddMel(mel, "D5", 1); AddMel(mel, "E5", 1); AddMel(mel, "G5", 1);
        AddMel(mel, "A5", 1.5); AddMel(mel, "G5", 0.5); AddMel(mel, "E5", 1); AddMel(mel, "D5", 1);
        AddMel(mel, "C5", 2); AddMel(mel, "D5", 1); AddMel(mel, "C5", 1);

        double t = 0.0;
        foreach (Tuple<string, double> n in mel)
        {
            double f = F[n.Item1];
            AddAt(buf, Pluck(f, sr, n.Item2 * beat * 1.6, 0.42, 0.003), t, sr);
            t += n.Item2 * beat;
        }

        // Bass: root note plucked on beats 1 and 3 of every bar.
        string[] roots = { "C3", "C3", "A2", "A2", "G2", "G2", "E3", "E3", "C3", "C3", "A2", "A2", "G2", "G2", "C3", "C3" };
        for (int bar = 0; bar < 16; bar++)
        {
            double bt = bar * 4.0 * beat;
            double f = F[roots[bar]];
            AddAt(buf, Pluck(f, sr, 2.4, 0.50, 0.004), bt, sr);
            AddAt(buf, Pluck(f, sr, 1.8, 0.38, 0.004), bt + 2.0 * beat, sr);
        }

        Normalize(buf, 0.72f);
        FadeOut(buf, sr, 0.8);   // fade tail so the loop seam is natural
        WriteWav(path, sr, buf);
    }
}
'@

Add-Type -TypeDefinition $cs

$outDir = (Resolve-Path (Join-Path $PSScriptRoot '..\client\XiangqiClient\Assets')).Path
[AudioGen]::GenerateAll($outDir)
Write-Host "Audio assets generated in $outDir"
