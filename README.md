# tabby-status

Tabby SSH 系统状态侧边面板插件，提供服务器信息展示。

## 功能

- 连接 SSH 后自动在左侧显示状态面板。
- 使用独立 SSH exec channel 采集数据，不向可见终端输入命令。
- 分层刷新：
  - 1 秒：CPU、内存、交换、负载、网络速率、Tabby 到 SSH 服务器的 exec 往返延迟。
  - 3 秒：进程列表。
  - 10 秒：公网 IP、本机 IP、运行时间、磁盘列表。
- 支持 Linux SSH 目标。
- 支持 macOS/Darwin SSH 目标的基础 CPU、内存、网络、运行时间、进程采集。
- IP 显示优先公网 IP，公网采集失败时回退本机网卡 IP，并标记为“公网”或“本机”。
- 面板可横向拖拽调整宽度，宽度会保存在本机 localStorage。
- 面板和进程列表隐藏滚动条，但保留滚动能力。
- CPU 右侧显示百分比；内存、交换右侧同时显示百分比和容量，交换未启用时显示“未启用”。
- 进程列表的“内存”和“CPU”表头支持点击排序。
- 磁盘列表的“可用/大小”表头和数值右对齐。

## 安装和验证

### GitHub 自动构建

仓库已配置 GitHub Actions。代码推送到 `main` 或发起 Pull Request 后，会自动执行类型检查、smoke test 和插件打包，并在 workflow run 的 Artifacts 里上传 `tabby-status-plugin`，里面包含可安装的 `.tgz`。

如果需要发布固定版本，推送 `v*` tag 会自动创建 GitHub Release 并附带同一个 `.tgz`：

```bash
git tag v0.1.2
git push origin v0.1.2
```

### 产物安装

```bash
npm install
npm run pack:plugin
```

生成的安装包在：

```text
release/tabby-status-<version>.tgz
```

如果你的 Tabby 版本在插件页面支持从本地包安装，选择这个 `.tgz` 即可。安装后重启 Tabby。

### 本机开发安装

```bash
cd "/Users/endlessjy/Documents/AIGC/tabby-status"
npm install
npm run test:smoke
npm run install-local
```

`install-local` 会直接把插件安装到当前 macOS 用户的 Tabby 插件目录。安装后重启 Tabby，重新连接 SSH。

## 常用命令

```bash
npm run build
npm run test:smoke
npm run pack:plugin
npm run install-local
```

## 已知限制

- 当前采集依赖 Tabby SSH session 的独立 exec channel；Tabby 本地 macOS 默认终端不是 SSH session，因此本地系统窗口不会采集系统数据。
- 公网 IP 需要目标机器能访问外部 IP 服务；如果出站网络、DNS、代理或防火墙限制导致访问失败，会回退显示本机 IP。
- 磁盘列表目前保持原始 `df -P -h` 输出，未做复杂过滤。
- 插件使用 Tabby 当前可用的内部 SSH session 字段，Tabby 大版本变更时可能需要适配。

更完整说明见 [docs/项目说明.md](docs/项目说明.md)。
