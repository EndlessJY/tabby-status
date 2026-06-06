import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function assert (condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function parseMetricPayload (text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed)
  }

  const result = {}
  const disks = []
  const processes = []

  for (const line of text.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    const parts = line.split('\t')
    const key = parts.shift()
    if (!key) {
      continue
    }
    if (key === 'disk') {
      const [mountPath, avail, size, pct] = parts
      disks.push([mountPath, avail, size, pct].join(','))
    } else if (key === 'proc') {
      const [pid, cpu, mem, command] = parts
      processes.push([pid, cpu, mem, command].join(','))
    } else {
      result[key] = parts.join('\t')
    }
  }

  if (disks.length) {
    result.disks = disks.join(';')
  }
  if (processes.length) {
    result.processes = processes.join(';')
  }
  return result
}

function testPackageShape () {
  assert(pkg.name.startsWith('tabby-'), 'package name must start with tabby-')
  assert(pkg.keywords?.includes('tabby-plugin'), 'package must include tabby-plugin keyword')
  assert(pkg.author, 'package must include author, otherwise this Tabby build skips it')
  assert(pkg.main === 'dist/index.js', 'package main must point to dist/index.js')
  assert(pkg.typings === 'dist/index.d.ts', 'package typings must point to generated declaration output')
  assert(pkg.scripts?.build?.startsWith('node node_modules/webpack/bin/webpack.js'), 'build script must not rely on quarantined .bin shebangs')
  assert(pkg.scripts?.['pack:plugin']?.includes('node scripts/pack-plugin.mjs'), 'pack:plugin must create the zip distributable with the local packer')
  assert(!pkg.scripts?.['pack:plugin']?.includes('npm pack'), 'pack:plugin must not create tgz/npm-pack artifacts')
  assert(pkg.scripts?.['install-local']?.includes('node scripts/install-local.mjs'), 'install-local should copy the plugin folder directly into Tabby plugin directory')
  assert(!pkg.scripts?.['install-local']?.includes('npm install --prefix'), 'install-local must not depend on npm installing the plugin package')
}

function testBuildOutput () {
  const dist = path.join(root, pkg.main)
  assert(fs.existsSync(dist), 'dist/index.js is missing, run npm run build')
  assert(fs.existsSync(path.join(root, pkg.typings)), 'dist/index.d.ts is missing, run npm run build')
  const source = fs.readFileSync(dist, 'utf8')
  assert(source.includes('requestExec'), 'dist does not use SSH exec channel')
  assert(source.includes('openSessionChannel'), 'dist does not open a separate SSH channel')
  assert(source.includes('base64 -d | sh'), 'dist does not include encoded one-shot collector')
  assert(!source.includes('sendInput'), 'dist must not inject commands into the visible terminal')
  assert(!source.includes('registerOscHandler'), 'dist must not depend on terminal OSC parsing')
}

function testGithubWorkflow () {
  const workflowPath = path.join(root, '.github/workflows/build.yml')
  assert(fs.existsSync(workflowPath), 'GitHub Actions build workflow is missing')
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  assert(workflow.includes('FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true'), 'workflow should opt into the GitHub Actions Node 24 runtime')
  assert(workflow.includes('node-version: 24'), 'workflow should build with Node.js 24')
  assert(workflow.includes('npm ci --legacy-peer-deps'), 'workflow must install with legacy peer deps for Tabby peer packages')
  assert(workflow.includes('node node_modules/typescript/bin/tsc --noEmit'), 'workflow must run TypeScript type check')
  assert(workflow.includes('npm run test:smoke'), 'workflow must run smoke tests')
  assert(workflow.includes('npm run pack:plugin'), 'workflow must build the installable plugin package')
  assert(workflow.includes('actions/upload-artifact@v4'), 'workflow must upload the plugin zip as an Actions artifact')
  assert(workflow.includes('softprops/action-gh-release@v2'), 'workflow must publish zip files on version tags')
  assert(workflow.includes('release/*.zip'), 'workflow must publish the generated zip files')
  assert(!workflow.includes('release/*.tgz'), 'workflow must not publish tgz artifacts')
}

function testZipOnlyPackagingScripts () {
  const packer = fs.readFileSync(path.join(root, 'scripts/pack-plugin.mjs'), 'utf8')
  const installer = fs.readFileSync(path.join(root, 'scripts/install-local.mjs'), 'utf8')
  assert(packer.includes('zlib.deflateRawSync'), 'zip packer must create zip files without external zip/npm tooling')
  assert(packer.includes('releaseDir') && packer.includes('fs.rmSync(releaseDir'), 'zip packer must clean old release artifacts before creating the zip')
  assert(packer.includes('`${packageName}-${pkg.version}.zip`'), 'zip packer must create a versioned zip file')
  assert(!packer.includes('.tgz'), 'zip packer must not create tgz artifacts')
  assert(installer.includes("process.platform === 'win32'"), 'local installer must support Windows Tabby plugin path')
  assert(installer.includes("process.platform === 'darwin'"), 'local installer must support macOS Tabby plugin path')
  assert(installer.includes('process.env.APPDATA'), 'Windows installer path must use APPDATA')
  assert(installer.includes('Application Support') && installer.includes('.config'), 'installer must cover macOS and Linux Tabby paths')
  assert(!installer.includes('npm install'), 'local installer must not shell out to npm install')
}

function testTieredRefreshSource () {
  const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8')
  assert(source.includes("collectViaSshExec(terminal, 'fast'"), 'fast collector is missing')
  assert(source.includes("collectViaSshExec(terminal, 'process'"), 'process collector is missing')
  assert(source.includes("collectViaSshExec(terminal, 'slow'"), 'slow collector is missing')
  assert(source.includes('window.setInterval(fastLaunch, 1000)'), 'fast collector must refresh every 1 second')
  assert(source.includes('window.setInterval(processLaunch, 3000)'), 'process collector must refresh every 3 seconds')
  assert(source.includes('window.setInterval(slowLaunch, 10000)'), 'slow collector must refresh every 10 seconds')
  assert(source.includes('data-open-detail="process"'), 'process area must open a detail modal')
  assert(source.includes('data-open-detail="network"'), 'network area must open a detail modal')
  assert(source.includes('data-open-detail="latency"'), 'latency area must open a detail modal')
  assert(source.includes('tfs-detail-backdrop'), 'detail views must render as modal dialogs')
  assert(!source.includes('已刷新'), 'detail modal must not display refreshed-at timestamps')
  assert(!source.includes('toLocaleTimeString'), 'detail modal must not render local AM/PM refresh timestamps')
  assert(source.includes('window.setInterval(refresh, 1000)'), 'detail modal data must refresh every second')
  assert(source.includes("if (state.kind === 'latency') {\n      return\n    }\n    const refresh = () => void this.refreshDetailModal(terminal)"), 'latency detail must not restart traceroute every second after a trace completes')
  assert(source.includes('lastText?: string'), 'detail modal state must be able to keep the last rendered data')
  assert(source.includes('state.lastText = text'), 'streamed latency rows must be retained while traceroute is running')
  assert(source.includes('state.lastText || text'), 'empty latency results must keep the last streamed route rows instead of clearing the table')
  assert(source.includes('data-action="pause"'), 'detail modal header must include a pause button')
  assert(source.includes('tfs-detail-title'), 'detail modal pause control must sit next to the title')
  assert(source.includes('tfs-detail-icon-button'), 'detail modal pause control must be an icon button')
  assert(source.includes('tfs-detail-pause-icon'), 'detail modal pause control must render pause/play icons')
  assert(!source.includes('data-action="pause" title="暂停自动刷新">暂停</button>'), 'detail modal pause control must not be a text button')
  assert(source.includes('toggleDetailPause'), 'detail modal pause button must toggle refresh state')
  assert(source.includes('state.paused'), 'detail modal refresh must respect paused state')
  assert(source.includes("window.clearInterval(state.timer)"), 'pausing detail modal must stop the refresh timer')
  assert(!source.includes('已暂停'), 'paused detail modal must not show extra status text')
  assert(source.includes('processDetailCollectorExecCommand'), 'process detail collector is missing')
  assert(source.includes('networkDetailCollectorExecCommand'), 'network detail collector is missing')
  assert(source.includes('latencyDetailCollectorExecCommand'), 'latency detail collector is missing')
  assert(source.includes('pdetail\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s'), 'process detail payload must include pid/user/memory/cpu/command/location')
  assert(source.includes('ss -H -tunapi'), 'network detail collector should request TCP info counters when available')
  assert(source.includes('bytes_sent:[0-9]+') && source.includes('bytes_received:[0-9]+'), 'network detail collector must parse TCP byte counters')
  assert(source.includes('withNetworkRates'), 'network detail upload/download should be computed from counter deltas')
  assert(source.includes('printf "ldetail\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n"'), 'latency detail payload must include MTR-style route metrics')
  assert(source.includes('mtr -n -r -c 20 -i 0.2 -w -b'), 'latency detail should prefer bounded MTR report mode when available')
  assert(source.includes('collectLatencyDetails'), 'latency detail should use a dedicated collector')
  assert(source.includes('runLocalCommandStream'), 'latency detail should stream local traceroute output instead of waiting for command completion')
  assert(source.includes('childProcess.spawn'), 'local latency detail must use spawn so stdout can be rendered incrementally')
  assert(source.includes('onStdout(chunkText, stdout)'), 'streamed local stdout should be delivered to the detail renderer as it arrives')
  assert(source.includes('this.renderDetailRows(terminal, state, streamedText)'), 'latency detail should re-render rows while streaming data arrives')
  assert(source.includes('localLatencyDetailScript'), 'latency detail should have a local traceroute script')
  assert(source.includes('windowsLatencyDetailScript'), 'latency detail should have a Windows tracert script')
  assert(source.includes("getLocalPlatform() === 'win32'"), 'latency detail should select the Windows local traceroute implementation on Windows')
  assert(source.includes('powershell.exe') && source.includes('tracert.exe'), 'Windows latency detail should use PowerShell and tracert')
  assert(source.includes('emit_fast_row()') && source.includes('emit_geo_row()'), 'local latency detail should emit fast rows first and enrich geo data later')
  assert(source.includes('fflush()'), 'local latency detail shell output should flush rows immediately')
  assert(source.includes('traceroute -I -n -w 1 -q 1 -m 12 "$target"'), 'local latency detail should prefer bounded ICMP traceroute from the local machine to the SSH host')
  assert(source.includes('traceroute -n -w 1 -q 1 -m 12 "$target"'), 'local latency detail should keep bounded UDP traceroute as a fallback')
  assert(source.includes('get_direct_route()'), 'local latency detail should detect the physical route when a TUN route hides intermediate hops')
  assert(source.includes('route -n get "$target"'), 'local latency detail should inspect the current macOS route to the SSH target')
  assert(source.includes('netstat -rn -f inet'), 'local latency detail should find a non-TUN default route for direct physical tracing')
  assert(source.includes('traceroute -I -i "$direct_iface" -s "$direct_src" -n -w 1 -q 1 -m 30 "$target"'), 'local latency detail should use a deeper direct ICMP trace to reach long international routes')
  assert(source.includes('traceroute -i "$direct_iface" -s "$direct_src" -n -w 1 -q 1 -m 30 "$target"'), 'local latency detail should try direct physical-interface traceroute before TUN/proxy-shaped probes')
  assert(source.includes('probe_target_direct') && source.includes('ping -S "$direct_src"'), 'local latency detail should append a direct target row when traceroute does not terminate at the SSH host')
  assert(!source.includes('traceroute -n -w 1 -q 3 -m 24 "$target"'), 'local latency detail must not use a 72-second traceroute shape that exceeds the command timeout')
  assert(source.includes('getLatencyTraceTarget'), 'latency detail should trace the current SSH target instead of a fixed public DNS target')
  assert(source.includes('target=__TABBY_STATUS_TRACE_TARGET__'), 'latency detail script should receive an injected trace target')
  assert(!source.includes('fallback_target=__TABBY_STATUS_FALLBACK_TRACE_TARGET__'), 'latency detail must not silently replace the SSH target with a public DNS target')
  assert(!source.includes('target="$fallback_target"'), 'latency detail must not turn local-to-server tracing into server-to-public-DNS tracing')
  assert(source.includes('shellQuote'), 'latency trace target must be shell-quoted')
  assert(!source.includes('const script = String.raw`target=1.1.1.1'), 'latency detail must not hard-code 1.1.1.1 as the trace target')
  assert(source.includes('ptr_lookup()'), 'latency detail should attempt PTR lookup for route hops')
  assert(source.includes('geo_lookup()'), 'latency detail should fill location and AS fields when possible')
  assert(source.includes('局域网'), 'latency detail should mark private hops as LAN')
  assert(source.includes('collectLatencyDetails(terminal, ssh, text =>'), 'latency detail collection must use the dedicated streaming collector callback')
  assert(source.includes('traceroute -n -w 1 -q 1 -m 12') && source.includes('tracepath -n -m 12'), 'latency detail should use bounded traceroute/tracepath fallback')
  assert(source.includes('ping -c 3 -W 1 "$ip"'), 'tracepath fallback must sample each discovered hop instead of showing one-shot tracepath data')
  assert(source.includes('while [ "$ttl" -le 16 ]') && source.includes('ping -c 1 -W 1 -t "$ttl"'), 'latency detail should still show multiple hops when only ping is available')
  assert(source.includes('gsub(/[^0-9]/,"",hop)'), 'MTR hop labels must strip report-mode markers like .|--')
  assert(source.includes('last=$5') && source.includes('avg=$6') && source.includes('best=$7') && source.includes('worst=$8'), 'MTR metrics must map Last/Avg/Best/Worst columns correctly')
  assert(source.includes('if($i=="received," && i>1) received=$(i-1)+0') && source.includes('loss=sprintf("%.0f%%", sent>0 ? (sent-received)*100/sent : 0)'), 'ping TTL fallback must compute per-hop packet loss from sent/received counts')
  assert(source.includes('reached=1') && source.includes('[ "$reached" = "1" ] && break'), 'ping TTL fallback must stop after reaching the target')
  assert(source.includes("rowsByHop.set(row.hop"), 'latency detail rows should merge streamed updates for the same hop instead of duplicating rows')
  assert(source.includes('showIpCopyFeedback'), 'IP copy action should show immediate button feedback')
  assert(source.includes('已复制') && source.includes('复制失败'), 'IP copy feedback should cover success and failure states')
  assert(source.includes('bindIfacePicker'), 'main network iface label should open an interface picker')
  assert(source.includes('data-action="iface-picker"'), 'network iface label should be a clickable picker control')
  assert(source.includes('ifaceList') && source.includes('selectedIface'), 'network collector should expose interface list and selected interface')
  assert(source.includes('selectNetworkInterface'), 'network interface picker should be able to switch the selected interface')
  assert(source.includes('networkIfaceSelection'), 'selected network interface should be stored per terminal')
  assert(source.includes('closeIfaceMenu'), 'network interface picker menu should close cleanly')
  assert(source.includes('netSnapshots.delete(terminal)') && source.includes('netHistory.delete(terminal)'), 'switching network interfaces must reset rate baselines and chart history')
  assert(source.includes('--tfs-bg: var(--theme-background') || source.includes('--tfs-bg: var(--terminal-background'), 'plugin background should derive from Tabby theme variables')
  assert(source.includes('.tabby-status-layout,\n      .tfs-detail-backdrop,\n      .tfs-context-menu,\n      .tfs-iface-menu'), 'theme-derived variables must also apply to body-mounted detail and menu overlays')
  assert(source.includes('bindThemeSync'), 'main panel must bind a live theme synchronizer')
  assert(source.includes('syncThemeVars'), 'theme changes must refresh plugin CSS variables after mount')
  assert(source.includes('window.getComputedStyle'), 'theme synchronizer must read current Tabby/terminal computed colors')
  assert(source.includes('new MutationObserver(refresh)'), 'theme synchronizer must react to Tabby theme class/style changes')
  assert(source.includes("attributeFilter: ['class', 'style', 'data-theme']"), 'theme observer should be limited to theme-relevant attributes')
  assert(source.includes('window.setInterval(refresh, 1000)'), 'theme synchronizer needs a polling fallback for computed-only theme changes')
  assert(source.includes('applyCurrentThemeToOverlay'), 'body-mounted detail and menu overlays must copy the active panel theme')
  assert(source.includes('background: var(--tfs-bg)'), 'main panel should use theme-derived background')
  assert(source.includes('color: var(--tfs-text-primary)'), 'main panel text should use theme-derived foreground')
  assert(source.includes('background: var(--tfs-surface)'), 'menus and detail dialogs should use theme-derived surfaces')
  assert(source.includes('tfs-col-resizer'), 'detail table columns must be draggable')
  assert(source.includes('data-default-width'), 'detail columns must keep default widths for reset')
  assert(source.includes('data-min-width') && source.includes('data-max-width'), 'detail columns must use per-column resize bounds')
  assert(source.includes("handle.addEventListener('dblclick'"), 'detail column resize handles must support double-click reset')
  assert(!source.includes('Math.max(140, Math.min(720'), 'detail column resizing must not force all columns to a 140px minimum')
  assert(source.includes('getDetailColumnsWidth(columns)'), 'detail table width must equal the sum of column widths')
  assert(source.includes('updateDetailTableWidth(state)'), 'detail table width must be recalculated after column resizing')
  assert(!source.includes('updateDetailTableWidth(state, key)'), 'resizing one detail column must only recalculate total table width')
  assert(source.includes('fillDetailTableWidth(state)'), 'detail table width should be filled only during initial layout')
  assert(source.includes('data-fill="1"'), 'detail tables must use explicit fill columns instead of leaving right-side blank space')
  assert(source.includes('state.body.clientWidth'), 'detail tables must fill the visible detail panel width')
  assert(source.includes('renderEmptyDetailRows(state)'), 'detail modals must render a stable empty fallback before data arrives')
  assert(source.includes('data-empty-detail="1"'), 'detail empty fallback must be a table row, not a floating status line')
  assert(source.includes('tfs-detail-skeleton'), 'detail empty fallback must show visible per-column skeleton placeholders')
  assert(source.includes('columns.map((column, colIndex)'), 'detail empty fallback must align placeholders with the current columns')
  assert(!source.includes('col.dataset.col !== resizedKey'), 'resizing one detail column must not redistribute any other columns')
  assert(!source.includes('.tfs-detail-table { width: max-content; min-width: 100%;'), 'detail tables must not stretch short network/latency columns across the whole modal')
  assert(source.includes('scrollbar-color: color-mix(in srgb, var(--tfs-accent) 42%, transparent)'), 'detail modal scrollbars must derive from the active Tabby theme')
  assert(source.includes('PID') && source.includes('用户') && source.includes('位置'), 'process detail headers are incomplete')
  assert(source.includes('contextmenu'), 'process detail rows must support right-click actions')
  assert(source.includes('终止进程') && source.includes('复制PID') && source.includes('复制名称') && source.includes('复制命令') && source.includes('复制位置'), 'process context menu actions are incomplete')
  assert(source.includes('kill -TERM'), 'process context menu must terminate processes through SSH')
  assert(source.includes('getProcessName'), 'process context menu must derive a copyable process name')
  assert(source.includes('监听IP') && source.includes('IP数') && source.includes('连接数') && source.includes('上传') && source.includes('下载'), 'network detail headers are incomplete')
  assert(source.includes('跳数') && source.includes('PTR') && source.includes('地理位置 / 仅供参考') && source.includes('AS') && source.includes('丢包率') && source.includes('发包') && source.includes('最新(ms)') && source.includes('最快(ms)') && source.includes('最慢(ms)') && source.includes('平均(ms)'), 'latency detail headers are incomplete')
  assert(source.includes('formatBytesPerSecond'), 'network counters must be converted to per-second rates')
  assert(source.includes('cpuBusy'), 'CPU must be sampled as counters for delta calculation')
  assert(source.includes('idleAll=$5+$6'), 'Linux CPU idle must include iowait')
  assert(source.includes('nonIdle=$2+$3+$4+$7+$8+$9'), 'Linux CPU busy must exclude iowait')
  assert(source.includes('printf "%.0f|%.0f", nonIdle,total'), 'Linux CPU counters must be printed as full decimal integers')
  assert(!source.includes('printf "%s|%s", nonIdle,total'), 'Linux CPU counters must not use awk default string formatting')
  assert(!source.includes('busy=$2+$3+$4+$6+$7+$8'), 'Linux CPU busy must not include iowait')
  assert(source.includes('busyDelta <= totalDelta'), 'invalid CPU deltas must not produce percentages above 100')
  assert(source.includes('clampPercent'), 'rendered percentages must be clamped to 0-100')
  assert(source.includes('Math.round(Number.isFinite(number) ? number : 0)'), 'meter percentages should be rounded to whole numbers')
  assert(source.includes('collectorGenerations'), 'stale collector results must be ignored after session changes')
  assert(source.includes('sessionKeys'), 'collector reschedules must not reset CPU snapshots unless the SSH session changes')
  assert(source.includes('sessionChanged'), 'session changes must control snapshot resets')
  assert(source.includes('this.inflight.delete(terminal)'), 'rescheduling collectors must clear stale in-flight locks')
  assert(source.includes('this.cpuSnapshots.delete(terminal)'), 'rescheduling collectors must reset CPU snapshots')
  assert(source.includes('this.netSnapshots.delete(terminal)'), 'rescheduling collectors must reset network snapshots')
  assert(source.includes('fmt_kib'), 'swap values should use compact M/G units')
  assert(source.includes('renderNetworkChart'), 'network history chart renderer is missing')
  assert(source.includes('cpuCores'), 'fast collector must report CPU core count')
  assert(source.includes('data-k="net-peak"'), 'network chart must show peak rate')
  assert(source.includes('api.ipify.org'), 'slow collector must prefer public IP')
  assert(source.includes('ifconfig.me/ip'), 'public IP collector must have a second provider fallback')
  assert(source.includes('icanhazip.com'), 'public IP collector must have a third provider fallback')
  assert(source.includes('--connect-timeout 1 --max-time 1'), 'public IP curl collection must use a short timeout')
  assert(source.includes('wget -qO- -T 1'), 'public IP wget collection must use a short timeout')
  assert(!source.includes('--max-time 4'), 'public IP collection must not spend most of the SSH exec timeout budget')
  assert(source.includes('publicIp'), 'collector must keep public IP separate')
  assert(source.includes('localIp'), 'collector must keep local interface IP as fallback')
  assert(source.indexOf('fetch_public_ip()') > source.indexOf('localIp=$(hostname -I'), 'slow collector must gather local fallback before public IP lookups')
  assert(source.includes('data-k="ip-type"'), 'IP row must show whether address is public or local')
  assert(source.includes('公网'), 'public IP label is missing')
  assert(source.includes('本机'), 'local IP fallback label is missing')
  assert(!source.includes('data-k="status"'), 'main panel must not render any dim status text under the IP row')
  assert(source.includes('setStatus(panel)'), 'collector errors should only affect the status dot')
  assert(!source.includes("this.setData(panel, 'status'"), 'main panel status text must never be written under the IP row')
  assert(!source.includes("setStatus(panel, `采集失败:"), 'collector errors must not overwrite the IP value')
  assert(!source.includes('采集正常'), 'normal collection state should not render status text')
  assert(source.includes('clientLatency'), 'latency must be measured from local Tabby to the SSH server')
  assert(source.includes('next.processes = current.processes'), 'empty process refresh must preserve the existing process list')
  assert(!source.includes('delete next.processes'), 'empty process refresh must not delete the existing process list')
  assert(source.includes('--tfs-proc-columns: 56px 56px minmax(0, 1fr)'), 'process columns must keep memory/CPU from squeezing together')
  assert(source.includes('data-sort="mem"'), 'process memory header must support sorting')
  assert(source.includes('data-sort="cpu"'), 'process CPU header must support sorting')
  assert(source.includes('bindProcessSorting'), 'process sort header click handling is missing')
  assert(source.includes('sortProcesses'), 'process list sorting implementation is missing')
  assert(source.includes('renderProcessSortState'), 'process sort state rendering is missing')
  assert(source.includes('tfs-sort-active'), 'active process sort style is missing')
  assert(source.includes('data-dir="desc"'), 'process sort direction indicator is missing')
  assert(source.includes('font-family: inherit; font-size: 11px; line-height: inherit'), 'sortable process headers must keep the compact header font size')
  assert(!source.includes('<span>MEM</span>'), 'process memory header must not use MEM')
  assert(source.includes('.tfs-tabs button:nth-child(1), .tfs-tabs button:nth-child(2), .tfs-processes span:nth-child(1), .tfs-processes span:nth-child(2)'), 'process headers and numeric values must share left alignment')
  assert(source.includes('text-align: left'), 'process columns must be left aligned')
  assert(source.includes('"Darwin"'), 'collectors must support macOS/Darwin hosts')
  assert(source.includes('vm_stat'), 'Darwin collector must gather memory metrics')
  assert(source.includes('netstat -ibn'), 'Darwin collector must gather network byte counters')
  assert(source.includes('now_ms()'), 'collector timing must be portable across GNU/BSD date')
  assert(source.includes('data-k="latency-bars"'), 'latency area must include a visual chart')
  assert(source.includes('latencyHistory'), 'latency readings must be kept as history')
  assert(!source.includes('margin: 5px 0 2px 42px'), 'network and latency charts must not reserve an empty left gutter')
  assert(source.includes('.tfs-net-bars { height: 38px; margin: 5px 0 2px;'), 'network chart bars should start at the left content edge')
  assert(source.includes('.tfs-latency-bars { height: 34px; margin: 5px 0 2px;'), 'latency chart bars should start at the left content edge')
  assert(source.includes('未启用'), 'zero swap must be shown as disabled')
  assert(source.includes('tfs-idle'), 'network chart must show an idle state')
  assert(source.includes('overflow-y: auto'), 'process list must be scrollable')
  assert(source.includes('white-space: nowrap'), 'meter values must stay on one line')
  assert(source.includes('.tfs-nowrap'), 'shared no-wrap class must protect compact labels')
  assert(source.includes('min-width: 0'), 'compact grid/flex labels must be allowed to ellipsize on one line')
  assert(source.includes('grid-template-columns: 42px minmax(0, 1fr)'), 'meter rows must let the progress bar take the full remaining width')
  assert(source.includes('height: 15px'), 'meter bars must be tall enough to contain inline value text')
  assert(source.includes('--tfs-text-primary: var(--theme-foreground, var(--terminal-foreground, #d7dee0))'), 'main body text color must be centralized and derive from Tabby theme variables')
  assert(source.includes('.tfs-meter b { text-align: right'), 'meter values must align to the same right edge')
  assert(source.includes('.tfs-meter i { position: relative; height: 15px; border-radius: 999px; background: color-mix(in srgb, var(--tfs-text-primary) 13%, transparent); overflow: hidden; }'), 'meter progress container should keep its existing italic text behavior while following the Tabby theme')
  assert(source.includes('color: var(--tfs-text-primary) !important; opacity: 1; font-weight: 600'), 'meter value text must force the same color as process text while preserving italic rendering')
  assert(source.includes('font-size: 11px'), 'meter value text must stay compact inside the bar')
  assert(source.includes('font-variant-numeric: tabular-nums'), 'meter value text must use tabular numbers')
  assert(source.includes('.tfs-meter b.tfs-disabled-value { color: var(--tfs-text-primary) !important; opacity: 1; font-weight: 600; }'), 'disabled swap text must match the same readable meter text color')
  assert(!source.includes('margin-left: -132px'), 'meter values must not be visually overlaid on the bar')
  assert(source.includes('setMeterData(panel, \'cpu\', this.formatPercent(payload.cpu))'), 'CPU meter should include a right-side percentage for row consistency')
  assert(source.includes('setMeterData(panel, \'mem\', this.formatPercent(payload.memPct), `${payload.memUsed}/${payload.memTotal}`)'), 'memory meter should keep percentage and capacity visible')
  assert(source.includes('setMeterData(panel, \'swap\', payload.swapTotal === \'0M\' ? \'未启用\' : this.formatPercent(payload.swapPct)'), 'swap meter should keep percentage and capacity visible when enabled')
  assert(source.includes('detail ? `${percent} · ${detail}` : percent'), 'meter percentage and raw detail should render as one right-aligned inline label')
  assert(!source.includes('background: rgba(23,30,32,.72)'), 'meter value text must not use a tag-like dark backing')
  assert(source.includes('.tfs-meter-value { position: absolute; inset: 0 8px 0 8px; z-index: 1; display: grid; grid-template-columns: 1fr; align-items: center; color: var(--tfs-text-primary) !important; opacity: 1; text-shadow: none; }'), 'meter value text should stay inside the progress bar and match process text rendering')
  assert(source.includes('.tfs-meter-value span:first-child { text-align: right; color: var(--tfs-text-primary) !important; opacity: 1; }'), 'meter labels must align cleanly to the right edge')
  assert(source.includes('.tfs-processes span { overflow: hidden; text-overflow: ellipsis; min-width: 0; color: var(--tfs-text-primary); opacity: 1; }'), 'process text must use the shared primary text color')
  assert(source.includes('.tabby-status td { position: relative; padding: 3px 5px; color: var(--tfs-text-primary); opacity: 1;'), 'disk table text must use the shared primary text color')
  assert(source.includes('.tfs-meter-value span:last-child { display: none;'), 'meter detail node should not split the label across the bar')
  assert(!source.includes('.tfs-meter-value.tfs-meter-no-detail { display: block; }'), 'meter rows without details must not switch to a different text layout')
  assert(source.includes('.tfs-meter-value.tfs-meter-no-detail { grid-template-columns: 1fr; }'), 'meter rows without details must right-align in the fixed value column')
  assert(source.includes('tfs-meter-no-detail'), 'meter rows without capacity details must have a stable no-detail state')
  assert(source.includes('data-k="mem-pct"') && source.includes('data-k="mem-detail"'), 'memory meter must split percent and detail into aligned nodes')
  assert(source.includes('可用/大小'), 'disk header must show available/size')
  assert(!source.includes('已用/可用/大小'), 'disk header must not include used')
  assert(source.includes('printf "disk\\t%s\\t%s\\t%s\\t%s\\n", $6,$4,$2,$5'), 'disk collector must emit available and size from df')
  assert(source.includes('${this.escape(d.avail)}/${this.escape(d.size)}'), 'disk rows must render available/size only')
  assert(!source.includes('this.escape(d.used)'), 'disk rows must not render used')
  assert(source.includes('tfs-resizer'), 'panel must include a horizontal resize handle')
  assert(source.includes('--tfs-panel-width'), 'panel width must drive host layout through a CSS variable')
  assert(source.includes('localStorage'), 'panel width should persist after Tabby restart')
  assert(source.includes('clearScheduledCollectors'), 'collector timers must be cleaned up centrally')
  assert(source.includes('window.clearTimeout'), 'initial collector timeouts must be cleared on detach/reschedule')
  assert(source.includes('this.panels.delete(terminal)'), 'detached panels must be removed from decorator state')
  assert(!source.includes('.tabby-status-host .xterm'), 'terminal width must not be reduced twice by host padding and xterm width')
  assert(source.includes('scrollbar-width: none'), 'scrollbars must be hidden while preserving scroll')
  assert(source.includes('count>=30'), 'process collector must return enough rows for scrolling')
  assert(source.includes('$4 !~ /^(ps|awk|sh|bash)$/'), 'process collector must filter collector helper processes')
  assert(source.includes('terminalElement.parentElement ?? terminalElement'), 'status panel should mount on the terminal outer container')
  assert(source.includes('tabby-status-layout'), 'status panel should use one stable outer layout container')
  assert(!source.includes('padding-left: var(--tfs-panel-width)'), 'outer layout must not shift every Tabby layer with host padding')
  assert(source.includes('.tabby-status-layout .content'), 'terminal content must be laid out inside the reserved content area')
  assert(source.includes('calc(var(--tfs-panel-width) + var(--tfs-content-margin))'), 'terminal content margin must include the status panel width')
  assert(source.includes('.tabby-status-layout sftp-panel'), 'SFTP absolute panel must be laid out inside the reserved content area')
  assert(source.includes('width: calc(100% - var(--tfs-panel-width))'), 'SFTP absolute panel width must subtract the status panel width')
  assert(source.includes('scheduleTerminalResize'), 'xterm frontend must be resized after layout width changes')
  assert(source.includes('resizeHandler'), 'xterm private resize handler should be used when available')
  assert(!source.includes('bindHostLayoutMode'), 'layout must not depend on SFTP click detection')
  assert(!source.includes('clearHostLayoutMode'), 'layout must not keep SFTP click handlers')
  assert(!source.includes('tabby-status-sftp-open'), 'SFTP-specific hide mode must be removed')
  assert(!source.includes('sftpModeUntil'), 'SFTP mode must not expire while the panel is still open')
  assert(!source.includes('isSftpPanelOpen'), 'SFTP mode must not poll DOM text and trigger delayed layout changes')
  assert(!source.includes('window.setInterval(refresh, 2000)'), 'SFTP layout must not re-check and move content after a delay')
  assert(!source.includes('transition-duration: 0s !important'), 'layout should not suppress SFTP animations with global hacks')
  assert(!source.includes('padding-left: 0 !important'), 'layout should not toggle reserved space when SFTP opens')
  assert(!source.includes('display: none !important'), 'status panel must not be hidden while SFTP is open')
  assert(!source.includes('.tabby-status-layout.tabby-status-sftp-open > :not(.tabby-status)'), 'SFTP content must not use a special shifted mode')
  assert(source.includes('left: 0'), 'status panel should be anchored to the left')
  assert(!source.includes('padding-right: 320px'), 'status panel should not reserve right-side space')
  assert(source.includes('.tabby-status table'), 'table styles must be scoped to the status panel')
  assert(source.includes('.tabby-status th:last-child { text-align: right; }'), 'disk size header must align right with disk values')
  assert(!source.includes('\n      table {'), 'table styles must not leak globally')
  assert(!source.includes('\n      th {'), 'th styles must not leak globally')
  assert(!source.includes('\n      td {'), 'td styles must not leak globally')
  assert(!source.includes('unescape(encodeURIComponent'), 'collector encoding must not use deprecated unescape')
}

function testPayloadParser () {
  const payload = [
    'ip\t129.150.62.28',
    'uptime\t27 天',
    'load\t0.39, 0.79, 0.75',
    'cpu\t12',
    'mem\t22|5.0G|23.4G|20|191M|976M',
    'rx\t5K',
    'tx\t25K',
    'iface\teth0',
    'latency\t8',
    'disk\t/\t70.7G\t194.0G\t64',
    'proc\t123\t1.2\t0.4\tsshd',
    '',
  ].join('\n')
  const parsed = parseMetricPayload(payload)
  assert(parsed.ip === '129.150.62.28', 'ip parse failed')
  assert(parsed.disks === '/,70.7G,194.0G,64', 'disk parse failed')
  assert(parsed.processes === '123,1.2,0.4,sshd', 'process parse failed')

  const legacy = parseMetricPayload('{"ip":"10.0.0.1","cpu":7}')
  assert(legacy.ip === '10.0.0.1', 'legacy JSON payload parse failed')

  const fastOnly = parseMetricPayload('cpuBusy\t10\ncpuTotal\t100\nmem\t22|5.0G|23.4G|20|191M|976M\n')
  assert(!('disks' in fastOnly), 'fast payload must not clear disks')
  assert(!('processes' in fastOnly), 'fast payload must not clear processes')
}

function testLargeCpuCounterFormatting () {
  const sample = 'cpu  152735819 10554 34414174 22693559720 119874640 0 58283463 0 0 0\n'
  const script = 'NR==1{idleAll=$5+$6; nonIdle=$2+$3+$4+$7+$8+$9; total=idleAll+nonIdle; printf "%.0f|%.0f", nonIdle,total}'
  const formatted = execFileSync('awk', [script], { input: sample, encoding: 'utf8' }).trim()
  assert(formatted === '245444010|23058878370', 'large /proc/stat counters must not be formatted in scientific notation')
  assert(!/[eE]\+/.test(formatted), 'large /proc/stat counters must stay decimal')
}

function testInstalledPluginShape () {
  const installedRoot = path.join(os.homedir(), 'Library/Application Support/tabby/plugins/node_modules')
  const installed = path.join(installedRoot, pkg.name)
  if (!fs.existsSync(installed)) {
    console.warn(`skip installed plugin check: ${installed} does not exist`)
    return
  }
  const installedPkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'))
  assert(installedPkg.name === pkg.name, 'installed plugin package name mismatch')
  assert(installedPkg.keywords?.includes('tabby-plugin'), 'installed plugin keyword missing')
  assert(installedPkg.author, 'installed plugin author missing')
  assert(fs.existsSync(path.join(installed, installedPkg.main)), 'installed plugin main missing')
  assert(fs.existsSync(path.join(installed, installedPkg.typings)), 'installed plugin typings missing')

  for (const peer of ['tabby-core', 'tabby-terminal', 'rxjs', '@angular/core', '@angular/common']) {
    assert(!fs.existsSync(path.join(installedRoot, peer, 'package.json')), `installed plugin directory must not include auto-installed peer dependency ${peer}`)
  }
}

function testShellCollectorShape () {
  const shell = String.raw`set -eu
encoded=$(printf "printf 'ip\\t127.0.0.1\\nlatency\\t1\\n'" | base64 | tr -d "\n")
decoded=$(printf "%s" "$encoded" | base64 -d | sh)
test "$decoded" = "$(printf "ip\t127.0.0.1\nlatency\t1")"`
  execFileSync('sh', ['-c', shell], { stdio: 'pipe' })
}

testPackageShape()
testBuildOutput()
testGithubWorkflow()
testZipOnlyPackagingScripts()
testTieredRefreshSource()
testPayloadParser()
testLargeCpuCounterFormatting()
testInstalledPluginShape()
testShellCollectorShape()

console.log('smoke tests passed')
