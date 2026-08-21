using System.Collections.ObjectModel;
using System.Text.Json;
using System.Windows;
using XiangqiClient.Models;
using XiangqiClient.Services;

namespace XiangqiClient.ViewModels;

public enum ViewMode { Login, Lobby, Room }

/// <summary>主视图模型：持有全部状态并处理服务端消息</summary>
public class MainViewModel : ViewModelBase
{
    private readonly ServerConnection _conn;

    public MainViewModel(ServerConnection conn)
    {
        _conn = conn;
        _conn.MessageReceived += OnMessage;
        _conn.StatusChanged += OnStatusChanged;

        CreateRoomCmd = new RelayCommand(_ => CreateRoom(), _ => CanAction);
        StartAiCmd = new RelayCommand(async _ => await _conn.SendAsync("room.create", new { gameType = SelectedGameType, vsAI = true }), _ => CanAction);
        QuickJoinCmd = new RelayCommand(async _ => await _conn.SendAsync("room.quickJoin", new { gameType = SelectedGameType }), _ => CanAction);
        // 匹配模式暂未开放（开发中）：按钮永久禁用，点击无响应。
        // 保留 ToggleMatch 与 match.enqueue/dequeue 协议，后期恢复时把 CanExecute 改回 _ => Room == null 即可。
        MatchCmd = new RelayCommand(_ => ToggleMatch(), _ => false);
        LeaveRoomCmd = new RelayCommand(async _ => await _conn.SendAsync("room.leave"), _ => CanAction);
        ReadyCmd = new RelayCommand(_ => ToggleReady(), _ => CanAction);
        StartCmd = new RelayCommand(async _ => await _conn.SendAsync("room.start"), _ => CanStart);
        SurrenderCmd = new RelayCommand(async _ => await _conn.SendAsync("game.surrender"), _ => InPlayingGame);
        RestartCmd = new RelayCommand(async _ => await _conn.SendAsync("game.restart"), _ => IsOwner && Game?.Over == true);
        SendLobbyChatCmd = new RelayCommand(_ => SendLobbyChat(), _ => !string.IsNullOrWhiteSpace(LobbyChatInput));
        SendRoomChatCmd = new RelayCommand(_ => SendRoomChat(), _ => !string.IsNullOrWhiteSpace(RoomChatInput));
        CellClickCmd = new RelayCommand(p => OnCellClick((Point2)p!), _ => CanAction);
        SwitchModeCommand = new RelayCommand(p => SwitchMode(p is bool b && b));
        UndoCmd = new RelayCommand(async _ => await _conn.SendAsync("game.undoRequest"), _ => InPlayingGame && (Game?.Moves.Count ?? 0) > 0);
        AgreeUndoCmd = new RelayCommand(async _ => { UndoPromptVisible = false; await _conn.SendAsync("game.undoRespond", new { agree = true }); });
        RejectUndoCmd = new RelayCommand(async _ => { UndoPromptVisible = false; await _conn.SendAsync("game.undoRespond", new { agree = false }); });

        _turnTimer.Tick += OnTurnTimerTick;
        _turnTimer.Start();
    }

    // ---------------- 视图状态 ----------------

    private ViewMode _currentView = ViewMode.Login;
    public ViewMode CurrentView
    {
        get => _currentView;
        set
        {
            if (Set(ref _currentView, value))
            {
                OnPropertyChanged(nameof(IsLobby));
                OnPropertyChanged(nameof(IsLogin));
                OnPropertyChanged(nameof(IsRoom));
                // 大厅与对局房间都播放背景音乐，仅登录页停止
                if (IsLogin) SoundService.StopBgm();
                else SoundService.StartBgm();
            }
        }
    }
    public bool IsLogin => CurrentView == ViewMode.Login;
    public bool IsLobby => CurrentView == ViewMode.Lobby;
    public bool IsRoom => CurrentView == ViewMode.Room;

    private bool _connected;
    public bool Connected
    {
        get => _connected;
        set { if (Set(ref _connected, value)) OnPropertyChanged(nameof(ConnectText)); }
    }
    public string ConnectText => Connected ? "● 已连接" : "○ 未连接";

    private string _statusText = "欢迎使用对战平台";
    public string StatusText { get => _statusText; set => Set(ref _statusText, value); }

    private string _serverUrl = "http://127.0.0.1:8080";
    public string ServerUrl { get => _serverUrl; set => Set(ref _serverUrl, value); }

    private string _loginName = "";
    public string LoginName { get => _loginName; set => Set(ref _loginName, value); }

    private string _loginPassword = "";
    public string LoginPassword { get => _loginPassword; set => Set(ref _loginPassword, value); }

    // ---------------- 记住登录账号 ----------------

    private bool _rememberAccount = true;
    public bool RememberAccount
    {
        get => _rememberAccount;
        set { if (Set(ref _rememberAccount, value)) OnPropertyChanged(nameof(RememberHint)); }
    }
    public string RememberHint => RememberAccount ? "已记住账号，下次自动填充" : "不保存账号信息";

    private string _savedName = "";
    public string SavedName { get => _savedName; set => Set(ref _savedName, value); }

    private string _savedPassword = "";
    public string SavedPassword { get => _savedPassword; set => Set(ref _savedPassword, value); }

    // ---------------- 注册表单 ----------------

    private bool _registerMode;
    /// <summary>true=注册表单，false=登录表单</summary>
    public bool RegisterMode
    {
        get => _registerMode;
        set
        {
            if (Set(ref _registerMode, value))
            {
                OnPropertyChanged(nameof(IsLoginMode));
                OnPropertyChanged(nameof(FormTitle));
                FormError = "";
            }
        }
    }
    public bool IsLoginMode => !RegisterMode;
    public string FormTitle => RegisterMode ? "创建账号" : "欢迎回来";

    /// <summary>是否显示"填入测试账号"按钮（仅 DEBUG 构建）</summary>
    public bool ShowTestFill
    {
        get
        {
#if DEBUG
            return true;
#else
            return false;
#endif
        }
    }

    /// <summary>填充测试注册账号（供 UI 自动化/演示）</summary>
    public void FillTestRegister()
    {
        RegisterName = $"测试用户{Random.Shared.Next(100, 999)}";
        RegisterPassword = "test1234";
        RegisterConfirm = "test1234";
        FormError = "";
    }

    private string _registerName = "";
    public string RegisterName
    {
        get => _registerName;
        set { if (Set(ref _registerName, value)) ValidateRegister(); }
    }

    private string _registerPassword = "";
    public string RegisterPassword
    {
        get => _registerPassword;
        set { if (Set(ref _registerPassword, value)) ValidateRegister(); }
    }

    private string _registerConfirm = "";
    public string RegisterConfirm
    {
        get => _registerConfirm;
        set { if (Set(ref _registerConfirm, value)) ValidateRegister(); }
    }

    private string _formError = "";
    /// <summary>表单校验/服务端错误提示</summary>
    public string FormError
    {
        get => _formError;
        set { if (Set(ref _formError, value)) OnPropertyChanged(nameof(HasFormError)); }
    }
    public bool HasFormError => !string.IsNullOrEmpty(FormError);

    /// <summary>注册表单是否通过本地校验</summary>
    public bool CanRegister
    {
        get
        {
            return NameValid(RegisterName) && RegisterPassword.Length >= 4
                && RegisterPassword.Length <= 64 && RegisterPassword == RegisterConfirm;
        }
    }

    private static bool NameValid(string? name)
        => !string.IsNullOrEmpty(name) && name.Length >= 2 && name.Length <= 16
           && System.Text.RegularExpressions.Regex.IsMatch(name, @"^[\w\u4e00-\u9fa5-]+$");

    /// <summary>实时校验注册表单并给出提示</summary>
    private void ValidateRegister()
    {
        OnPropertyChanged(nameof(CanRegister));
        if (RegisterName.Length > 0 && !NameValid(RegisterName))
        {
            FormError = "昵称需为 2-16 位中文/字母/数字/下划线/连字符";
            return;
        }
        if (RegisterPassword.Length > 0 && RegisterPassword.Length < 4)
        {
            FormError = "密码长度至少 4 位";
            return;
        }
        if (RegisterConfirm.Length > 0 && RegisterPassword != RegisterConfirm)
        {
            FormError = "两次输入的密码不一致";
            return;
        }
        FormError = "";
    }

    // ---------------- 用户与房间 ----------------

    private UserInfo? _user;
    public UserInfo? User { get => _user; set { if (Set(ref _user, value)) { OnPropertyChanged(nameof(UserBar)); OnPropertyChanged(nameof(IsBlackView)); } } }
    public string UserBar => User == null ? "" : $"{User.Name}（{User.Rating} 分）胜 {User.Wins} / 负 {User.Losses}";

    public ObservableCollection<RoomListItem> RoomList { get; } = new();
    public ObservableCollection<RankItem> Rankings { get; } = new();
    public ObservableCollection<ChatMessage> LobbyChats { get; } = new();
    public ObservableCollection<ChatMessage> RoomChats { get; } = new();
    public ObservableCollection<MatchRecord> MyMatches { get; } = new();
    public ObservableCollection<MoveRecord> MoveList { get; } = new();

    private RoomInfo? _room;
    public RoomInfo? Room
    {
        get => _room;
        set
        {
            if (Set(ref _room, value))
            {
                OnPropertyChanged(nameof(RoomTitle));
                OnPropertyChanged(nameof(ReadyButtonText));
                OnPropertyChanged(nameof(CanStart));
                OnPropertyChanged(nameof(IsGomoku));
                OnPropertyChanged(nameof(IsXiangqi));
                OnPropertyChanged(nameof(IsBlackView));
            }
        }
    }
    public string RoomTitle => Room == null ? "" : $"{Room.Name}  #{Room.Id}  {Room.GameName}";

    private bool _matching;
    public bool Matching
    {
        get => _matching;
        set
        {
            if (Set(ref _matching, value))
            {
                OnPropertyChanged(nameof(MatchButtonText));
                OnPropertyChanged(nameof(MatchHintText));
            }
        }
    }
    public string MatchButtonText => Matching ? "取消匹配…" : "⚡ 匹配（开发中）";
    public string MatchHintText => Matching ? "正在匹配对手，点击按钮可取消…" : "";

    private string _roomNameInput = "";
    public string RoomNameInput { get => _roomNameInput; set => Set(ref _roomNameInput, value); }
    private string _roomPasswordInput = "";
    public string RoomPasswordInput { get => _roomPasswordInput; set => Set(ref _roomPasswordInput, value); }
    private bool _roomPrivateInput;
    public bool RoomPrivateInput { get => _roomPrivateInput; set => Set(ref _roomPrivateInput, value); }

    private string _selectedGameType = "xiangqi";
    public string SelectedGameType
    {
        get => _selectedGameType;
        set
        {
            if (Set(ref _selectedGameType, value))
            {
                OnPropertyChanged(nameof(SelectedGameLabel));
                OnPropertyChanged(nameof(IsXiangqiSelected));
                OnPropertyChanged(nameof(IsGomokuSelected));
            }
        }
    }
    public string SelectedGameLabel => SelectedGameType == "gomoku" ? "五子棋" : "中国象棋";
    public bool IsXiangqiSelected
    {
        get => SelectedGameType != "gomoku";
        set { if (value) SelectedGameType = "xiangqi"; }
    }
    public bool IsGomokuSelected
    {
        get => SelectedGameType == "gomoku";
        set { if (value) SelectedGameType = "gomoku"; }
    }

    private string _lobbyChatInput = "";
    public string LobbyChatInput { get => _lobbyChatInput; set => Set(ref _lobbyChatInput, value); }
    private string _roomChatInput = "";
    public string RoomChatInput { get => _roomChatInput; set => Set(ref _roomChatInput, value); }

    // ---------------- 对局 ----------------

    private GameState? _game;
    public GameState? Game
    {
        get => _game;
        set
        {
            var prev = _game;
            if (Set(ref _game, value))
            {
                OnPropertyChanged(nameof(TurnText));
                OnPropertyChanged(nameof(ResultText));
                OnPropertyChanged(nameof(MyTurn));
                OnPropertyChanged(nameof(IsOwner));
                OnPropertyChanged(nameof(InPlayingGame));
                OnPropertyChanged(nameof(PlayersInfo));
                OnPropertyChanged(nameof(IsBlackView));
                OnPropertyChanged(nameof(IsGomoku));
                OnPropertyChanged(nameof(IsXiangqi));
                RebuildMoveList();
                ResetTurnCountdown();
                PlayMoveSound(prev, value);
            }
        }
    }

    /// <summary>
    /// 走子/吃子/将军音效：仅当步数恰好增加一步时触发，
    /// 开局、悔棋、重开、中途进房（步数跳变）等场景不响。
    /// 最后一手（将死/五连）同样播放，避免胜利步静音。
    /// </summary>
    private static void PlayMoveSound(GameState? prev, GameState? next)
    {
        if (prev == null || next == null) return;
        var addedMoves = next.Moves.Count - prev.Moves.Count;
        var addedCount = next.MoveCount - prev.MoveCount;
        if (addedMoves != 1 && addedCount != 1) return;
        var last = next.LastMove;
        var captured = last != null && GetPiece(prev, last.To) != null;
        // 象棋绝杀（含吃将）用独立重音，不能跟普通将军混在一起
        if (next.Over && !next.IsDraw && next.Type != "gomoku"
            && (next.Reason?.Contains("绝杀") == true || next.Reason?.Contains("吃掉对方") == true))
        {
            SoundService.PlayMate();
            return;
        }
        var justChecked = !string.IsNullOrEmpty(next.Check) && next.Check != prev.Check;
        if (justChecked) SoundService.PlayCheck();
        else SoundService.PlayMove(captured);
    }

    /// <summary>
    /// 黑方视角：棋盘镜像翻转，黑方棋子显示在屏幕下方。
    /// 服务器约定 players[0] 恒为红方（象棋）/ 黑方（五子棋）；
    /// 五子棋双方共用同一棋盘方向，不翻转。观战者保持默认视角。
    /// </summary>
    public bool IsBlackView
    {
        get
        {
            if (IsGomoku) return false;
            if (Game == null || User == null) return false;
            if (Game.Players.Count < 2) return false;                       // 人机等单边场景不翻转
            if (!Game.Players.Any(p => p.Id == User.Id)) return false;      // 观战者保持红方视角
            return Game.Players[0].Id != User.Id;                            // 我是黑方才翻转
        }
    }

    /// <summary>当前房间/对局是否为五子棋</summary>
    public bool IsGomoku => (Game?.Type ?? Room?.GameType) == "gomoku";
    public bool IsXiangqi => !IsGomoku;

    private string SideMark(int index) => IsGomoku
        ? (index == 0 ? "⚫黑" : "⚪白")
        : (index == 0 ? "🔴红" : "⚫黑");

    private string SideName(int turn) => IsGomoku
        ? (turn == 0 ? "黑方" : "白方")
        : (turn == 0 ? "红方" : "黑方");

    // ---------------- 棋谱 ----------------

    private void RebuildMoveList()
    {
        MoveList.Clear();
        if (Game == null) return;
        var redId = Game.Players.Count > 0 ? Game.Players[0].Id : null;
        for (int i = 0; i < Game.Moves.Count; i++)
        {
            var m = Game.Moves[i];
            var isFirst = m.Player == redId;
            m.Display = $"第{i + 1}手　{SideMark(isFirst ? 0 : 1)}　{m.Notation}";
            MoveList.Add(m);
        }
    }

    // ---------------- 走子倒计时 ----------------

    private readonly System.Windows.Threading.DispatcherTimer _turnTimer = new()
    {
        Interval = TimeSpan.FromSeconds(1),
    };

    private int _turnRemaining;
    public int TurnRemaining
    {
        get => _turnRemaining;
        private set { if (Set(ref _turnRemaining, value)) OnPropertyChanged(nameof(TurnTimerText)); }
    }

    public string TurnTimerText
    {
        get
        {
            if (Game == null || Game.Over) return "";
            // 人机模式：电脑回合显示思考提示（不显示倒计时）
            if (Room?.Mode == "ai" && Game.Players.Count > Game.Turn && Game.Players[Game.Turn].Name == "电脑")
            {
                return "🤖 电脑思考中";
            }
            var color = SideName(Game.Turn);
            return $"⏱ {color} {Math.Max(0, TurnRemaining)} 秒";
        }
    }

    private void ResetTurnCountdown()
    {
        TurnRemaining = Game?.TimeLimit ?? 0;
        UpdateTurnCountdown();
    }

    private void UpdateTurnCountdown()
    {
        if (Game == null || Game.Over)
        {
            TurnRemaining = 0;
            return;
        }
        var elapsedSec = (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - Game.TurnStartedAt) / 1000.0;
        TurnRemaining = Math.Max(0, Game.TimeLimit - (int)Math.Ceiling(elapsedSec));
    }

    private void OnTurnTimerTick(object? sender, EventArgs e)
    {
        UpdateTurnCountdown();
    }

    // ---------------- 悔棋 ----------------

    private bool _undoPromptVisible;
    public bool UndoPromptVisible
    {
        get => _undoPromptVisible;
        set => Set(ref _undoPromptVisible, value);
    }

    private string _undoFrom = "";
    public string UndoFrom
    {
        get => _undoFrom;
        set { if (Set(ref _undoFrom, value)) OnPropertyChanged(nameof(UndoPromptText)); }
    }

    public string UndoPromptText => $"{UndoFrom} 请求悔棋（撤销最后一步）";

    private Point2? _selectedFrom;
    public Point2? SelectedFrom { get => _selectedFrom; set => Set(ref _selectedFrom, value); }

    public bool CanAction => !Matching;

    public bool IsOwner => Room != null && User != null && Room.OwnerId == User.Id;

    public bool InPlayingGame => Game != null && !Game.Over && Room?.Status == "playing";

    public bool MyTurn
    {
        get
        {
            if (Game == null || Game.Over || User == null) return false;
            return Game.Players.Count > Game.Turn && Game.Players[Game.Turn].Id == User.Id;
        }
    }

    public string TurnText
    {
        get
        {
            if (Game == null) return "";
            if (Game.Over) return ResultText;
            var player = Game.Players.Count > Game.Turn ? Game.Players[Game.Turn] : null;
            // 人机模式：电脑回合显示思考提示
            if (Room?.Mode == "ai" && player?.Name == "电脑")
            {
                return "🤖 电脑思考中…";
            }
            var color = SideName(Game.Turn);
            var check = !IsGomoku && Game.Check != null ? "（将军！）" : "";
            var mine = player?.Id == User?.Id;
            return $"{(mine ? "轮到你了" : $"等待 {player?.Name}")} · {color}走棋{check}";
        }
    }

    public string ResultText
    {
        get
        {
            if (Game == null || !Game.Over) return "";
            if (Game.IsDraw) return $"平局：{Game.Reason}";
            var winnerName = Game.Players.FirstOrDefault(p => p.Id == Game.WinnerId)?.Name ?? "";
            var mine = Game.WinnerId == User?.Id;
            return $"{(mine ? "🎉 你赢了！" : $"😔 {winnerName} 获胜")} — {Game.Reason}";
        }
    }

    public string PlayersInfo
    {
        get
        {
            if (Game == null) return "";
            return string.Join("　", Game.Players.Select((p, i) => $"{SideMark(i)} {p.Name}"));
        }
    }

    public bool CanStart
    {
        get
        {
            if (Room == null || !IsOwner || Room.Status != "waiting") return false;
            return Room.Players.Count >= 2 && Room.Players.All(p => p.Ready);
        }
    }

    public string ReadyButtonText
    {
        get
        {
            if (Room == null || User == null) return "就绪";
            var me = Room.Players.FirstOrDefault(p => p.Id == User.Id);
            return me?.Ready == true ? "取消就绪" : "就绪";
        }
    }

    // ---------------- 命令 ----------------

    public RelayCommand CreateRoomCmd { get; }
    public RelayCommand StartAiCmd { get; }
    public RelayCommand QuickJoinCmd { get; }
    public RelayCommand MatchCmd { get; }
    public RelayCommand LeaveRoomCmd { get; }
    public RelayCommand ReadyCmd { get; }
    public RelayCommand StartCmd { get; }
    public RelayCommand SurrenderCmd { get; }
    public RelayCommand RestartCmd { get; }
    public RelayCommand SendLobbyChatCmd { get; }
    public RelayCommand SendRoomChatCmd { get; }
    public RelayCommand CellClickCmd { get; }
    public RelayCommand SwitchModeCommand { get; }
    public RelayCommand UndoCmd { get; }
    public RelayCommand AgreeUndoCmd { get; }
    public RelayCommand RejectUndoCmd { get; }

    // ---------------- 动作 ----------------

    /// <summary>登录/注册/游客请求的超时控制：10 秒无响应则提示</summary>
    private CancellationTokenSource? _authTimeout;
    private const int AuthTimeoutMs = 10000;

    private void BeginAuthTimeout(string timeoutMessage)
    {
        _authTimeout?.Cancel();
        var cts = new CancellationTokenSource();
        _authTimeout = cts;
        Task.Delay(AuthTimeoutMs, cts.Token).ContinueWith(t =>
        {
            if (t.IsCanceled || cts.IsCancellationRequested) return;
            Ui(() =>
            {
                FormError = timeoutMessage;
                StatusText = timeoutMessage;
            });
        });
    }

    private void CancelAuthTimeout()
    {
        try { _authTimeout?.Cancel(); } catch { /* 忽略 */ }
        _authTimeout = null;
    }

    /// <summary>
    /// 确保已连接到服务器（地址变化时自动切换并重连）。
    /// 地址不合法或连接失败时在表单给出提示并返回 false，绝不抛异常崩溃。
    /// </summary>
    private async Task<bool> EnsureConnectedAsync()
    {
        var err = ServerConnection.ValidateServerUrl(ServerUrl, out var normalized);
        if (err != null)
        {
            FormError = err;
            StatusText = "服务器地址不合法：" + err;
            return false;
        }

        // 地址有变化（含规范化差异）时更新连接目标
        if (!string.Equals(_conn.TargetHttpUrl, normalized, StringComparison.OrdinalIgnoreCase))
        {
            var setErr = _conn.SetServerUrl(normalized);
            if (setErr != null)
            {
                FormError = setErr;
                StatusText = "服务器地址不合法：" + setErr;
                return false;
            }
        }

        if (_conn.IsConnected) return true;

        FormError = "";
        StatusText = "正在连接服务器…";
        _conn.Connect();
        if (await _conn.WaitConnectedAsync(TimeSpan.FromSeconds(12)))
        {
            StatusText = "已连接服务器，请登录或注册";
            return true;
        }

        FormError = "无法连接到服务器，请检查服务器地址和网络";
        StatusText = "连接失败：服务器无响应";
        return false;
    }

    /// <summary>登录</summary>
    public async void LoginAsync()
    {
        var name = LoginName.Trim();
        var pass = LoginPassword;
        if (name.Length == 0 || pass.Length == 0) { FormError = "请输入昵称和密码"; return; }
        if (!await EnsureConnectedAsync()) return;
        FormError = "";
        StatusText = "正在登录…";
        BeginAuthTimeout("登录超时：服务器无响应，请检查网络或服务器地址");
        await _conn.SendAsync("auth.login", new { name, password = pass });
    }

    /// <summary>注册（先本地校验再提交）</summary>
    public async void RegisterAsync()
    {
        ValidateRegister();
        if (!CanRegister)
        {
            if (FormError.Length == 0) FormError = "请完整填写注册信息";
            return;
        }
        if (!await EnsureConnectedAsync()) return;
        var name = RegisterName.Trim();
        FormError = "";
        StatusText = "正在注册…";
        BeginAuthTimeout("注册超时：服务器无响应，请检查网络或服务器地址");
        await _conn.SendAsync("auth.register", new { name, password = RegisterPassword });
    }

    /// <summary>游客进入</summary>
    public async void GuestAsync()
    {
        if (!await EnsureConnectedAsync()) return;
        StatusText = "正在以游客身份进入…";
        BeginAuthTimeout("连接超时：服务器无响应，请检查网络或服务器地址");
        await _conn.SendAsync("auth.guest");
    }

    /// <summary>切换登录/注册表单</summary>
    public void SwitchMode(bool register)
    {
        RegisterMode = register;
        if (register)
        {
            LoginName = "";
            LoginPassword = "";
        }
        else
        {
            RegisterName = "";
            RegisterPassword = "";
            RegisterConfirm = "";
        }
        StatusText = "已连接服务器，请登录或注册";
    }

    /// <summary>重新拉取个人历史战绩</summary>
    public async void RefreshMyMatches()
    {
        if (User == null) return;
        await _conn.SendAsync("matches.get", new { userId = User.Id, limit = 50 });
    }

    /// <summary>重置到登录页（清空会话状态，不处理连接）</summary>
    private void ResetToLogin()
    {
        User = null;
        Room = null;
        Game = null;
        RoomList.Clear();
        Rankings.Clear();
        LobbyChats.Clear();
        RoomChats.Clear();
        MyMatches.Clear();
        MoveList.Clear();
        UndoPromptVisible = false;
        Matching = false;
        CurrentView = ViewMode.Login;
        RegisterMode = false;
    }

    public async void LogoutAsync()
    {
        _conn.Token = "";
        ResetToLogin();
        // 记住账号：退出后恢复填充登录表单，方便下次直接登录
        LoginName = SavedName;
        LoginPassword = SavedPassword;
        RegisterName = "";
        RegisterPassword = "";
        RegisterConfirm = "";
        StatusText = "已退出登录";
        // 断开并重连：让服务器释放当前连接上的登录状态
        await _conn.ReconnectAsync();
        StatusText = "已连接服务器，请登录或注册";
    }

    public async void CreateRoom()
    {
        await _conn.SendAsync("room.create", new
        {
            gameType = SelectedGameType,
            name = RoomNameInput.Trim(),
            password = string.IsNullOrEmpty(RoomPasswordInput) ? null : RoomPasswordInput,
            @private = RoomPrivateInput,
        });
        RoomNameInput = "";
        RoomPasswordInput = "";
        RoomPrivateInput = false;
    }

    public async void JoinRoom(string roomId, bool hasPassword)
    {
        string? password = null;
        if (hasPassword)
        {
            var dlg = new InputDialog("房间密码", $"房间 {roomId} 需要密码：");
            if (dlg.ShowDialog() != true) return;
            password = dlg.Value;
        }
        await _conn.SendAsync("room.join", new { roomId, password });
    }

    /// <summary>
    /// 匹配开关。匹配模式暂未开放：按钮已禁用，正常流程不会走到这里。
    /// 若服务器仍有遗留的匹配会话（如上次匹配后掉线重连），仍允许取消排队；
    /// 后期恢复匹配时，只需在 else 分支重新发送 match.enqueue 并放开按钮即可。
    /// </summary>
    public async void ToggleMatch()
    {
        if (Matching) await _conn.SendAsync("match.dequeue");
        else Ui(() => StatusText = "匹配模式开发中，敬请期待");
    }

    public async void ToggleReady()
    {
        if (Room == null || User == null) return;
        var me = Room.Players.FirstOrDefault(p => p.Id == User.Id);
        await _conn.SendAsync("room.ready", new { ready = !(me?.Ready ?? false) });
    }

    private async void SendLobbyChat()
    {
        var text = LobbyChatInput.Trim();
        if (text.Length == 0) return;
        await _conn.SendAsync("chat.send", new { text, scope = "lobby" });
        LobbyChatInput = "";
    }

    private async void SendRoomChat()
    {
        var text = RoomChatInput.Trim();
        if (text.Length == 0) return;
        await _conn.SendAsync("chat.send", new { text, scope = "room" });
        RoomChatInput = "";
    }

    /// <summary>棋盘点击：象棋选子再走；五子棋直接在空点落子</summary>
    private async void OnCellClick(Point2 cell)
    {
        if (Game == null || Game.Over || !MyTurn) return;
        if (IsGomoku)
        {
            var occupied = GetPiece(Game, cell);
            if (occupied != null) return;
            await _conn.SendAsync("game.move", new { move = new { x = cell.X, y = cell.Y } });
            return;
        }
        var piece = GetPiece(Game, cell);
        if (SelectedFrom == null)
        {
            if (piece != null && IsMyPiece(piece))
            {
                SelectedFrom = cell;
                SoundService.PlaySelect();
            }
            return;
        }
        var from = SelectedFrom;
        SelectedFrom = null;
        if (from.X == cell.X && from.Y == cell.Y) return;
        await _conn.SendAsync("game.move", new { move = new { from = new { x = from.X, y = from.Y }, to = new { x = cell.X, y = cell.Y } } });
    }

    private static string? GetPiece(GameState g, Point2 c)
        => g.Board != null && c.Y < g.Board.Length && c.X < (g.Board[c.Y]?.Length ?? 0) ? g.Board[c.Y][c.X] : null;

    private bool IsMyPiece(string code)
    {
        if (Game == null || User == null) return false;
        var myColor = Game.Players.Count > 0 && Game.Players[0].Id == User.Id ? 'r' : 'b';
        return code.Length > 0 && code[0] == myColor;
    }

    // ---------------- 消息处理 ----------------

    private void OnMessage(string type, JsonElement payload)
    {
        switch (type)
        {
            case "s.welcome":
                // 有令牌自动登录；无令牌停留在登录页由用户选择
                if (!string.IsNullOrEmpty(_conn.Token))
                {
                    BeginAuthTimeout("自动登录超时：服务器无响应，请检查网络或服务器地址");
                    _ = _conn.AuthWithTokenAsync(_conn.Token);
                }
                else
                    Ui(() => StatusText = "已连接服务器，请登录或注册");
                break;
            case "s.auth.ok":
                OnAuthOk(payload);
                break;
            case "s.me.state":
                OnMeState(payload);
                break;
            case "s.room.list":
                OnRoomList(payload);
                break;
            case "s.room.joined":
                OnRoomJoined(payload);
                break;
            case "s.room.update":
                OnRoomUpdate(payload);
                break;
            case "s.room.left":
                OnRoomLeft(payload);
                break;
            case "s.game.start":
                OnGameStart(payload);
                break;
            case "s.game.state":
            case "s.game.move":
            case "s.game.restarted":
                SetGame(ExtractGame(payload));
                break;
            case "s.game.over":
                SetGame(ExtractGame(payload));
                StatusText = ResultText;
                UndoPromptVisible = false;
                RefreshMyMatches(); // 对局结束后刷新个人战绩
                break;
            case "s.undo.requested":
                OnUndoRequested(payload);
                break;
            case "s.undo.response":
                Ui(() =>
                {
                    var agree = payload.TryGetProperty("agree", out var a) && a.GetBoolean();
                    var byName = payload.TryGetProperty("byName", out var n) ? n.GetString() : "对方";
                    StatusText = agree ? "对方同意了悔棋请求" : $"{byName} 拒绝了悔棋请求";
                });
                break;
            case "s.undo.done":
                Ui(() =>
                {
                    UndoPromptVisible = false;
                    SetGame(ExtractGame(payload));
                    StatusText = "悔棋成功，已撤销最后一步";
                });
                break;
            case "s.undo.cancelled":
                Ui(() =>
                {
                    StatusText = payload.TryGetProperty("reason", out var r) ? r.GetString() ?? "悔棋请求已取消" : "悔棋请求已取消";
                });
                break;
            case "s.rating.update":
                OnRatingUpdate(payload);
                break;
            case "s.match.queued":
                Ui(() => { Matching = true; StatusText = "正在匹配对手…"; });
                break;
            case "s.match.found":
                Ui(() => { Matching = false; StatusText = "匹配成功！"; });
                break;
            case "s.match.timeout":
                Ui(() => { Matching = false; StatusText = "匹配超时，请重试"; });
                break;
            case "s.match.left":
                Ui(() => { Matching = false; StatusText = "已取消匹配"; });
                break;
            case "s.matches":
                Ui(() =>
                {
                    MyMatches.Clear();
                    if (payload.TryGetProperty("matches", out var arr))
                        foreach (var m in arr.EnumerateArray())
                            MyMatches.Add(m.Deserialize<MatchRecord>(ServerConnection.JsonOpts)!);
                });
                break;
            case "s.chat":
                OnChat(payload);
                break;
            case "s.chat.history":
                Ui(() =>
                {
                    LobbyChats.Clear();
                    if (payload.TryGetProperty("messages", out var arr))
                        foreach (var m in arr.EnumerateArray())
                        {
                            var cm = m.Deserialize<ChatMessage>(ServerConnection.JsonOpts);
                            if (cm == null) continue;
                            cm.IsSystem = cm.From == "系统";
                            cm.IsMine = !cm.IsSystem && (cm.FromId == User?.Id || cm.From == User?.Name);
                            LobbyChats.Add(cm);
                        }
                });
                break;
            case "s.ranking":
                Ui(() =>
                {
                    Rankings.Clear();
                    if (payload.TryGetProperty("rankings", out var arr))
                        foreach (var r in arr.EnumerateArray())
                            Rankings.Add(r.Deserialize<RankItem>(ServerConnection.JsonOpts)!);
                });
                break;
            case "s.auth.kicked":
                // 账号在其他设备登录（顶号下线）：清除令牌并断开，避免自动重连被反复顶号
                Ui(() =>
                {
                    _conn.Token = "";
                    _conn.Close();
                    Connected = false;
                    ResetToLogin();
                    var kickMsg = payload.TryGetProperty("message", out var k) ? k.GetString() : "您的账号已在其他设备登录，请重新登录";
                    FormError = kickMsg ?? "您的账号已在其他设备登录，请重新登录";
                    StatusText = kickMsg ?? "您的账号已在其他设备登录，请重新登录";
                });
                break;
            case "s.error":
                OnError(payload);
                break;
        }
    }

    private void OnAuthOk(JsonElement payload)
    {
        CancelAuthTimeout();
        Ui(() =>
        {
            User = payload.TryGetProperty("user", out var u) ? u.Deserialize<UserInfo>(ServerConnection.JsonOpts) : null;
            if (payload.TryGetProperty("token", out var t)) _conn.Token = t.GetString() ?? "";
            if (User != null)
            {
                // 正式账号登录/注册成功：更新记住的账号（若勾选）
                if (!User.IsGuest && RememberAccount)
                {
                    SavedName = User.Name;
                    SavedPassword = RegisterMode ? RegisterPassword : LoginPassword;
                    // 注册成功后切回登录表单并填充账号，方便下次直接登录
                    if (RegisterMode)
                    {
                        RegisterMode = false;
                        LoginName = User.Name;
                        LoginPassword = SavedPassword;
                    }
                }
                CurrentView = ViewMode.Lobby;
                StatusText = $"欢迎，{User.Name}！";
                RefreshMyMatches();
            }
        });
    }

    private void OnMeState(JsonElement payload)
    {
        Ui(() =>
        {
            if (payload.TryGetProperty("user", out var u)) User = u.Deserialize<UserInfo>(ServerConnection.JsonOpts);
            Room = payload.TryGetProperty("room", out var r) && r.ValueKind == JsonValueKind.Object
                ? r.Deserialize<RoomInfo>(ServerConnection.JsonOpts) : null;
            Matching = payload.TryGetProperty("matching", out var m) && m.ValueKind == JsonValueKind.Object;
            Game = Room?.Game;
            CurrentView = Room != null ? ViewMode.Room : ViewMode.Lobby;
            SelectedFrom = null;
            OnPropertyChanged(nameof(CanStart));
            if (User != null) RefreshMyMatches();
        });
    }

    private void OnRoomList(JsonElement payload)
    {
        Ui(() =>
        {
            RoomList.Clear();
            if (payload.TryGetProperty("rooms", out var arr))
                foreach (var r in arr.EnumerateArray())
                    RoomList.Add(r.Deserialize<RoomListItem>(ServerConnection.JsonOpts)!);
        });
    }

    private void OnRoomJoined(JsonElement payload)
    {
        Ui(() =>
        {
            Room = payload.TryGetProperty("room", out var r) ? r.Deserialize<RoomInfo>(ServerConnection.JsonOpts) : null;
            Game = Room?.Game;
            SelectedFrom = null;
            CurrentView = ViewMode.Room;
            OnPropertyChanged(nameof(CanStart));
            StatusText = Room != null ? $"已进入房间 {Room.Name}" : "加入房间失败";
        });
    }

    private void OnRoomUpdate(JsonElement payload)
    {
        Ui(() =>
        {
            if (payload.TryGetProperty("room", out var r))
            {
                var updated = r.Deserialize<RoomInfo>(ServerConnection.JsonOpts);
                if (Room != null && updated != null && updated.Id == Room.Id)
                {
                    Room = updated;
                    Game = updated.Game;
                    OnPropertyChanged(nameof(CanStart));
                }
            }
        });
    }

    private void OnRoomLeft(JsonElement payload)
    {
        Ui(() =>
        {
            var kicked = payload.TryGetProperty("kicked", out var k) && k.GetBoolean();
            Room = null;
            Game = null;
            RoomChats.Clear();
            SelectedFrom = null;
            CurrentView = ViewMode.Lobby;
            StatusText = kicked ? "你已被移出房间" : "已离开房间";
        });
    }

    private void OnGameStart(JsonElement payload)
    {
        Ui(() =>
        {
            SetGame(ExtractGame(payload));
            StatusText = IsGomoku ? "对局开始！黑方先行" : "对局开始！红方先行";
        });
    }

    private void SetGame(GameState? g)
    {
        Ui(() =>
        {
            Game = g;
            SelectedFrom = null;
        });
    }

    private static GameState? ExtractGame(JsonElement payload)
        => payload.TryGetProperty("game", out var g) ? g.Deserialize<GameState>(ServerConnection.JsonOpts) : null;

    private void OnRatingUpdate(JsonElement payload)
    {
        Ui(() =>
        {
            if (User == null || !payload.TryGetProperty("users", out var arr)) return;
            foreach (var u in arr.EnumerateArray())
            {
                var info = u.Deserialize<UserInfo>(ServerConnection.JsonOpts);
                if (info?.Id == User.Id) { User = info; break; }
            }
        });
    }

    private void OnChat(JsonElement payload)
    {
        Ui(() =>
        {
            var msg = payload.Deserialize<ChatMessage>(ServerConnection.JsonOpts);
            if (msg == null) return;
            msg.IsSystem = msg.From == "系统";
            msg.IsMine = !msg.IsSystem && (msg.FromId == User?.Id || msg.From == User?.Name);
            if (msg.Scope == "lobby") LobbyChats.Add(msg);
            else RoomChats.Add(msg);
            while (LobbyChats.Count > 100) LobbyChats.RemoveAt(0);
            while (RoomChats.Count > 100) RoomChats.RemoveAt(0);
        });
    }

    private void OnUndoRequested(JsonElement payload)
    {
        Ui(() =>
        {
            var byName = payload.TryGetProperty("byName", out var n) ? n.GetString() : "对方";
            var mine = payload.TryGetProperty("mine", out var m) && m.GetBoolean();
            if (mine)
            {
                StatusText = "已发送悔棋请求，等待对方回应…";
            }
            else
            {
                UndoFrom = byName ?? "对方";
                UndoPromptVisible = true;
            }
        });
    }

    private void OnError(JsonElement payload)
    {
        CancelAuthTimeout();
        Ui(() =>
        {
            var msg = payload.TryGetProperty("message", out var m) ? m.GetString() : "操作失败";
            var code = payload.TryGetProperty("code", out var c) ? c.GetString() : "";
            // 令牌失效（已过期 / 被其他设备顶号）：清除本地令牌，避免反复自动重登
            if (code == "AUTH_TOKEN_INVALID")
            {
                _conn.Token = "";
                Connected = false;
                if (CurrentView != ViewMode.Login) ResetToLogin();
            }
            // 在登录/注册表单时，错误显示在表单提示区
            if (CurrentView == ViewMode.Login)
            {
                FormError = msg ?? "操作失败";
            }
            StatusText = msg ?? "操作失败";
        });
    }

    private void OnStatusChanged(bool connected)
    {
        Ui(() => { Connected = connected; });
    }

    private static void Ui(Action action)
    {
        var app = Application.Current;
        if (app == null) { action(); return; }
        if (app.Dispatcher.CheckAccess()) action();
        else app.Dispatcher.Invoke(action);
    }
}
