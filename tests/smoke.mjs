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
      const [mountPath, used, size, pct] = parts
      disks.push([mountPath, used, size, pct].join(','))
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
  assert(pkg.scripts?.['pack:plugin']?.includes('npm pack --pack-destination release'), 'pack:plugin should create a distributable plugin artifact')
  assert(pkg.scripts?.['install-local']?.includes('npm install --prefix'), 'install-local should install directly into Tabby plugin prefix')
  assert(pkg.scripts?.['install-local']?.includes('--legacy-peer-deps'), 'install-local must not auto-install Tabby/Angular peer dependencies into the plugin directory')
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
  assert(workflow.includes('npm ci --legacy-peer-deps'), 'workflow must install with legacy peer deps for Tabby peer packages')
  assert(workflow.includes('node node_modules/typescript/bin/tsc --noEmit'), 'workflow must run TypeScript type check')
  assert(workflow.includes('npm run test:smoke'), 'workflow must run smoke tests')
  assert(workflow.includes('npm run pack:plugin'), 'workflow must build the installable plugin package')
  assert(workflow.includes('actions/upload-artifact@v4'), 'workflow must upload the plugin tgz as an Actions artifact')
  assert(workflow.includes('softprops/action-gh-release@v2'), 'workflow must publish tgz files on version tags')
  assert(workflow.includes('release/*.tgz'), 'workflow must publish the generated tgz files')
}

function testTieredRefreshSource () {
  const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8')
  assert(source.includes("collectViaSshExec(terminal, 'fast'"), 'fast collector is missing')
  assert(source.includes("collectViaSshExec(terminal, 'process'"), 'process collector is missing')
  assert(source.includes("collectViaSshExec(terminal, 'slow'"), 'slow collector is missing')
  assert(source.includes('window.setInterval(fastLaunch, 1000)'), 'fast collector must refresh every 1 second')
  assert(source.includes('window.setInterval(processLaunch, 3000)'), 'process collector must refresh every 3 seconds')
  assert(source.includes('window.setInterval(slowLaunch, 10000)'), 'slow collector must refresh every 10 seconds')
  assert(source.includes('formatBytesPerSecond'), 'network counters must be converted to per-second rates')
  assert(source.includes('cpuBusy'), 'CPU must be sampled as counters for delta calculation')
  assert(source.includes('idleAll=$5+$6'), 'Linux CPU idle must include iowait')
  assert(source.includes('nonIdle=$2+$3+$4+$7+$8+$9'), 'Linux CPU busy must exclude iowait')
  assert(source.includes('printf "%.0f|%.0f", nonIdle,total'), 'Linux CPU counters must be printed as full decimal integers')
  assert(!source.includes('printf "%s|%s", nonIdle,total'), 'Linux CPU counters must not use awk default string formatting')
  assert(!source.includes('busy=$2+$3+$4+$6+$7+$8'), 'Linux CPU busy must not include iowait')
  assert(source.includes('busyDelta <= totalDelta'), 'invalid CPU deltas must not produce percentages above 100')
  assert(source.includes('clampPercent'), 'rendered percentages must be clamped to 0-100')
  assert(source.includes('formatPercent'), 'CPU percentages should support fractional display')
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
  assert(source.includes('data-k="status"'), 'collector errors must be shown outside the IP value')
  assert(source.includes('setStatus(panel, kind'), 'collector errors must keep existing metric values visible')
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
  assert(source.includes('未启用'), 'zero swap must be shown as disabled')
  assert(source.includes('tfs-idle'), 'network chart must show an idle state')
  assert(source.includes('overflow-y: auto'), 'process list must be scrollable')
  assert(source.includes('white-space: nowrap'), 'meter values must stay on one line')
  assert(source.includes('.tfs-nowrap'), 'shared no-wrap class must protect compact labels')
  assert(source.includes('min-width: 0'), 'compact grid/flex labels must be allowed to ellipsize on one line')
  assert(source.includes('grid-template-columns: 42px minmax(104px, 1fr) 132px'), 'meter rows must preserve details while keeping the progress bar usable')
  assert(source.includes('color: rgba(215,222,224,.62)'), 'meter value text must be visually subdued')
  assert(source.includes('.tfs-meter b { text-align: left'), 'meter values must sit close to the progress bar')
  assert(source.includes('font-size: 11px'), 'meter value text must stay secondary to the bar')
  assert(source.includes('font-variant-numeric: tabular-nums'), 'meter value text must use tabular numbers')
  assert(source.includes('tfs-disabled-value'), 'disabled swap text must have a weaker state style')
  assert(!source.includes('margin-left: -132px'), 'meter values must not be visually overlaid on the bar')
  assert(source.includes('setMeterData(panel, \'cpu\', this.formatPercent(payload.cpu))'), 'CPU meter should include a right-side percentage for row consistency')
  assert(source.includes('setMeterData(panel, \'mem\', this.formatPercent(payload.memPct), `${payload.memUsed}/${payload.memTotal}`)'), 'memory meter should keep percentage and capacity visible')
  assert(source.includes('setMeterData(panel, \'swap\', payload.swapTotal === \'0M\' ? \'未启用\' : this.formatPercent(payload.swapPct)'), 'swap meter should keep percentage and capacity visible when enabled')
  assert(source.includes('grid-template-columns: 38px minmax(0, 1fr)'), 'meter percentage and detail text must use aligned columns')
  assert(source.includes('tfs-meter-no-detail'), 'meter rows without capacity details must have a stable no-detail state')
  assert(source.includes('data-k="mem-pct"') && source.includes('data-k="mem-detail"'), 'memory meter must split percent and detail into aligned nodes')
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
  assert(source.includes('padding-left: var(--tfs-panel-width)'), 'status panel should reserve resizable space on the left')
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
    'disk\t/\t123.3G\t194.0G\t64',
    'proc\t123\t1.2\t0.4\tsshd',
    '',
  ].join('\n')
  const parsed = parseMetricPayload(payload)
  assert(parsed.ip === '129.150.62.28', 'ip parse failed')
  assert(parsed.disks === '/,123.3G,194.0G,64', 'disk parse failed')
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
testTieredRefreshSource()
testPayloadParser()
testLargeCpuCounterFormatting()
testInstalledPluginShape()
testShellCollectorShape()

console.log('smoke tests passed')
