# ⚔️ 对战平台 · 中国象棋（WPF 客户端 + Node.js 服务器）

一套完整的**联网中国象棋对战平台**：Node.js 服务器（用户 / 房间 / 匹配 / 排行榜 / 聊天 / 战绩持久化）+ **WPF 桌面客户端**（登录、大厅、实时棋盘对战）。支持局域网联机、观战、断线重连、ELO 积分。

## 快速开始

```bash
# 1. 启动服务器（默认端口 8080，已装 Node.js ≥ 18）
npm install
npm start

# 2. 启动 WPF 客户端（已装 .NET SDK 9）
dotnet build client/XiangqiClient/XiangqiClient.csproj
dotnet run --project client/XiangqiClient
# 或直接运行构建产物：client/XiangqiClient/bin/Debug/net9.0-windows/对战平台.exe
```

> 局域网联机：服务器监听 `0.0.0.0`，其他电脑的客户端在登录页把"服务器地址"改为 `http://<服务器IP>:8080` 即可。
> 自定义端口：`PORT=9000 npm start`。

## 客户端界面（WPF）

| 视图 | 功能 |
|---|---|
| 登录页 | 登录/注册双表单切换；注册含**确认密码**与**实时校验**（昵称格式、密码长度、两次一致，不通过则禁用注册按钮）；**记住账号**（勾选后本地保存昵称与密码，下次自动填充，令牌自动登录）；服务器地址、游客体验 |
| 大厅 | 创建房间（可设密码/私密）、**🤖 人机对战（和电脑下棋）**、快速加入、一键匹配、房间列表（双击加入）、**排行榜**、**我的战绩（个人历史对局）**、气泡式大厅聊天 |
| 房间 | 玩家席位与就绪状态、就绪/开始（房主）/**悔棋**/认输/再来一局/离开；**棋谱面板**（每一步中文着法，如"炮二进五"）；**每步倒计时**（超时判负）；气泡式房间聊天 |
| 棋盘 | Canvas 绘制的 9×10 象棋盘（河界、九宫、炮/兵位点），**上/下边带标准路号**（上边黑方阿拉伯数字 1-9 从左到右、下边红方中文数字 九-一 从右到左，黑方视角自动镜像保持标准读法），红黑棋子，点击选子/走子，选中与最后一步高亮，被将军方老将红圈警示 |
| 音效 | **走子音效**（棋子落盘"咔哒"，吃子时用更沉闷的"啪"）、**大厅背景音乐**（进入大厅自动循环播放，进房间/退出登录自动停止） |

> **背景音乐替换**：客户端默认播放内置的原创占位曲（五声音阶弹拨循环，`tools/gen-audio.ps1` 可重新生成）。想用腾讯 QQ 中国象棋原版音乐时，把原版音频文件命名为 **`bgm.mp3`**（或 `bgm.wav`）放到客户端 exe 同目录即可，客户端会优先加载它，无需重新编译。

> **单人模式**：大厅点"🤖 人机对战"即可和电脑下棋——电脑由 eleeye（象眼）引擎驱动（约 1.5 秒/步思考，可 `AI_THINK_MS` 调节），自动就绪、自动回应（带"电脑思考中"提示与棋谱记录），电脑回合不倒计时；单人模式下悔棋直接生效（无需同意）。人机对局记录计入"我的战绩"。
> 聊天为消息气泡样式（发送者头像圆点 + 圆角气泡）：自己的消息右对齐蓝色气泡、对方左对齐深色气泡、系统消息居中灰字；**输入框固定在窗口右底部**（大圆角输入框 + 蓝色发送按钮）。
> 悔棋（双人）需对方同意：任一方点击"悔棋"→ 对方收到提示 → 同意则撤销最后一步并重新计时。
> 按钮可用性实时刷新：双方就绪后"开始对局"立即可用、对局开始后"悔棋/认输"立即可用（状态变化自动刷新命令状态）。

## 服务器功能

- 👤 用户系统：注册 / 登录 / 游客；密码 scrypt 加盐哈希；会话令牌
- 🚪 房间系统：创建（密码 / 私密）、加入、邀请码（房间 ID）、快速加入、就绪、踢人、观战（最多 8 人）
- ⚡ 匹配系统：同游戏玩家自动配对建房开局
- 🏆 排行榜：ELO 积分（K=32），胜/负/平统计，TOP 50
- 📜 历史战绩：每局对局完整入库（玩家、胜负、原因、步数、时间），支持按用户查询个人战绩（WS `matches.get` / REST `GET /api/matches?user=<id>`）
- ♻️ 悔棋：对局中任一方请求悔棋，对方同意后撤销最后一步（含被吃子恢复、回合回退、重新计时）
- ⏱️ 走子倒计时：每步限时（默认 60 秒，`MOVE_TIME_LIMIT` 环境变量可调），**超时未走子自动判负**；对局状态携带每步时间戳供客户端倒计时
- 🤖 AI 引擎：接入开源强引擎 **eleeye（象眼）v3.31**（UCCI 协议，LGPL 自由使用，二进制位于 `engines/eleeye.exe`，已编译随项目提供）；服务端权威走棋，电脑不参与超时；引擎不可用时自动回退内置 minimax AI（`src/games/xiangqi-ai.js`）
- 📜 棋谱：每步棋自动生成中文着法记录（如"炮二进五""马八进七"，含同列前/中/后区分）
- 💬 聊天：大厅全局广播 + 房间内聊天
- 🗄️ 持久化：**SQLite**（Node 内置 `node:sqlite`，零外部依赖），数据存于 `data/platform.db`，ACID 事务写入，重启不丢数据
- 🔌 稳定性：心跳检测、断线自动重连；正式账号 60 秒内重连恢复对局，游客掉线即时判负

## 中国象棋规则引擎（服务端权威判定）

完整实现 `src/games/xiangqi.js`：
- 棋子：将/帅、士/仕、象/相、马、车、炮、兵/卒 共 32 子，红先
- 走法：车直线、炮隔子打、马蹩马腿、象塞象眼不过河、士/将九宫、兵过河后可横走
- 规则：将帅照面判定、将军检测、禁止送将（走子后己方被将拒绝）、将死/困毙判胜、吃将获胜、认输
- 走子格式：`{ from: {x,y}, to: {x,y} }`，坐标 x∈[0,8]、y∈[0,9]，红方在下

## 项目结构

```
src/
├── index.js            # 入口
├── config.js
├── net/gateway.js      # WebSocket 网关（鉴权/路由/心跳/聊天）
├── net/protocol.js     # 消息协议与错误码
├── http/server.js      # REST API
├── core/               # user（用户/积分/战绩）、room（房间）、matchmaker（匹配）
├── games/xiangqi.js    # 中国象棋规则引擎（可扩展其他游戏）
└── db/store.js         # SQLite 持久化（node:sqlite）

client/XiangqiClient/   # WPF 客户端（.NET 9，无第三方依赖）
├── Services/ServerConnection.cs   # WebSocket 客户端（自动重连）
├── Services/SoundService.cs       # 走子/吃子音效 + 大厅背景音乐（可替换原版音乐）
├── ViewModels/MainViewModel.cs    # 状态与消息处理
├── Controls/XiangqiBoard.cs       # 象棋棋盘控件（Canvas，含上下边路号）
├── Views/                          # 登录 / 大厅 / 房间 三视图
├── Assets/                         # 图标与音频资源（move.wav / capture.wav / bgm.wav）
└── Models/                         # 数据模型
```

## 日志系统

服务器自带完整日志系统（控制台 + 文件 + REST 查询），无需额外配置：

| 查看方式 | 说明 |
|---|---|
| **日志文件** | `logs/app-YYYY-MM-DD.log`（按天轮转，UTF-8 追加写），记录时间戳/级别/模块/消息/JSON 详情 |
| **控制台** | 启动服务器的终端同步输出（与文件同格式） |
| **REST 查询** | `GET http://<服务器>:8080/api/logs?lines=200` 返回最近日志（含当前日志文件路径） |

**日志级别**（环境变量 `LOG_LEVEL` 控制，默认 `INFO`）：

| 级别 | 记录内容 |
|---|---|
| `DEBUG` | 所有 WebSocket 请求、每步走子、聊天内容、HTTP 请求 |
| `INFO`（默认） | 连接建立/断开、注册/登录/游客、建房/加入/离开/就绪/踢人、对局开始/结束（含胜负与步数）、认输、匹配入队/配对/超时、SQLite 落盘、服务器启停 |
| `WARN` | 登录失败、走子被拒、建房失败等业务异常 |
| `ERROR` | 服务器内部错误、SQLite 写入失败 |

示例（`LOG_LEVEL=DEBUG npm start` 后）：

```
[2026-08-19 13:17:41.316] [DEBUG] [ws] 收到请求 {"type":"auth.guest","userId":null}
[2026-08-19 13:17:41.317] [INFO] [auth] 鉴权成功 {"userId":"19","name":"游客6748","isGuest":true,"resumedRoom":null,"onlineSockets":1}
[2026-08-19 13:17:41.318] [DEBUG] [chat] lobby 聊天 {"userId":"19","from":"游客6748","text":"你好"}
[2026-08-19 13:17:08.290] [INFO] [game] 对局结束 {"roomId":"UG9N4G","game":"xiangqi","moves":6,"winnerId":"5","isDraw":false,"reason":"棋手B65763 认输","players":[{"id":"5","name":"棋手A65917"}]}
```

模块标识：`server` / `store` / `log` / `http` / `ws`（连接与请求）/ `auth` / `room` / `match` / `game` / `chat`。

## 测试

```bash
# 服务器端（需先 npm start）
npm test
#   1) test/xiangqi.test.js     象棋规则单元测试 77 项（走法/蹩腿/塞象眼/照面/将军/送将/将死/认输/着法/悔棋）
#   2) test/xiangqi-ai.test.js  AI 引擎 18 项（合法走法/吃将/应将/评估/交替对局）
#   2b) test/eleeye.test.js     eleeye（象眼）UCCI 引擎 5 项（握手/初始局面/应手/多步局面）
#   3) test/room.test.js        房间层 31 项（悔棋流程、走子超时判负、人机模式自动走子/不超时/悔棋）
#   4) test/e2e.test.js         协议级端到端 40 项（注册/建房/对局/匹配/观战/掉线/聊天/REST/重连）

# 客户端 UI 自动化（需 Windows 桌面，可选）
powershell -ExecutionPolicy Bypass -File test/client-uia.ps1        # 单客户端：登录→大厅→建房→棋盘
powershell -ExecutionPolicy Bypass -File test/client-uia-full.ps1   # 双客户端：加入→就绪→开局→走子→认输→战绩
powershell -ExecutionPolicy Bypass -File test/client-uia-features.ps1  # 棋谱/倒计时/悔棋/聊天气泡
powershell -ExecutionPolicy Bypass -File test/client-uia-ai.ps1     # 单人模式：人机开局→走子→电脑回应
powershell -ExecutionPolicy Bypass -File test/client-uia-match.ps1   # 匹配模式已禁用（开发中）：校验匹配按钮存在且置灰
powershell -ExecutionPolicy Bypass -File test/client-uia-remember.ps1  # 记住账号：注册→关闭→重开→自动填充登录
```

## WebSocket 协议速览

客户端请求（JSON `{ type, ... }`）：`auth.login/register/guest`、`room.create/join/leave/ready/start/kick/quickJoin`、`match.enqueue/dequeue`、`game.move`（`{move:{from,to}}`）、`game.surrender/restart`、`chat.send`、`ranking.get`。

服务端事件（前缀 `s.`）：`s.welcome`、`s.auth.ok`、`s.me.state`、`s.room.list/joined/update/left`、`s.game.start/state/move/over/restarted`、`s.match.queued/found/timeout/left`、`s.chat`、`s.ranking`、`s.rating.update`、`s.error`。详见 `src/net/protocol.js`。

## 部署与外网访问

### 方式一：本机 + Cloudflare 快速隧道（零注册，立即外网可连）

无需注册任何账号，把本机 8080 端口暴露到外网（支持 HTTPS 与 WebSocket）：

```bash
# 1. 下载 cloudflared（https://github.com/cloudflare/cloudflared/releases，选择 cloudflared-windows-amd64.exe）
# 2. 启动快速隧道（服务器需已在 8080 运行）
cloudflared.exe tunnel --url http://127.0.0.1:8080 --no-autoupdate --protocol http2
# 3. 终端会输出外网地址：https://xxxx.trycloudflare.com
```

- 其他电脑的客户端在登录页把"服务器地址"填成该 HTTPS 地址即可联网对战
- 浏览器也可直接打开该地址查看 `/admin` 数据管理页
- ⚠️ 免费快速隧道域名随机、重连会变化、无 uptime 保证；且依赖到 Cloudflare 边缘的 **7844 端口**，部分网络（防火墙/运营商）会封锁该端口导致隧道不可用，适合临时测试

### 方式二：cpolar 内网穿透（国内稳定，推荐免费方案）

当网络封锁 Cloudflare 隧道端口时，可用国内穿透服务 cpolar（已随项目安装于 `cpolar/cpolar.exe`，走国内服务器 443 端口，国内访问快）：

```bash
# 1. 注册 https://www.cpolar.com 免费账号（手机号），登录后在"验证"页复制 authtoken
# 2. 绑定本机 token
cpolar\cpolar.exe authtoken <你的authtoken>
# 3. 创建 HTTP 隧道（服务器需已在 8080 运行）
cpolar\cpolar.exe http 8080
# 4. 终端输出外网地址 https://xxxx.cpolar.cn（免费版域名随机，控制台可查看）
```

- 客户端"服务器地址"填 cpolar 的 HTTPS 地址即可；浏览器可打开 `/admin`
- 免费版带宽有限（1Mbps 左右），适合小规模对战；也可在 cpolar 后台升级固定域名

### 方式三：Render 免费托管（固定域名，长期可用）

项目已附带 `Dockerfile`（自动编译 Linux 版 eleeye 引擎）与 `render.yaml`：

1. 把项目推送到 GitHub 仓库（含 `Dockerfile`、`render.yaml`、`src/`、`package.json`）
2. 注册 https://render.com （免费）→ New → **Blueprint** → 选择该仓库
3. 等待构建部署完成，获得固定域名 `https://battle-platform.onrender.com`
4. 客户端服务器地址填 `https://battle-platform.onrender.com`

> 注意：Render 免费实例约 15 分钟无流量会休眠（下次访问冷启动较慢），适合中小规模使用。
> `PORT`、`MOVE_TIME_LIMIT`、`AI_THINK_MS` 等可在 Render 环境变量中调整。

## 查看数据库（注册用户数据）

数据保存在 SQLite 文件 `data/platform.db`（`users` 表 = 用户/积分/战绩，`matches` 表 = 历史对局），三种查看方式：

### 1️⃣ 网页数据管理页（最直观，推荐）

浏览器打开 **`http://<服务器>:8080/admin`**：

- 顶部统计卡片：正式用户数、游客数、**当前在线人数**、历史对局数
- **用户表**：ID、昵称、类型（正式/游客）、积分、胜/负/平、注册时间、最后在线，支持**按昵称搜索**与分页
- **对局表**：时间、红方、黑方、结果、步数、结束原因
- **导出 CSV** 按钮：一键导出当前视图全部数据（Excel 可直接打开）
- 在线数每 5 秒自动刷新

### 2️⃣ REST 接口（程序化查询）

| 接口 | 说明 |
|---|---|
| `GET /api/admin/stats` | 统计概览（用户数/游客数/在线数/对局数） |
| `GET /api/admin/users?search=&page=&pageSize=` | 用户列表（可按昵称搜索、分页） |
| `POST /api/admin/users` | 创建正式用户（`{ name, password }`，与注册规则一致） |
| `DELETE /api/admin/users?id=` | 删除用户（正式/游客均可；在线账号会被立即顶下线，历史对局记录保留） |
| `GET /api/admin/matches?page=&pageSize=` | 对局列表（分页） |
| `GET /api/leaderboard` | 排行榜（正式用户按积分） |
| `GET /api/matches?user=<id>` | 指定用户的个人对局 |
| `GET /api/users/me`（Bearer 令牌） | 当前用户信息 |

### 3️⃣ 命令行直接查库（Node 内置 sqlite）

```bash
# 查所有注册用户
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/platform.db');console.table(db.prepare('SELECT id,name,is_guest,rating,wins,losses,draws FROM users').all())"

# 查所有对局
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/platform.db');console.table(db.prepare('SELECT * FROM matches').all())"
```

> **WAL 与主文件更新说明**：SQLite 以 WAL 模式运行，写入先进入 `platform.db-wal`，主文件 `platform.db` 每隔 10 秒自动合并一次（服务器内置周期 checkpoint），优雅关闭时也会完整合并。因此：直接查看/备份 `platform.db` 前，可先执行 `PRAGMA wal_checkpoint(TRUNCATE)` 强制合并（`stop-external.ps1` 停服前会自动执行）；强杀进程（`Stop-Process -Force`）不会触发合并，但数据不会丢失，下次任何进程打开数据库都会自动恢复。

## REST API（辅助）

`POST /api/auth/register|login|guest`、`GET /api/users/me`、`GET /api/rooms`、`GET /api/games`、`GET /api/leaderboard`、`GET /api/matches`、`GET /api/health`。

## 说明与限制

- 面向局域网/小规模对战场景；生产部署前建议增加速率限制与鉴权加固。
- 游客不参与排行榜，掉线即离房；正式账号可断线重连恢复。
- 数据存于 SQLite 文件 `data/platform.db`，删除该目录即重置平台。
