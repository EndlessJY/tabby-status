# tabby-status

Tabby SSH 系统状态侧边面板插件，提供服务器信息展示。

## 功能

- 连接 SSH 后自动在左侧显示状态面板。
- 使用独立 SSH exec channel 采集数据，不向可见终端输入命令。
- 分层刷新：CPU、内存、交换、负载、网络速率、延迟每秒刷新；进程列表每 3 秒刷新；公网 IP、运行时间、磁盘列表每 10 秒刷新。
- 支持 Linux、macOS/Darwin SSH 目标的基础 CPU、内存、网络、运行时间、进程采集。
- 面板、详情弹窗和浮层菜单使用 Tabby 当前主题变量派生背景、前景和边框色。
- IP 显示优先公网 IP，公网采集失败时回退本机网卡 IP；点击复制后会显示成功或失败反馈。
- 面板可横向拖拽调整宽度，宽度会保存在本机。
- 状态面板挂载在终端外层布局容器，终端内容区和 SFTP 文件面板会同步让出状态栏宽度。
- CPU 右侧显示百分比；内存、交换右侧同时显示百分比和容量，交换未启用时显示“未启用”。
- 进程列表的“内存”和“CPU”表头支持点击排序。
- 点击进程、网络、延迟区域可打开弹窗二级页。
- 进程详情展示 PID、用户、内存、CPU、命令、位置，其中 PID、用户、内存、CPU 支持排序；进程行支持右键终止进程、复制 PID、复制名称、复制命令、复制位置。
- 网络区域的网卡名称可点击展开网卡列表并切换采集网卡；网络详情展示 PID、名称、监听 IP、端口、IP 数、连接数、上传、下载，所有字段支持排序。
- 延迟详情优先展示本机到当前 SSH host 的路由追踪。macOS/Linux 主机使用 traceroute/tracepath，Windows 主机使用 PowerShell + tracert；路由行会随追踪输出流式出现。
- 磁盘列表展示“可用/大小”，可用值取自 `df` 的可用列。

## 安装

只支持 zip 安装。

1. 从 GitHub Actions Artifacts 或 GitHub Release 下载 `tabby-status-<version>.zip`。
2. 完全退出 Tabby。
3. 解压 zip，得到 `tabby-status` 文件夹。
4. 把 `tabby-status` 文件夹复制到 Tabby 插件目录：

macOS:

```text
~/Library/Application Support/tabby/plugins/node_modules/tabby-status
```

Windows:

```text
%APPDATA%\tabby\plugins\node_modules\tabby-status
```

Linux:

```text
~/.config/tabby/plugins/node_modules/tabby-status
```

5. 重启 Tabby。

最终目录必须是：

```text
plugins/node_modules/tabby-status/package.json
plugins/node_modules/tabby-status/dist/index.js
```

如果解压后变成 `plugins/node_modules/tabby-status/tabby-status/package.json`，说明多复制了一层目录，需要把里面那层 `tabby-status` 移出来。

## 构建产物

GitHub Actions 只构建 zip 产物：

```text
release/tabby-status-<version>.zip
```

该 zip 内部只包含运行插件需要的文件，不包含开发依赖。

## 已知限制

- 当前采集依赖 Tabby SSH session 的独立 exec channel；Tabby 本地默认终端不是 SSH session，因此不会采集本机系统数据。
- 公网 IP 需要目标机器能访问外部 IP 服务；如果出站网络、DNS、代理或防火墙限制导致访问失败，会回退显示本机 IP。
- Windows 主机的延迟详情使用系统自带 `tracert`，跳点地理位置补充能力弱于 macOS/Linux 的 traceroute 路径。
- 插件使用 Tabby 当前可用的内部 SSH session 字段，Tabby 大版本变更时可能需要适配。

更完整说明见 [docs/项目说明.md](docs/项目说明.md)。
