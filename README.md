# FlowProbe

一款 Codex 桌面版风格的**多协议网络与串口调试台**。把日常调试最常用的连接、收发、Mock、接口测试集中到一个桌面应用里，统一的「连接 → 发送 → 接收 → 观察」工作流。

名字取自工具本身在做的事：报文在链路上流动（flow），工具在链路中间下一根探针（probe），把流过的每一帧截下来看清楚。图标就是这个意思——三条数据流线，中间一条在探针处断开。

界面文案是中文，但应用名、安装包名、窗口标题一律用英文 `FlowProbe`：这些字符串会进入文件系统路径、快捷方式、进程名与命令行，中文在这些位置容易碰上编码与转义问题。

> **本文档面向开发与维护**：讲架构、设计取舍、打包与发布。**功能怎么用**看下面两份面向使用者的文档。

- 平台：Windows / macOS / Linux
- 技术栈：Electron 31 + React 18 + TypeScript + Zustand，electron-vite 构建，electron-builder 打包
- 当前版本：**1.21.4**

---

## 一、功能文档在哪

功能清单**只维护一份**，就在发布仓库的门面说明里。以前主 README 也抄一份，结果是同一个功能有两处描述、改一处忘一处，读者还不知道该信哪份。

| 想知道什么 | 看这里 |
|-----------|--------|
| 有哪些模块、每个模块能做什么、可选值有哪些 | [client-readme/README.md](client-readme/README.md)（[English](client-readme/README.en.md)）——「模块与可用功能一览」+「功能详解」|
| 具体怎么操作、界面在哪点、遇到问题怎么查 | [docs/使用文档.md](docs/使用文档.md) 十七章手册，与应用内 `F1` 面板同源 |
| 需求边界、模块拆分依据、里程碑 | [docs/需求与架构设计.md](docs/需求与架构设计.md) |
| 怎么发一版、双仓库怎么分工 | [docs/发布与自动更新.md](docs/发布与自动更新.md) |

两份使用者文档都不手工维护重复内容：`docs/使用文档.md` 由 `npm run docs:guide` 从应用内文档数据生成，客户端 README 由 `npm run publish:readme` 推到发布仓库。

### 模块与代码位置对照

从功能反查代码时用这张表。适配器一律「一个协议一个文件」，共用逻辑下沉到 `codec/` 与 `modbus/`。

| 模块 | 主进程 | 渲染进程 |
|------|--------|---------|
| TCP 客户端 / 服务端 | `adapters/tcp-client.ts` · `tcp-server.ts` | `features/sessions/` |
| UDP 客户端 / 服务端 | `adapters/udp-client.ts` · `udp-server.ts` | `features/sessions/` |
| WebSocket 客户端 / 服务端 | `adapters/ws-client.ts` · `ws-server.ts` | `features/sessions/` |
| 串口 | `adapters/serial.ts` | `features/sessions/` |
| MQTT 客户端 | `adapters/mqtt-client.ts` | `features/mqtt/` |
| Modbus 主站 | `adapters/modbus.ts` + `modbus/`（PDU / CRC / 字序 / 批量读合并）| `features/modbus/` |
| Modbus 从站模拟 | `adapters/modbus-slave.ts` + `modbus/slave.ts`（数据区内核）| `features/modbus/SlavePanel.tsx` |
| HTTP Mock 服务 | `adapters/http-mock.ts` + `http-mock/`（路由 / 模板 / vm 沙箱）| `features/http-mock/` |
| HTTP 接口测试 | `http-test/`（认证 / 重定向 / 解压）| `features/http-test/` |
| 报文历史 | `history/`（SQLite 落库 + CSV 序列化）| `features/history/` · `features/search/` |
| 告警 | 判定挂在收帧路径上 | `features/alerts/`（`alertEval` / `alertRuntime` / `cooldown`）|
| 自签证书 | `tls/`（手写 ASN.1）| `features/http-mock/CertPanel.tsx` |
| 自动更新 | `updater.ts` | `features/help/UpdateDialog.tsx` |
| 使用文档 | — | `features/help/guideContent.ts` → `GuidePanel` / `guideMarkdown` |

---

## 二、架构与关键设计取舍

这一节是本文档的主体：**为什么这样实现**。功能清单会过时，取舍背后的理由不会——它决定了下一次改动该往哪边靠。

### 进程分工

所有 IO 都在主进程：socket、串口、HTTP 服务、SQLite 写入、HTTP 请求发送。渲染进程只做展示与配置编辑，通过 typed preload（`contextBridge`）拿到受控 API。

这么分不是为了「符合 Electron 惯例」，而是三个具体好处：

- **接口测试不受 CORS 限制**。请求由主进程发出，任意接口都能直接调。放在渲染进程就得为每个被测服务操心跨域。
- **异常隔离到会话级**。一个适配器抛错只影响它自己的会话，其余会话照跑。
- **导出不搬大对象**。历史 CSV 的查询与序列化都在主进程完成，十万行不必经 IPC 搬到界面层再拼字符串。

会话生命周期统一由 `session-manager.ts` 管，适配器只实现「启动 / 停止 / 发送 / 事件上报」四件事。新增协议时不需要碰界面骨架。

### 协议语义不做统一抽象

最容易犯的错是把「连接」抽象成一个通用概念，然后给每种协议都配上重连、结束符、切帧。实际结果是界面给出错误的心理暗示。

| 协议 | 刻意不提供 | 原因 |
|------|-----------|------|
| UDP | 断线重连、切帧、结束符 | 没有连接就没有断线，重连退避是空转；一个数据报天生就是一帧，再拆一遍只会把正确的边界切碎 |
| WebSocket / MQTT | 结束符 | 协议自带消息边界，追加 CRLF 只会污染载荷 |
| MQTT / Modbus | 报文规则应答 | 前者语义单元是主题 + 载荷，后者有严格请求应答时序，按字节匹配都对不上 |
| Modbus | 发送编码切换 | 纯二进制帧，切 TEXT 必然发废帧，所以标「HEX 固定」|
| 服务端类型 | 监听失败后退避重连 | 端口被占用是配置问题，反复重试只会把真正的原因藏起来 |

UDP 服务端的「对端列表」也不是连接列表，而是按来源地址即时派生的发件人档案，**空闲超时淘汰是必需项而非可选项**：一台机器扫过来的成百上千个临时源端口，不淘汰会把列表撑爆。「踢出」在这里只表示不再跟踪，对方仍可继续发包——语义差异在界面上写明，而不是套用 TCP 的说法。

UDP 客户端启动后显示「已连接」，含义只是本地套接字已绑好，启动日志里会明确写这一点，避免被读成「对端在线」。

### 从站模拟为什么必须做

Modbus 主站面板只能证明「我发出去的请求长这样」，证明不了「点表配得对不对」。字序、地址偏移、工程值系数这三样配错之后**依然读得出数字**，只是数字是错的。所以需要一个自己完全掌握真值的从站来对账。

两个关键判定：

- **只有声明过的地址才存在**。读未声明地址回异常码 `0x02`，而不是悄悄返回 0。如果越界也给 0，「地址填错一位」这个经典问题会被完美掩盖。
- **从站地址不匹配时静默丢弃**，不回异常码。真实总线上多台从站共享一条线，乱应答会污染别人的回包。

### Mock 与接口测试

- **Mock 脚本跑在 Node `vm` 沙箱**里，带执行超时，不暴露文件系统与网络。它的定位是「写几行条件分支」，不是插件系统。
- **录制转路由把路径里的 id 自动变参数**（数字段、UUID、≥16 位 hex），参数名取前一段的单数 + `Id`。手抄真实接口是 Mock 里最枯燥的活，能自动就别让人干。
- **场景采用字段级覆盖**而不是整份复制：勾选要改的字段（状态码 / 延迟 / 响应体），其余仍走路由原始配置。改一个状态码不必复制整段响应体，否则响应体一改就得同步所有场景。
- **巡检与手动批量运行共用一套执行引擎**（`runCollection.ts`）。两套引擎必然出现「手动跑通过、巡检报失败」的判定漂移，那种问题极难查。
- **巡检调度挂在应用外壳上**，不挂面板。否则「关掉面板仍在后台运行」这件事就不成立。
- **HAR 导出会还原认证头**。Bearer / Basic / API Key 是单独配置的、不在 Header 表里，不补齐对方拿到就是一片 401。代价是 token 明文落进文件，转发前需自行斟酌。
- **HAR 里耗时未知写 `-1`** 而不是 `0`（规范里 -1 表示未知）：写 0 会在 DevTools 里画成零宽时间条，看起来像请求瞬间完成。时间戳带时区，和现场日志对时间时不会差 8 小时。

### 历史库：为什么不用 FTS5

这是全项目最主要的一处性能取舍，在 30 万行的库上实测过两条路：

| 方案 | 搜索耗时 | 索引开销 | 写入放大 |
|------|---------|---------|---------|
| `LIKE` 全表扫（最坏：无命中）| 68ms | 0 | 无 |
| `LIKE` + 限定最近 5 万条 | 6ms | 0 | 无 |
| FTS5 虚拟表 + 同步触发器 | 0ms | +13MB | 插 2 万行 1558ms vs 83ms，约 **19 倍** |

FTS5 查询快到测不出来，但报文库是**写多读少**：每秒可能落几百条报文，搜索一天点几次。为偶尔一次搜索把常态写入吞吐压到十九分之一，不划算。所以走 `LIKE` + 扫描行数上限，`scanLimit` 用 `id > MAX(id) - N` 走主键索引裁剪，最坏也只有几十毫秒。

落库侧的其他判定：

- **用 better-sqlite3 同步 API**：写入在主进程，批量事务比异步驱动的回调开销更低；Electron 31 内置的 Node 20 还没有 `node:sqlite`。
- **WAL + 批写**：攒够 200 条或空闲 800ms 落一次盘，一个事务包住整批。高频报文下逐条写会把磁盘打满。
- **每次查询前先 flush 队列**，否则刚发出的报文查不到，会让人以为丢数据。
- **会话名/类型/分组写入时冗余**，会话删掉之后历史依然可读。
- **按条数清理用「先查阈值 id 再 `DELETE WHERE id < ?`」**，走主键索引，比 `ORDER BY … LIMIT` 子查询快得多。
- **回放注入的报文不入库**：它不是真实链路数据，混进历史会污染排查结论。
- **`%` 和 `_` 按字面量搜**：SQL 通配符与反斜杠都转义并显式声明 `ESCAPE`，搜 `%` 得到的是真正含百分号的报文而不是全库。所有关键字走参数绑定，不拼 SQL。
- **文本会话与 HEX 会话互相命中**：库里存的是按显示编码渲染后的文本，同一条 `ALARM` 在 TEXT 会话存 `ALARM`、HEX 会话存 `414c41524d`。搜索时自动补等价模式（中文同样适用，`温度` → `e6b8a9e5baa6`），高亮长度按实际命中的那个模式算，否则 HEX 命中只会亮一半。

### 渲染性能

- **报文时间轴虚拟滚动**，内存缓冲上限 5 万条。两万条报文实测只有约 20–30 个行节点，滚动帧耗时与空闲时基本一致。Mock 请求日志、历史列表、搜索结果用的是同一个 `VirtualList`。
- **数值曲线只取最近 1000 个采样点**，且只在面板打开时计算。曲线是看趋势的，几万条全画既没意义也拖慢渲染。
- **看板全部图表用原生 SVG**，不引图表库：数据已在聚合阶段收敛，路径字符串比多一个依赖划算。图表按 1 秒节拍刷新，与数据量解耦。桶聚合从最新报文往回扫，遇到窗口外时间戳立即停止，不做全量遍历。
- **响应耗时给 P50 与 P95 而不只是均值**：均值会被个别慢请求拉高，P95 才说明「大多数请求有多慢」。
- **报文对比用序列比对（LCS）而不是逐位置比较**：报文中间插入一个字节时，逐位置比会把之后所有字节标成「不同」，满屏红噪声；LCS 能识别出「这里插入了一个字节，后面其实没变」。超过 150 万比对格时自动退化为逐位置比较并挂出提示，避免渲染卡死。
- **回放时序用「追赶应到时刻」而非固定间隔累加**：定时器本身有抖动，累加会让长录制越走越偏，对齐起点则误差不累积。

### 状态与持久化

- **工作区原子写入**：先写临时文件再改名替换，进程被强杀也不会留下半截损坏的配置。
- **只存配置不存报文**：避免文件无限膨胀，每次启动从干净状态开始。
- **会话 id 恢复后保持不变**，发送片段、集合等按 id 关联的数据不会失联。
- **恢复顺序是先重建全部会话、再统一启动自动连接的那些**，避免端口互相抢占。
- **书签存自洽快照而不只是报文 ID**。报文缓冲是内存态，清屏或重启后只留 ID 的书签会变成一排点不开的空行。所以打书签时就把方向、时间、字节数、HEX 与文本一起存下来；原会话被删了也只是「跳回会话」变灰，内容仍在。上限 500 条、单条 HEX 截断 128 字节——它是人工挑出来的线索，不是第二套历史库。
- **告警两个细节**：判定挂在收帧路径上，规则表为空时第一行即返回，不解码不解析，没配告警的用户不承担任何成本；改完规则会清掉该规则的冷却，否则把阈值从 80 调到 20 却不报警（实际是上次命中的冷却没过）最容易被当成 bug。
- **规则在应用启动时加载**，不等面板打开。否则重启后第一批报文会因为规则表还是空的而被静默跳过。
- **多标签筛选取交集**：标签常用来叠加维度（项目 + 环境），交集才是想要的结果。
- **更新的两个开关单独存 `update.json`**，不塞进工作区文件。工作区是会拷给同事、跟着项目走的，这两个开关属于这台机器上的个人偏好。

### 自动更新：地址不可配置

地址只有一处来源：打包时 `electron-builder.yml` 的 `publish` 段，electron-builder 把它写进安装包内的 `app-update.yml`，客户端启动时自己读。**界面里没有任何输入框。**

早先版本让用户在面板里选来源并填地址与下载代理，理由是「换服务器不用重新打包」。但那等于把一件发布方只需决定一次的事，摊给每一个使用者：他要判断填哪种来源、仓库名怎么写、代理选哪个——而这三处任何一处写错，表现都是同一个 404，用户根本无从判断错在哪。

| 仓库 | 可见性 | 放什么 |
|------|--------|--------|
| `kevinLei736/FlowProbe` | **私有** | 源码、文档、构建脚本 |
| `kevinLei736/FlowProbeClient` | **公开** | 每个版本的安装包与版本清单（Release 附件）|

**为什么必须拆开**：自动更新要能匿名下载附件。私有仓库的 Release 附件每次请求都要带令牌，而把令牌打进客户端就等于公开它——任何人解包 asar 都能拿到，它还带着对源码仓库的读权限。所以「代码私有 + 安装包公开」是唯一站得住的组合；公开那个仓库里只有二进制，不含一行源码。

```yaml
# electron-builder.yml
publish:
  - provider: github
    owner: kevinLei736
    repo: FlowProbeClient
    releaseType: release   # 只认正式 Release，草稿与预发布不会推给所有人
    publishAutoUpdate: true
```

用 `github` provider 而不是 `generic` 配一个 `releases/latest/download/` 地址，是因为前者直接读 Release 元数据，Release 正文能显示在更新面板里；后者每次取文件都要穿过一层 302 跳转，部分网络下会让 blockmap 增量下载失效。要换自建服务器就改成 `provider: generic` + `url:`，客户端两种都认。

其余判定：

- **不调用 `setFeedURL`**。地址已经在 `app-update.yml` 里，库自己读得到。再设一遍等于让同一个地址有两个来源，两处不一致时排查成本极高。
- **错误按原因分类**，而不是笼统报「更新失败」。「发布仓库里还没有正式版本」「找不到版本清单」「网络连不上」对应完全不同的动作。1.20.0 及更早的包里写的是占位域名 `update.invalid`，客户端认得它并回「发布方尚未启用更新服务」，而不是抛一个域名解析错误——后者是在向用户报告一件与他无关的事。
- **产物名固定为纯 ASCII 且不含空格**（`FlowProbe-Setup-1.21.4.exe`）。默认产物名带空格，而分发环节会改写文件名，`latest.yml` 里记的却是原始名字，一旦被改写下载必然 404。
- **状态用一个扁平的 phase 字段**，而不是一堆布尔量。「正在查 / 有新版 / 正在下 / 下好了 / 已是最新 / 出错了」本质互斥，布尔量组合迟早出现「既在下载又已是最新」，界面就得写一堆优先级判断。
- **`electron-updater` 惰性引入**，不放文件顶部。源码运行时它的构造过程本身就可能抛错，顶层 import 会连累主进程起不来。
- **更新说明先转纯文本再渲染**。GitHub API 返回的是已渲染 HTML，而面板按纯文本渲染（那段文字来自服务端，不该有能力往界面里插标签），两者都对，所以在主进程侧用 `htmlToText()` 收口。
- **默认不自动下载**。下完了终究要重启才生效，而重启会掐断正在跑的连接与监听端口，所以时机交给用户。

### 界面实现里两处踩过的坑

- **多行输入用自绘拖拽把手，不用浏览器原生拉伸手柄**。这些输入框都位于弹性布局容器里，原生手柄写下的高度会在下一次布局被压回去——手柄看得见、拖了却没反应。
- **窗口用 `backgroundMaterial: acrylic` 而不是 `transparent`**：后者会让 Windows 连带禁用最大化按钮。
- **下拉列表挂页面顶层并按视口定位**，在带滚动条的面板或弹窗里展开都不会被裁切，空间不足时向上翻转。
- **正文基准 14px**：中文字形在高分屏非整数缩放下，13px 以下明显偏糊。
- **文档高亮用 DOM 节点拼接而不是 `innerHTML`**：正文里有 `{{}}`、`<>` 这类字符，走 innerHTML 会被当标签解析，还白送一条注入路径。

---
## 三、开发

环境要求：Node.js 18+（开发时使用 v24），npm。项目已配置 npmmirror 镜像与 Electron 镜像，国内网络可直接安装。

```bash
npm install          # 安装依赖
npm run dev          # 开发模式（热更新）
npm run build        # 构建到 out/
npm start            # 预览构建产物
npm run typecheck    # 类型检查（主进程 + 渲染进程）
npm run rebuild      # 按当前 Electron 的 ABI 重编原生模块
npm run docs:guide   # 由应用内使用文档重新生成 docs/使用文档.md
```

两个原生依赖（`better-sqlite3`、`@serialport/bindings-cpp`）必须按 Electron 的 ABI 编译，不是按系统 Node 的。新克隆仓库后如果启动报「数据库不可用」或串口打不开，跑一次 `npm run rebuild`。

---

## 四、打包

### 命令一览

| 命令 | 平台 | 产物 |
|------|------|------|
| `npm run dist` | 当前系统 | 按 `electron-builder.yml` 里该平台的全部目标 |
| `npm run dist:win` | Windows | NSIS 安装包（x64）|
| `npm run dist:mac` | macOS | dmg + zip，arm64 与 x64 各一份 |
| `npm run dist:mac:arm` | macOS | 仅 Apple Silicon，快得多 |
| `npm run dist:mac:x64` | macOS | 仅 Intel |

每条都等价于「先 `electron-vite build` 构建，再 `electron-builder` 打包」，且都带 `--publish never` —— 上传是独立一步（见第五章），打包过程不碰网络。

**跨平台打包不成立**：原生模块要按目标平台与 Electron 的 ABI 编译，Windows 上打不出可用的 mac 包，反之亦然。同一版本要覆盖两个平台，就得在两台机器上各打一次（怎么合成一个 Release 见第五章）。

### 产物位置

打包完成后在 `release/` 目录。Windows：

| 文件 | 说明 |
|------|------|
| `FlowProbe-Setup-1.21.4.exe` | NSIS 安装程序（约 86 MB），可选安装目录、创建桌面与开始菜单快捷方式 |
| `FlowProbe-Setup-1.21.4.exe.blockmap` | 增量更新用的块映射 |
| `latest.yml` | 自动更新用的版本清单。**发布时必须与安装包一起上传**，缺它客户端查不到新版本 |
| `win-unpacked/` | 免安装绿色版，直接运行其中的 `FlowProbe.exe` |

macOS：

| 文件 | 说明 |
|------|------|
| `FlowProbe-1.21.4-arm64.dmg` | Apple Silicon 安装镜像，双击拖入「应用程序」 |
| `FlowProbe-1.21.4-x64.dmg` | Intel 安装镜像 |
| `FlowProbe-1.21.4-arm64-mac.zip` | Apple Silicon 免安装包 —— **mac 的自动更新读的是 zip 不是 dmg** |
| `FlowProbe-1.21.4-x64-mac.zip` | Intel 免安装包 |
| `latest-mac.yml` | macOS 版本清单 |

### 打包配置里几处不能改的地方

`electron-builder.yml` 里带注释的项都有具体原因，改动前先读注释。三处最容易踩：

- **`artifactName` 固定为 `FlowProbe-Setup-${version}.${ext}`**。默认产物名带空格，而分发环节会改写文件名，`latest.yml` 里记的却是原始名字，一旦被改写下载必然 404。
- **`asarUnpack` 必须包含 `better-sqlite3`、`serialport`、`bindings`、`node-gyp-build`**。原生模块的 `.node` 文件在 asar 压缩包内加载不了，漏一个的表现是「数据库不可用」或串口打不开。
- **mac 段的 `identity: null` + `afterSign` 钩子**是 ad-hoc 签名，不是「关掉签名」。Apple Silicon 内核会直接杀掉签名无效的进程，不签名的 `.app` 双击后立刻闪退。

### 应用图标

源文件是 `build/icon.svg`：三条数据流线，中间一条在环形探针处断开——对应 FlowProbe 这个名字。

刻意只用粗直线和一个圆环：这枚图标最小要在 16px 的任务栏与托盘里渲染，曲线、渐变、发光在这个尺寸会糊成一团灰。界面内的 Logo 是独立组件 `src/renderer/src/components/Logo.tsx`，用 `var(--accent)` 取色，深浅主题自动跟随。

改完 SVG 后重新生成位图：

```bash
npm install --no-save sharp png-to-ico
node -e "const sharp=require('sharp'),fs=require('fs'),p2i=require('png-to-ico');(async()=>{const svg=fs.readFileSync('build/icon.svg');await sharp(svg).resize(512,512).png().toFile('build/icon.png');const b=[];for(const s of [16,24,32,48,64,128,256])b.push(await sharp(svg).resize(s,s).png().toBuffer());fs.writeFileSync('build/icon.ico',await p2i(b));})()"
```

macOS 的 `build/icon.icns` 需要另外生成（`png-to-ico` 只出 ico）：

```bash
node -e "const sharp=require('sharp'),fs=require('fs');const svg=fs.readFileSync('build/icon.svg');const T=[['icp4',16],['icp5',32],['icp6',64],['ic07',128],['ic08',256],['ic09',512],['ic10',1024],['ic11',32],['ic12',64],['ic13',256],['ic14',512]];(async()=>{const parts=[];for(const [t,s] of T){const png=await sharp(svg).resize(s,s).png().toBuffer();const h=Buffer.alloc(8);h.write(t,0,'ascii');h.writeUInt32BE(png.length+8,4);parts.push(h,png)}const body=Buffer.concat(parts);const head=Buffer.alloc(8);head.write('icns',0,'ascii');head.writeUInt32BE(body.length+8,4);fs.writeFileSync('build/icon.icns',Buffer.concat([head,body]))})()"
```

icns 就是「8 字节魔数 + 若干 `类型 + 长度 + PNG` 块」的容器格式，所以不需要 macOS 上的 `iconutil`，在 Windows 上纯 Node 拼出来一样能用。

### 在 macOS 上打包

mac 的配置已经写好，**不需要改 `electron-builder.yml`**。

| 前置项 | 要求 | 检查方式 |
|-------|------|---------|
| Xcode 命令行工具 | 必装，用于编译原生模块 | `xcode-select -p` 有输出即已装，否则 `xcode-select --install` |
| Node.js | 18 / 20 / 22 / 24 均可 | `node -v` |
| 磁盘空间 | 约 2 GB（含 Electron 缓存）| — |

```bash
npm run setup:mac     # 清理并重装依赖、按 Electron ABI 重建原生模块
npm run dist:mac      # 输出 dmg + zip，arm64 与 x64 都有
```

#### 从 Windows 拷过来的项目：必须先跑 setup:mac

这是最容易卡住的一步。**如果你把整个项目文件夹（含 `node_modules`）从 Windows 拷到 mac，直接 `npm install` 是无效的**，npm 会输出 `up to date` 然后什么都不做。

原因：npm 只比对 `package-lock.json` 里的版本号与 `node_modules` 的实际版本，**不校验二进制是哪个平台编译的**。于是留下两个隐患：

1. `node_modules/.bin/` 里仍是 Windows 的 `.cmd` / `.ps1`，并且丢失了 Unix 可执行位，于是报错 `sh: .../node_modules/.bin/electron-vite: Permission denied`
2. `better-sqlite3` 仍是 Windows 编译的 `.node`，即使绕过第 1 点，打包或启动时也会崩

`npm run setup:mac` 就是为此准备的：删掉 `node_modules` 重装、按 Electron 的 ABI 重编原生模块、并兜底修复可执行位。等价的手工步骤：

```bash
rm -rf node_modules
npm install --foreground-scripts
npx electron-builder install-app-deps
chmod +x node_modules/.bin/*
```

#### 安装脚本被拦（npm 新版本）

若 `npm install` 出现 `npm warn install-scripts N packages have install scripts not yet covered by allowScripts`，说明原生模块**压根没有被编译**。项目根目录的 `.npmrc` 已写入 `ignore-scripts=false`，通常足够；若你的 npm 仍然拦截，按它给出的命令逐个放行：

```bash
npm install-scripts approve better-sqlite3
npm install-scripts approve @serialport/bindings-cpp
npm install-scripts approve electron
npm install-scripts approve esbuild
```

放行后重新执行 `npm run setup:mac`。

#### 首次打开提示「已损坏」或「无法验证开发者」

本项目没有 Apple 开发者证书，打包走 **ad-hoc 签名**（`scripts/adhoc-sign.cjs`）。它能让程序正常运行，但不能通过 Apple 公证（notarization），所以首次打开需手动放行一次：Finder 里**右键点图标 → 打开**，或到「系统设置 → 隐私与安全性」点「仍要打开」。

若提示「已损坏，应移到废纸篓」，是 macOS 给下载文件加的隔离属性：

```bash
xattr -dr com.apple.quarantine "/Applications/FlowProbe.app"
```

#### Linux

配置里没写 Linux 目标，需要时加一段即可（同样必须在 Linux 上执行）：

```yaml
linux:
  target: AppImage
  icon: build/icon.png
```

### 打包常见问题

| 现象 | 原因与处置 |
|------|-----------|
| 启动报「数据库不可用」 | `better-sqlite3` 是原生模块，必须在 `asarUnpack` 里解包；新克隆仓库后先跑 `npm run rebuild` |
| `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE` 或文件被占用 | 应用进程还在跑，锁住了 `release/win-unpacked/`。先 `Get-Process -Name FlowProbe \| Stop-Process -Force` |
| `Failed to load image … build\icon.png` | `build/icon.png` 没被打进包，确认 `electron-builder.yml` 的 `files` 里有它 |
| 串口打开失败 / 找不到原生模块 | 确认 `asarUnpack` 包含 serialport 相关路径 |
| 首次打包卡在 winCodeSign 解压 | Windows 无符号链接权限所致。项目已关闭代码签名（`CSC_IDENTITY_AUTO_DISCOVERY=false`）|

### 改名与数据兼容

1.19.0 把应用标识从 `debug-toolbox` 改成 `flowprobe`（数据目录随之变化），1.21.0 进一步把显示名统一为英文 `FlowProbe`。前者牵动三处对老用户可见的东西：

| 受影响的东西 | 为什么会受影响 | 处置 |
|-------------|--------------|------|
| 用户数据目录 | Electron 的 `userData` 目录名取自 `package.json` 的 `name`。改名后应用去找一个全新的空目录，表现就是「升级后会话、历史、证书全没了」 | 首次启动自动迁移（`src/main/userDataMigration.ts`）：把旧目录的 `workspace.json`、`update.json`、`history.db`（含 `-wal`/`-shm`）与 `certs/` **复制**到新目录，写一个哨兵文件避免重复搬 |
| 录制文件标识 | `.json` 录制文件里的 `format` 字段是加载准入条件，只认新值会让改名前导出的文件全部打不开 | 写入一律用 `flowprobe-recording`，读取同时接受旧的 `debug-toolbox-recording` |
| 安装包文件名 | 产物名从 `DebugToolbox-Setup-*.exe` 变成 `FlowProbe-Setup-*.exe`，旧客户端按 `latest.yml` 里的名字去下载 | 清单与产物名由同一处配置生成，始终一致；1.20.0 及更早的包里还是占位更新地址，需手动装一次新版才能接上自动更新 |

迁移是**复制不是移动**：旧目录保持原样，需要时还能装回旧版本继续用。

---
## 五、发布一版

发布分两件事：把产物上传到公开的客户端仓库（用户下载与自动更新都从那里取），把源码推到私有代码仓库。

```bash
npm run dist            # 打包（Windows 上出 exe，mac 上用 dist:mac）
npm run publish:github  # 把 release/ 里这一版的产物上传到 Release
npm run release         # = dist + publish:github，单平台一条命令搞定
npm run publish:readme  # 客户端仓库的中英双语说明有改动时才需要
```

凭据放项目根目录的 `.env`（已在 `.gitignore` 里）：

```
DT_GITHUB_TOKEN=ghp_你的令牌
DT_RELEASE_REPO=kevinLei736/FlowProbeClient
```

bump 版本要同步改四处：`package.json`、`package-lock.json`、本文件里的版本号、`electron-builder.yml` 的注释示例。

### 同一版本覆盖多平台

因为跨平台打包不成立，一个版本要同时有 Windows 与 macOS 安装包，必须在两台机器上各打一次，然后合进**同一个 Release**（同一个 `v<version>` tag）。

两台机器上都要有 `.env`，并且 `package.json` 的 `version` 必须完全一致 —— 版本号不同就是两个 Release，自动更新会各自比对，mac 用户看不到 Windows 那版，反之亦然。

顺序不重要，先发哪个平台都行：

```bash
# 机器 A（Windows）
npm run dist
npm run publish:github     # 建 Release v1.21.4，传 exe + blockmap + latest.yml

# 机器 B（macOS，同一个版本号）
npm run setup:mac          # 仅首次，或依赖有变动时
npm run dist:mac
npm run publish:github     # 复用 Release v1.21.4，补传 dmg + zip + latest-mac.yml
```

脚本为这个流程做了三件事：

| 行为 | 为什么 |
|------|-------|
| **按平台判断产物是否齐全**，而不是要求所有文件都在 | 在 mac 上打包时 `release/` 里本来就没有 exe。判断口径是「某个平台的安装包在，它的清单就必须在」，两个平台都不在才算真的没打包 |
| **同名 tag 复用已有 Release**，不新建也不报错 | 补发另一个平台时必须落到同一个 Release，否则清单分家 |
| **Release 正文按平台做并集**，只追加缺失的段落 | 先发 Windows 时正文只写 Windows 安装说明；mac 补发时把 macOS 段落并进去，而不是覆盖掉先写的那段 |

两个平台的清单文件名不同（`latest.yml` / `latest-mac.yml`），electron-updater 按运行平台各取各的，所以互不干扰。

> mac 的自动更新读 **zip 不是 dmg**。只传 dmg 的话用户能下载安装，但已装用户的「检查更新」会一直查不到新版本 —— 这个失败是静默的。`npm run dist:mac` 两个都会出，别只挑 dmg 传。

### 上传脚本做了什么

| 步骤 | 说明 |
|------|------|
| 校验 | 令牌缺失、仓库格式不对、安装包还没打，都在动手前直接报错退出 |
| 探测仓库 | 访问不到就报「仓库不存在或令牌无权限」；**发布仓库是私有的会当场警告**，因为那样自动更新一定不可用 |
| 建或复用 Release | tag 用 `v<version>`。已存在就复用，所以上一次传到一半失败可以直接重跑 |
| 上传附件 | 同名附件先删再传（重发通常正是因为上次传坏了，跳过会把坏文件留在线上）；流式上传不把百兆文件读进内存；自己处理重定向与重试 |

两处踩过的坑，改法留在脚本注释里：

- **HTTP 307 导致上传失败**。请求体是流，而流只能消费一次，`fetch` 内置的跟随重定向拿不到可重放的 body。改成 `redirect: manual` 手动重发，每次新开一个 `createReadStream`。
- **`git push` 间歇连不上 443**，而 `api.github.com` 同期正常。推送脚本带 5 次重试；镜像代理只代理匿名读，不转发 Git 认证，换镜像没用。

推送代码时令牌写进临时凭据文件而不是远端 URL 或命令行参数：URL 里的令牌会永久留在 `.git/config` 并被 `git remote -v` 直接打在屏幕上，命令行参数会出现在进程列表里。用完立即删除。

完整步骤与排查表见 [docs/发布与自动更新.md](docs/发布与自动更新.md)。

---
## 六、项目结构

```
小工具/
├─ build/                     图标与权限清单
│  ├─ icon.svg / png / ico     Windows 与界面用图标
│  ├─ icon.icns               macOS 应用图标
│  └─ entitlements.mac.plist  macOS 权限声明（JIT / 网络监听 / 串口）
├─ client-readme/             发布仓库（FlowProbeClient）的门面说明，中英双语
│  ├─ README.md               中文版，GitHub 默认渲染，主入口
│  └─ README.en.md            英文版，顶部注明应用界面为简体中文
├─ docs/
│  ├─ 需求与架构设计.md         需求与架构设计文档
│  ├─ 使用文档.md               面向使用者的中文手册（由 npm run docs:guide 从应用内文档生成）
│  └─ 发布与自动更新.md         更新服务器配置、仓库分工与每次发版的操作步骤
├─ shared/
│  ├─ protocol.ts             前后端共享类型契约与 IPC 通道定义
│  └─ har.ts                  HAR 1.2 构建与序列化（三个导出入口共用一份字段映射）
├─ src/
│  ├─ main/                   主进程（通信内核）
│  │  ├─ index.ts             窗口创建、单实例锁、IPC 注册、报告保存对话框
│  │  ├─ session-manager.ts   会话生命周期统一管理
│  │  ├─ persistence.ts       工作区读写（workspace.json 原子落盘）
│  │  ├─ updater.ts           应用自动更新：两个开关的读写 + electron-updater 惰性接入（地址取自安装包内 app-update.yml）
│  │  ├─ adapters/            tcp-client / tcp-server / ws-client / ws-server
│  │  │                       udp-client / udp-server / serial / http-mock
│  │  │                       mqtt-client / modbus / modbus-slave / loopback
│  │  ├─ modbus/              Modbus PDU 编解码、CRC、字序换算、批量读合并
│  │  │                       slave.ts 从站数据区内核（请求进 / 响应出，三种链路共用）
│  │  ├─ codec/               编解码与分帧
│  │  ├─ history/             报文历史 SQLite 落库与 CSV 序列化
│  │  ├─ http-mock/           HTTP Mock 引擎（路由匹配 + 模板 + 脚本沙箱）
│  │  ├─ tls/                 自签证书生成（纯 node:crypto 手写 ASN.1）与证书体检/落盘
│  │  └─ http-test/           HTTP 请求执行器（认证 / 重定向 / 解压）
│  ├─ preload/                typed contextBridge 桥接
│  └─ renderer/               渲染进程（React 界面）
│     └─ src/
│        ├─ app/              布局外壳、系统快捷键、菜单接线
│        ├─ components/
│        │  ├─ menu/          menuModel.ts（纯数据菜单模型）+ MenuBar 自绘标题栏
│        │  ├─ ui/            tokens.ts 控件样式原语 + Select 自绘下拉 + ResizableTextarea 可拉伸输入 + ResizeBar 区域拖拽条
│        │  ├─ dialogs/       关于 / 快捷键 / 通用输入弹窗
│        │  └─ …              Sidebar / Logo / EmptyState / CommandPalette / VirtualList / SplitPane
│        ├─ features/
│        │  ├─ sessions/      会话视图、中栏标签条、检查器、新建对话框、报文导出、报文对比（byteDiff/DiffView）、报文标注与书签（MarksPanel）
│        │  ├─ mqtt/          MQTT 订阅与连接参数面板
│        │  ├─ modbus/        Modbus 点表、实时值与链路参数面板；SlavePanel 从站数据区 / 实时值 / 链路与故障
│        │  ├─ http-mock/     Mock 路由面板、请求日志视图、录制转路由（logToRoute.ts 推断 + RecorderPanel.tsx 面板）、HTTPS 证书面板（CertPanel.tsx）、请求日志转 HAR（harExport.ts）
│        │  ├─ http-test/     API Client 面板、集合 Runner、定时巡检（useMonitor / useMonitorScheduler / MonitorPanel）、共享执行引擎 runCollection.ts、断言与提取引擎、历史转 HAR（harExport.ts）
│        │  ├─ alerts/        报文断言告警：判定内核 alertEval.ts、收帧运行时 alertRuntime.ts、冷却台账 cooldown.ts、规则与事件 store useAlerts.ts、告警中心 AlertCenterPanel.tsx
│        │  ├─ help/          内置使用文档：guideContent.ts 正文数据 + GuidePanel.tsx 面板 + guideMarkdown.ts 导出渲染；UpdateDialog.tsx 检查更新面板
│        │  ├─ dashboard/     数据看板（指标聚合 + SVG 图表）
│        │  ├─ history/       报文历史浏览器（检索 / 分页 / 存储管理）
│        │  ├─ search/        全局搜索弹层（跨会话跨表检索 + 高亮）
│        │  ├─ tools/         工具箱
│        │  └─ workspace/     配置导入导出（configIo.ts）
│        ├─ store/            Zustand（会话 / 标签页 / 分组标签 / 主题 / 布局与分屏 / 报文对比 / 时间轴联动 / 片段 / 集合 / 报文书签）
│        └─ styles/           设计令牌三层结构与全局控件基础层
├─ scripts/                   打包辅助脚本
│  ├─ adhoc-sign.cjs          macOS ad-hoc 签名钩子（Apple Silicon 必需）
│  ├─ gen-user-guide.mjs      从应用内使用文档生成 docs/使用文档.md（npm run docs:guide）
│  ├─ publish-github.mjs      把 release/ 产物发到 GitHub Release（按平台判定产物、复用同名 Release、正文按平台并集）
│  ├─ publish-client-readme.mjs 把 client-readme/ 的中英双语说明推到客户端仓库（Contents API）
│  └─ setup-mac.sh            macOS 依赖重装 + 按 Electron ABI 重编原生模块
├─ .gitattributes             行尾一律不转换（本项目 CRLF/LF 混用，交给 git 改写会全文件变更）
├─ electron-builder.yml       打包配置（win / mac / dmg / 产物命名 / 更新清单）
├─ electron.vite.config.ts    构建配置
└─ package.json
```

---

## 七、安全设计

- 渲染进程开启 `contextIsolation`、关闭 `nodeIntegration`，仅通过 typed preload 暴露受控 API
- Mock 脚本运行在 Node `vm` 沙箱中，带执行超时限制，不暴露文件系统与网络能力
- 所有 IO 在主进程执行，异常隔离到会话级别，单会话故障不影响其他会话
- 请求体大小上限保护（HTTP Mock 默认 5MB），防止内存打爆
- 历史库只写本地用户数据目录，不做任何外发；SQL 全部参数化拼接，筛选条件不进字符串
- 自签证书与私钥落在用户数据目录的 `certs/`，私钥文件权限 `0600`，界面只展示指纹与有效期不展示私钥正文

---

## 八、许可

MIT