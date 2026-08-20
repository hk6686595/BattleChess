using System.IO;
using System.Media;
using System.Windows;
using System.Windows.Media;

namespace XiangqiClient.Services;

/// <summary>
/// 音效与背景音乐服务。
/// 走子/吃子音效与背景音乐统一使用 SoundPlayer（WAV），播放稳定可靠；
/// 若用户放置了 bgm.mp3（如腾讯 QQ 中国象棋原版音乐）在 exe 同目录，则改用 MediaPlayer 循环播放。
/// 背景音乐来源优先级：exe 同目录 bgm.mp3 → exe 同目录 bgm.wav → 嵌入的占位曲。
/// 任何播放失败都静默忽略，绝不影响主流程。
/// </summary>
public static class SoundService
{
    private static readonly SoundPlayer? MoveSound = LoadSound("move.wav");
    private static readonly SoundPlayer? CaptureSound = LoadSound("capture.wav");
    private static SoundPlayer? _bgmWav;
    private static MediaPlayer? _bgmMp3;
    private static bool _bgmPlaying;

    /// <summary>走子/吃子音效（异步播放，支持快速连续触发）</summary>
    public static void PlayMove(bool capture)
    {
        var player = capture ? CaptureSound : MoveSound;
        if (player == null) return;
        try
        {
            player.Stop();
            player.Play();
        }
        catch { /* 播放失败忽略 */ }
    }

    /// <summary>进入大厅：开始循环播放背景音乐（重复调用不会重新起播）</summary>
    public static void StartLobbyBgm()
    {
        var app = Application.Current;
        if (app == null || _bgmPlaying) return;
        if (!app.Dispatcher.CheckAccess())
        {
            app.Dispatcher.BeginInvoke(new Action(StartLobbyBgm));
            return;
        }
        EnsureBgm();
        if (_bgmMp3 != null)
        {
            try { _bgmMp3.Play(); _bgmPlaying = true; }
            catch { _bgmPlaying = false; }
        }
        else if (_bgmWav != null)
        {
            try { _bgmWav.PlayLooping(); _bgmPlaying = true; }
            catch { _bgmPlaying = false; }
        }
    }

    /// <summary>离开大厅（进入房间/退出登录/关闭程序）：停止背景音乐</summary>
    public static void StopLobbyBgm()
    {
        var app = Application.Current;
        if (app == null || !_bgmPlaying) return;
        if (!app.Dispatcher.CheckAccess())
        {
            app.Dispatcher.BeginInvoke(new Action(StopLobbyBgm));
            return;
        }
        _bgmPlaying = false;
        try { _bgmWav?.Stop(); } catch { /* 忽略 */ }
        try { _bgmMp3?.Stop(); } catch { /* 忽略 */ }
    }

    private static void EnsureBgm()
    {
        if (_bgmWav != null || _bgmMp3 != null) return;
        var dir = AppContext.BaseDirectory;

        // 1) exe 同目录 bgm.mp3（可放腾讯 QQ 中国象棋原版音乐）→ MediaPlayer 循环
        var mp3 = Path.Combine(dir, "bgm.mp3");
        if (File.Exists(mp3))
        {
            try
            {
                var mp = new MediaPlayer { Volume = 0.5 };
                mp.MediaEnded += (_, _) => { mp.Position = TimeSpan.Zero; mp.Play(); };
                mp.MediaFailed += (_, _) =>
                {
                    try { mp.Close(); } catch { /* 忽略 */ }
                    _bgmMp3 = null;
                    _bgmWav = LoadEmbeddedBgm();   // 回退到内置占位曲
                    if (_bgmPlaying) TryPlayWav();
                };
                mp.Open(new Uri(mp3));
                _bgmMp3 = mp;
                return;
            }
            catch { _bgmMp3 = null; }
        }

        // 2) exe 同目录 bgm.wav → SoundPlayer 循环
        var wav = Path.Combine(dir, "bgm.wav");
        if (File.Exists(wav))
        {
            try { _bgmWav = new SoundPlayer(wav); return; }
            catch { _bgmWav = null; }
        }

        // 3) 嵌入资源占位曲 → SoundPlayer 循环
        _bgmWav = LoadEmbeddedBgm();
    }

    private static void TryPlayWav()
    {
        try { _bgmWav?.PlayLooping(); } catch { /* 忽略 */ }
    }

    private static SoundPlayer? LoadEmbeddedBgm()
    {
        try
        {
            var stream = Application.GetResourceStream(new Uri("pack://application:,,,/assets/bgm.wav"))?.Stream;
            return stream == null ? null : new SoundPlayer(stream);
        }
        catch { return null; }
    }

    private static SoundPlayer? LoadSound(string name)
    {
        try
        {
            var stream = Application.GetResourceStream(new Uri($"pack://application:,,,/assets/{name}"))?.Stream;
            return stream == null ? null : new SoundPlayer(stream);
        }
        catch { return null; }
    }
}
