import { Injectable, NgModule } from '@angular/core'
import TabbyCoreModule from 'tabby-core'
import { TerminalDecorator, BaseTerminalTabComponent } from 'tabby-terminal'

declare const __non_webpack_require__: any

type DiskRow = {
  path: string
  avail: string
  size: string
  pct: number
}

type ProcessRow = {
  pid: string
  cpu: string
  mem: string
  command: string
}

type ProcessDetailRow = {
  pid: string
  user: string
  mem: string
  cpu: string
  command: string
  location: string
}

type NetworkDetailRow = {
  pid: string
  name: string
  listenIp: string
  port: string
  ipCount: string
  connCount: string
  upload: string
  download: string
  uploadBytes?: number
  downloadBytes?: number
}

type LatencyDetailRow = {
  hop: string
  ip: string
  ptr: string
  location: string
  asn: string
  loss: string
  sent: string
  last: string
  best: string
  worst: string
  avg: string
}

type ProcessSortKey = 'mem' | 'cpu'
type ProcessSortDirection = 'desc' | 'asc'

type ProcessSortState = {
  key: ProcessSortKey
  direction: ProcessSortDirection
}

type DetailKind = 'process' | 'network' | 'latency'
type DetailSortDirection = 'desc' | 'asc'

type DetailSortState = {
  key: string
  direction: DetailSortDirection
}

type DetailColumn = {
  key: string
  label: string
  sortable: boolean
  width: number
  minWidth: number
  maxWidth: number
  fill?: boolean
}

type DetailModalState = {
  kind: DetailKind
  modal: HTMLElement
  body: HTMLElement
  title: HTMLElement
  status: HTMLElement
  pauseButton: HTMLButtonElement
  timer?: number
  inflight: boolean
  paused: boolean
  lastText?: string
  networkSnapshots?: Map<string, { uploadBytes: number, downloadBytes: number, ts: number }>
}

type StatusPayload = {
  ip: string
  ipType: string
  uptime: string
  load: string
  cpuCores: number
  cpu: number
  memPct: number
  memUsed: string
  memTotal: string
  swapPct: number
  swapUsed: string
  swapTotal: string
  rx: string
  tx: string
  iface: string
  ifaceList: string
  disks: DiskRow[]
  processes: ProcessRow[]
  latency: number
}

type CollectorKind = 'fast' | 'process' | 'slow'

type NetSnapshot = {
  rx: number
  tx: number
  ts: number
}

type CpuSnapshot = {
  busy: number
  total: number
}

type NetHistory = {
  rx: number[]
  tx: number[]
}

type LatencyHistory = {
  values: number[]
}

type TimerHandle = {
  id: number
  kind: 'interval' | 'timeout'
}

type ThemeColors = {
  background: string
  foreground: string
  accent: string
}

type ThemeSyncState = {
  observer?: MutationObserver
  interval?: number
  lastSignature?: string
}

@Injectable()
export class TabbyStatusDecorator extends TerminalDecorator {
  private readonly panelWidthStorageKey = 'tabby-status-width'
  private readonly panelCollapsedStorageKey = 'tabby-status-collapsed'
  private readonly minPanelWidth = 260
  private readonly maxPanelWidth = 560
  private readonly collapsedPanelWidth = 32
  private panels = new WeakMap<BaseTerminalTabComponent<any>, HTMLElement>()
  private hosts = new WeakMap<BaseTerminalTabComponent<any>, HTMLElement>()
  private timers = new WeakMap<BaseTerminalTabComponent<any>, TimerHandle[]>()
  private collectorGenerations = new WeakMap<BaseTerminalTabComponent<any>, number>()
  private sessionKeys = new WeakMap<BaseTerminalTabComponent<any>, unknown>()
  private inflight = new WeakMap<BaseTerminalTabComponent<any>, Set<CollectorKind>>()
  private state = new WeakMap<BaseTerminalTabComponent<any>, any>()
  private netSnapshots = new WeakMap<BaseTerminalTabComponent<any>, NetSnapshot>()
  private cpuSnapshots = new WeakMap<BaseTerminalTabComponent<any>, CpuSnapshot>()
  private netHistory = new WeakMap<BaseTerminalTabComponent<any>, NetHistory>()
  private latencyHistory = new WeakMap<BaseTerminalTabComponent<any>, LatencyHistory>()
  private processSort = new WeakMap<BaseTerminalTabComponent<any>, ProcessSortState>()
  private detailModals = new WeakMap<BaseTerminalTabComponent<any>, DetailModalState>()
  private detailSort = new WeakMap<BaseTerminalTabComponent<any>, DetailSortState>()
  private networkIfaceSelection = new WeakMap<BaseTerminalTabComponent<any>, string>()
  private pinnedPublicIps = new WeakMap<BaseTerminalTabComponent<any>, string>()
  private themeSyncs = new WeakMap<BaseTerminalTabComponent<any>, ThemeSyncState>()

  attach (terminal: BaseTerminalTabComponent<any>): void {
    super.attach(terminal)
    // Keep this visible for every terminal tab. Data collection is still harmless
    // on local shells and makes plugin loading immediately obvious.
    console.info('[tabby-status] decorator attached', terminal.profile)

    const panel = this.createPanel()
    this.bindProcessSorting(terminal, panel)
    this.bindDetailEntrypoints(terminal, panel)
    this.bindIfacePicker(terminal, panel)
    this.panels.set(terminal, panel)
    this.mountPanel(terminal, panel)

    this.subscribeUntilDetached(terminal, terminal.sessionChanged$.subscribe(() => {
      this.scheduleCollector(terminal)
    }))

    this.scheduleCollector(terminal)
  }

  detach (terminal: BaseTerminalTabComponent<any>): void {
    this.clearScheduledCollectors(terminal)
    this.panels.get(terminal)?.remove()
    const host = this.hosts.get(terminal)
    this.clearThemeSync(terminal)
    host?.classList.remove('tabby-status-layout')
    host?.classList.remove('tabby-status-collapsed', 'tfs-panel-toggling')
    host?.style.removeProperty('--tfs-panel-width')
    host?.style.removeProperty('--tfs-panel-active-width')
    this.clearThemeVars(host)
    this.panels.delete(terminal)
    this.hosts.delete(terminal)
    this.collectorGenerations.delete(terminal)
    this.sessionKeys.delete(terminal)
    this.inflight.delete(terminal)
    this.state.delete(terminal)
    this.netSnapshots.delete(terminal)
    this.cpuSnapshots.delete(terminal)
    this.netHistory.delete(terminal)
    this.latencyHistory.delete(terminal)
    this.processSort.delete(terminal)
    this.networkIfaceSelection.delete(terminal)
    this.pinnedPublicIps.delete(terminal)
    this.closeDetailModal(terminal)
    this.closeIfaceMenu()
    this.detailSort.delete(terminal)
    super.detach(terminal)
  }

  private scheduleCollector (terminal: BaseTerminalTabComponent<any>): void {
    this.clearScheduledCollectors(terminal)
    const generation = (this.collectorGenerations.get(terminal) ?? 0) + 1
    this.collectorGenerations.set(terminal, generation)
    this.inflight.delete(terminal)
    const sessionKey = this.getSessionKey(terminal)
    const sessionChanged = !this.sessionKeys.has(terminal) || this.sessionKeys.get(terminal) !== sessionKey
    this.sessionKeys.set(terminal, sessionKey)
    if (sessionChanged) {
      this.state.delete(terminal)
      this.cpuSnapshots.delete(terminal)
      this.netSnapshots.delete(terminal)
      this.netHistory.delete(terminal)
      this.latencyHistory.delete(terminal)
      this.pinnedPublicIps.delete(terminal)
    }

    const fastLaunch = () => {
      if (this.collectorGenerations.get(terminal) === generation) {
        void this.collectViaSshExec(terminal, 'fast', this.fastCollectorExecCommand(this.networkIfaceSelection.get(terminal) || ''), generation)
      }
    }
    const processLaunch = () => {
      if (this.collectorGenerations.get(terminal) === generation) {
        void this.collectViaSshExec(terminal, 'process', this.processCollectorExecCommand(), generation)
      }
    }
    const slowLaunch = () => {
      if (this.collectorGenerations.get(terminal) === generation) {
        void this.collectViaSshExec(terminal, 'slow', this.slowCollectorExecCommand(this.pinnedPublicIps.get(terminal) || ''), generation)
      }
    }

    const timers: TimerHandle[] = [
      { kind: 'interval', id: window.setInterval(fastLaunch, 1000) },
      { kind: 'interval', id: window.setInterval(processLaunch, 3000) },
      { kind: 'interval', id: window.setInterval(slowLaunch, 10000) },
      { kind: 'timeout', id: window.setTimeout(fastLaunch, 800) },
      { kind: 'timeout', id: window.setTimeout(processLaunch, 1200) },
      { kind: 'timeout', id: window.setTimeout(slowLaunch, 1600) },
    ]
    this.timers.set(terminal, timers)
  }

  private getSessionKey (terminal: BaseTerminalTabComponent<any>): unknown {
    return (terminal as any).sshSession ?? (terminal.session as any)?.ssh ?? terminal.session ?? null
  }

  private clearScheduledCollectors (terminal: BaseTerminalTabComponent<any>): void {
    for (const timer of this.timers.get(terminal) ?? []) {
      if (timer.kind === 'interval') {
        window.clearInterval(timer.id)
      } else {
        window.clearTimeout(timer.id)
      }
    }
    this.timers.delete(terminal)
  }

  private async collectViaSshExec (terminal: BaseTerminalTabComponent<any>, kind: CollectorKind, command: string, generation: number): Promise<void> {
    const panel = this.panels.get(terminal)
    if (!panel || this.collectorGenerations.get(terminal) !== generation) {
      return
    }
    const inflight = this.inflight.get(terminal) ?? new Set<CollectorKind>()
    this.inflight.set(terminal, inflight)
    if (inflight.has(kind)) {
      return
    }

    const sshSession = (terminal as any).sshSession ?? (terminal.session as any)?.ssh
    const ssh = sshSession?.ssh
    if (!ssh?.openSessionChannel || !ssh?.activateChannel) {
      return
    }

    inflight.add(kind)
    try {
      const startedAt = Date.now()
      const text = await this.runSshExec(ssh, command)
      if (this.panels.get(terminal) !== panel || this.collectorGenerations.get(terminal) !== generation) {
        return
      }
      const patch = this.parseMetricPayload(text, kind)
      if (kind === 'fast') {
        patch.clientLatency = Date.now() - startedAt
        patch.latency = patch.clientLatency
      }
      const merged = this.mergeMetricPatch(terminal, patch)
      this.render(terminal, panel, merged)
    } catch (error) {
      console.warn('[tabby-status] SSH exec failed', error)
      if (this.panels.get(terminal) === panel && this.collectorGenerations.get(terminal) === generation) {
        this.setStatus(panel)
      }
    } finally {
      inflight.delete(kind)
    }
  }

  private async runSshExec (ssh: any, command: string, timeoutMs = 8000): Promise<string> {
    const channel = await ssh.activateChannel(await ssh.openSessionChannel())
    let output = ''
    let stderr = ''

    const subs = [
      channel.data$?.subscribe((data: Uint8Array) => {
        output += new TextDecoder().decode(data)
      }),
      channel.extendedData$?.subscribe((data: Uint8Array) => {
        stderr += new TextDecoder().decode(data)
      }),
    ].filter(Boolean)

    try {
      await channel.requestExec(command)
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('timeout')), timeoutMs)
        const finish = () => {
          window.clearTimeout(timeout)
          resolve()
        }
        subs.push(channel.eof$?.subscribe(finish))
        subs.push(channel.closed$?.subscribe(finish))
      })
    } finally {
      for (const sub of subs) {
        sub?.unsubscribe?.()
      }
      await channel.close?.().catch?.(() => undefined)
    }

    if (!output.trim() && stderr.trim()) {
      throw new Error(stderr.trim().slice(0, 120))
    }
    return output
  }

  private fastCollectorExecCommand (selectedIface = ''): string {
    const safeSelectedIface = this.shellQuote(selectedIface)
    const script = String.raw`selected_iface=__TABBY_STATUS_SELECTED_IFACE__
now_ms() { perl -MTime::HiRes=time -e 'printf "%.0f", time()*1000' 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || printf "%s000" "$(date +%s)"; }
ts=$(now_ms)
os=$(uname -s 2>/dev/null)
if [ "$os" = "Darwin" ]; then
  load=$(uptime 2>/dev/null | awk -F'load averages?: ' '{print $2}' | awk -F', ' '{print $1", "$2", "$3}')
  cpu=$(top -l 1 -n 0 2>/dev/null | awk '/CPU usage/ {for(i=1;i<=NF;i++){if($i=="user,") user=$(i-1); if($i=="sys,") sys=$(i-1)} gsub("%","",user); gsub("%","",sys); printf "%d", user+sys}')
  cpuCores=$(sysctl -n hw.ncpu 2>/dev/null)
  mem=$(vm_stat 2>/dev/null | awk -v total="$(sysctl -n hw.memsize 2>/dev/null)" '/page size of/{page=$8; gsub(/\./,"",page)} /Pages active/{active=$3; gsub(/\./,"",active)} /Pages wired down/{wired=$4; gsub(/\./,"",wired)} /Pages occupied by compressor/{comp=$5; gsub(/\./,"",comp)} END{used=(active+wired+comp)*page; if(total>0) printf "%d|%.1fG|%.1fG|0|0M|0M", used*100/total, used/1073741824, total/1073741824; else printf "0|0G|0G|0|0M|0M"}')
  ifaceList=$(netstat -ibn 2>/dev/null | awk '$1!="Name" && $1!="lo0" && $7 ~ /^[0-9]+$/ && $10 ~ /^[0-9]+$/ {seen[$1]=1} END{first=1; for(iface in seen){if(!first) printf ","; printf "%s", iface; first=0}}')
  iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')
  if [ -n "$selected_iface" ] && printf ",%s," "$ifaceList" | grep -F ",$selected_iface," >/dev/null 2>&1; then
    iface="$selected_iface"
  fi
  bytes=$(netstat -ibn 2>/dev/null | awk -v iface="$iface" '$1==iface && $7 ~ /^[0-9]+$/ && $10 ~ /^[0-9]+$/ {rx+=$7; tx+=$10} END{printf "%s|%s", rx, tx}')
  rx=$(printf "%s" "$bytes" | cut -d'|' -f1)
  tx=$(printf "%s" "$bytes" | cut -d'|' -f2)
else
  load=$(awk '{print $1", "$2", "$3}' /proc/loadavg 2>/dev/null)
  cpuStats=$(awk 'NR==1{idleAll=$5+$6; nonIdle=$2+$3+$4+$7+$8+$9; total=idleAll+nonIdle; printf "%.0f|%.0f", nonIdle,total}' /proc/stat 2>/dev/null)
  cpuBusy=$(printf "%s" "$cpuStats" | cut -d'|' -f1)
  cpuTotal=$(printf "%s" "$cpuStats" | cut -d'|' -f2)
  cpuCores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null)
  mem=$(awk 'function fmt_kib(kib){return kib>=1048576?sprintf("%.1fG",kib/1048576):sprintf("%dM",kib/1024)} /MemTotal/{mt=$2}/MemAvailable/{ma=$2}/SwapTotal/{st=$2}/SwapFree/{sf=$2}END{mu=mt-ma; su=st-sf; printf "%d|%.1fG|%.1fG|%d|%s|%s", (mu*100/mt), mu/1048576, mt/1048576, st?su*100/st:0, fmt_kib(su), fmt_kib(st)}' /proc/meminfo 2>/dev/null)
  ifaceList=$(ls /sys/class/net 2>/dev/null | grep -v '^lo$' | paste -sd, -)
  iface=$(ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="dev"){print $(i+1);exit}}')
  [ -z "$iface" ] && iface=$(ls /sys/class/net 2>/dev/null | grep -v lo | head -1)
  if [ -n "$selected_iface" ] && [ -d "/sys/class/net/$selected_iface" ]; then
    iface="$selected_iface"
  fi
  rx=$(cat /sys/class/net/$iface/statistics/rx_bytes 2>/dev/null)
  tx=$(cat /sys/class/net/$iface/statistics/tx_bytes 2>/dev/null)
fi
lat=$(( $(now_ms) - ts ))
printf 'load\t%s\n' "$load"
printf 'cpuCores\t%s\n' "$cpuCores"
printf 'cpu\t%s\n' "$cpu"
printf 'cpuBusy\t%s\n' "$cpuBusy"
printf 'cpuTotal\t%s\n' "$cpuTotal"
printf 'mem\t%s\n' "$mem"
printf 'rxBytes\t%s\n' "$rx"
printf 'txBytes\t%s\n' "$tx"
printf 'iface\t%s\n' "$iface"
printf 'ifaceList\t%s\n' "$ifaceList"
printf 'selectedIface\t%s\n' "$selected_iface"
printf 'latency\t%s\n' "$lat"
`
    return this.encodeShellScript(script.replace('__TABBY_STATUS_SELECTED_IFACE__', safeSelectedIface))
  }

  private processCollectorExecCommand (): string {
    const script = String.raw`os=$(uname -s 2>/dev/null)
if [ "$os" = "Darwin" ]; then
  ps axo pid,pcpu,pmem,comm -r 2>/dev/null
else
  ps -eo pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null
fi | awk 'NR>1 && $4 !~ /^(ps|awk|sh|bash)$/ {printf "proc\t%s\t%s\t%s\t%s\n", $1,$2,$3,$4; count++; if(count>=30) exit}'
`
    return this.encodeShellScript(script)
  }

  private slowCollectorExecCommand (pinnedPublicIp = ''): string {
    const script = String.raw`os=$(uname -s 2>/dev/null)
publicIp=__TABBY_STATUS_PINNED_PUBLIC_IP__
localIp=""
if [ "$os" = "Darwin" ]; then
  iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')
  localIp=$(ipconfig getifaddr "$iface" 2>/dev/null)
  boot=$(sysctl -n kern.boottime 2>/dev/null | awk -F'[=,]' '{gsub(/ /,"",$2); print $2}')
  now=$(date +%s)
  [ -z "$boot" ] && boot="$now"
  up=$(( (now - boot) / 86400 ))
  up="$up 天"
else
  localIp=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -z "$localIp" ] && localIp=$(ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="src"){print $(i+1);exit}}')
  up=$(awk '{printf "%d 天", $1/86400}' /proc/uptime 2>/dev/null)
fi
fetch_public_ip() {
  url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -4 -fsS --connect-timeout 1 --max-time 1 "$url" 2>/dev/null | tr -d '[:space:]'
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- -T 1 "$url" 2>/dev/null | tr -d '[:space:]'
  fi
}
if [ -z "$publicIp" ]; then
for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com https://checkip.amazonaws.com; do
  [ -n "$publicIp" ] && break
  publicIp=$(fetch_public_ip "$url")
  case "$publicIp" in *.*) ;; *) publicIp="" ;; esac
done
fi
ipaddr="$publicIp"
[ -z "$ipaddr" ] && ipaddr="$localIp"
printf 'ip\t%s\n' "$ipaddr"
printf 'publicIp\t%s\n' "$publicIp"
printf 'localIp\t%s\n' "$localIp"
printf 'uptime\t%s\n' "$up"
df -P -h 2>/dev/null | awk 'NR>1{gsub("%","",$5); printf "disk\t%s\t%s\t%s\t%s\n", $6,$4,$2,$5}' | head -40
`
    return this.encodeShellScript(script.replace('__TABBY_STATUS_PINNED_PUBLIC_IP__', this.shellQuote(pinnedPublicIp)))
  }

  private encodeShellScript (script: string): string {
    const bytes = new TextEncoder().encode(script)
    const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    return `printf %s '${encoded}' | base64 -d | sh`
  }

  private createPanel (): HTMLElement {
    const panel = document.createElement('div')
    panel.className = 'tabby-status'
    panel.innerHTML = `
      <div class="tfs-panel-body">
        <div class="tfs-top"><span>系统监控</span><span class="tfs-dot"></span></div>
        <div class="tfs-ip"><span>IP</span><em data-k="ip-type">-</em><strong>等待连接</strong><button>复制</button></div>
        <div class="tfs-kv"><span>运行</span><b data-k="uptime">-</b></div>
        <div class="tfs-kv"><span>负载</span><b data-k="load">-</b></div>
        <div class="tfs-meter"><span>CPU</span><i><em data-bar="cpu"></em><b class="tfs-meter-value" data-meter="cpu"><span data-k="cpu-pct"></span><span data-k="cpu-detail"></span></b></i></div>
        <div class="tfs-meter"><span>内存</span><i><em data-bar="mem"></em><b class="tfs-meter-value" data-meter="mem"><span data-k="mem-pct">-</span><span data-k="mem-detail"></span></b></i></div>
        <div class="tfs-meter"><span>交换</span><i><em data-bar="swap"></em><b class="tfs-meter-value" data-meter="swap"><span data-k="swap-pct">-</span><span data-k="swap-detail"></span></b></i></div>
        <div class="tfs-section tfs-clickable" data-open-detail="process" title="打开进程详情">进程</div>
        <div class="tfs-tabs"><button type="button" data-sort="mem" aria-pressed="false" title="按内存排序">内存</button><button type="button" data-sort="cpu" aria-pressed="false" title="按 CPU 排序">CPU</button><span>命令</span></div>
        <div class="tfs-processes tfs-clickable" data-open-detail="process" data-k="processes" title="打开进程详情"></div>
        <div class="tfs-section tfs-clickable" data-open-detail="network" title="打开网络详情">网络</div>
        <div class="tfs-chart tfs-clickable" data-open-detail="network" title="打开网络详情"><div class="tfs-chart-head tfs-net-head tfs-nowrap"><b data-k="tx">0B/s</b><b data-k="rx">0B/s</b><strong data-k="net-peak">峰值 -</strong><button type="button" data-action="iface-picker" data-k="iface" title="切换网卡">-</button></div><div class="tfs-net-bars tfs-idle" data-k="net-bars"></div></div>
        <div class="tfs-chart tfs-lat tfs-clickable" data-open-detail="latency" title="打开延迟详情"><div class="tfs-chart-head tfs-lat-head tfs-nowrap"><b data-k="latency">0ms</b><strong data-k="latency-peak">延迟 -</strong></div><div class="tfs-latency-bars tfs-idle" data-k="latency-bars"></div></div>
        <div class="tfs-section">磁盘</div>
        <table><thead><tr><th>路径</th><th>可用/大小</th></tr></thead><tbody data-k="disks"></tbody></table>
        <div class="tfs-resizer" title="拖动调整面板宽度"></div>
      </div>
      <button type="button" class="tfs-collapse-toggle" data-action="panel-collapse" title="收起状态面板" aria-label="收起状态面板" aria-expanded="true"><span class="tfs-collapse-icon" aria-hidden="true"></span></button>
    `

    panel.querySelector<HTMLButtonElement>('.tfs-ip button')?.addEventListener('click', async event => {
      const button = event.currentTarget as HTMLButtonElement
      const ip = panel.querySelector('.tfs-ip strong')?.textContent ?? ''
      try {
        if (!navigator.clipboard?.writeText) {
          throw new Error('clipboard unavailable')
        }
        await navigator.clipboard.writeText(ip)
        this.showIpCopyFeedback(button, '已复制')
      } catch {
        this.showIpCopyFeedback(button, '复制失败')
      }
    })

    this.injectStyles()
    return panel
  }

  private showIpCopyFeedback (button: HTMLButtonElement, text: string): void {
    const original = button.dataset.originalText || button.textContent || '复制'
    button.dataset.originalText = original
    button.textContent = text
    button.classList.toggle('tfs-copy-ok', text === '已复制')
    button.classList.toggle('tfs-copy-fail', text === '复制失败')
    window.setTimeout(() => {
      button.textContent = original
      button.classList.remove('tfs-copy-ok', 'tfs-copy-fail')
    }, 1200)
  }

  private bindProcessSorting (terminal: BaseTerminalTabComponent<any>, panel: HTMLElement): void {
    for (const button of Array.from(panel.querySelectorAll<HTMLButtonElement>('.tfs-tabs button[data-sort]'))) {
      const key = button.dataset.sort
      if (key !== 'mem' && key !== 'cpu') {
        continue
      }

      const toggleSort = () => {
        const current = this.processSort.get(terminal)
        const direction: ProcessSortDirection = current?.key === key && current.direction === 'desc' ? 'asc' : 'desc'
        const next: ProcessSortState = { key, direction }
        this.processSort.set(terminal, next)
        this.renderProcessSortState(panel, next)

        const currentState = this.state.get(terminal)
        if (currentState?.processes !== undefined) {
          this.renderProcesses(panel, this.parseProcesses(currentState.processes), next)
        }
      }

      button.addEventListener('click', toggleSort)
    }
  }

  private bindIfacePicker (terminal: BaseTerminalTabComponent<any>, panel: HTMLElement): void {
    const button = panel.querySelector<HTMLButtonElement>('button[data-action="iface-picker"]')
    button?.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      this.openIfaceMenu(terminal, button)
    })
  }

  private openIfaceMenu (terminal: BaseTerminalTabComponent<any>, anchor: HTMLElement): void {
    this.closeIfaceMenu()
    const state = this.state.get(terminal) ?? {}
    const current = this.networkIfaceSelection.get(terminal) || ''
    const ifaceList = String(state.ifaceList || state.iface || '').split(',').map(item => item.trim()).filter(Boolean)
    const uniqueIfaces = Array.from(new Set(ifaceList))
    if (uniqueIfaces.length === 0) {
      return
    }

    const menu = document.createElement('div')
    menu.className = 'tfs-iface-menu'
    this.applyCurrentThemeToOverlay(terminal, menu)
    menu.innerHTML = [
      `<button type="button" data-iface="" class="${current ? '' : 'active'}">自动</button>`,
      ...uniqueIfaces.map(iface => `<button type="button" data-iface="${this.escape(iface)}" class="${iface === current ? 'active' : ''}">${this.escape(iface)}</button>`),
    ].join('')

    menu.addEventListener('click', event => {
      const item = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-iface]')
      if (!item) {
        return
      }
      this.selectNetworkInterface(terminal, item.dataset.iface || '')
    })

    document.body.appendChild(menu)
    const rect = anchor.getBoundingClientRect()
    const menuWidth = 168
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth))}px`
    menu.style.top = `${Math.min(window.innerHeight - 8, rect.bottom + 6)}px`
    window.setTimeout(() => {
      const close = (event: MouseEvent) => {
        if (!menu.contains(event.target as Node)) {
          this.closeIfaceMenu()
          document.removeEventListener('click', close)
        }
      }
      document.addEventListener('click', close)
    })
  }

  private selectNetworkInterface (terminal: BaseTerminalTabComponent<any>, iface: string): void {
    if (iface) {
      this.networkIfaceSelection.set(terminal, iface)
    } else {
      this.networkIfaceSelection.delete(terminal)
    }
    this.netSnapshots.delete(terminal)
    this.netHistory.delete(terminal)
    const current = this.state.get(terminal) ?? {}
    this.state.set(terminal, { ...current, selectedIface: iface, rx: '0B/s', tx: '0B/s', netHistory: { rx: [], tx: [] } })
    this.closeIfaceMenu()
    this.scheduleCollector(terminal)
  }

  private closeIfaceMenu (): void {
    for (const menu of Array.from(document.querySelectorAll('.tfs-iface-menu'))) {
      menu.remove()
    }
  }

  private bindDetailEntrypoints (terminal: BaseTerminalTabComponent<any>, panel: HTMLElement): void {
    for (const node of Array.from(panel.querySelectorAll<HTMLElement>('[data-open-detail]'))) {
      const kind = node.dataset.openDetail
      if (kind !== 'process' && kind !== 'network' && kind !== 'latency') {
        continue
      }
      node.addEventListener('click', event => {
        if ((event.target as HTMLElement).closest('button')) {
          return
        }
        this.openDetailModal(terminal, kind)
      })
    }
  }

  private openDetailModal (terminal: BaseTerminalTabComponent<any>, kind: DetailKind): void {
    this.closeDetailModal(terminal)
    this.detailSort.delete(terminal)

    const modal = document.createElement('div')
    modal.className = 'tfs-detail-backdrop'
    this.applyCurrentThemeToOverlay(terminal, modal)
    modal.innerHTML = `
      <div class="tfs-detail-dialog" role="dialog" aria-modal="true">
        <div class="tfs-detail-top">
          <div class="tfs-detail-title"><strong></strong><button type="button" class="tfs-detail-icon-button" data-action="pause" title="暂停自动刷新" aria-label="暂停自动刷新"><span class="tfs-detail-pause-icon"></span></button></div>
          <span data-k="detail-status"></span>
          <button type="button" title="关闭">关闭</button>
        </div>
        <div class="tfs-detail-body"></div>
      </div>
    `

    const title = modal.querySelector('.tfs-detail-top strong') as HTMLElement
    const status = modal.querySelector('[data-k="detail-status"]') as HTMLElement
    const body = modal.querySelector('.tfs-detail-body') as HTMLElement
    const pauseButton = modal.querySelector<HTMLButtonElement>('button[data-action="pause"]') as HTMLButtonElement
    title.textContent = this.getDetailTitle(kind)

    modal.addEventListener('click', event => {
      if (event.target === modal) {
        this.closeDetailModal(terminal)
      }
    })
    pauseButton.addEventListener('click', () => this.toggleDetailPause(terminal))
    const closeButton = Array.from(modal.querySelectorAll<HTMLButtonElement>('button')).find(button => button.dataset.action !== 'pause')
    closeButton?.addEventListener('click', () => this.closeDetailModal(terminal))

    document.body.appendChild(modal)
    const state: DetailModalState = { kind, modal, body, title, status, pauseButton, inflight: false, paused: false, networkSnapshots: kind === 'network' ? new Map() : undefined }
    this.detailModals.set(terminal, state)
    this.renderDetailShell(terminal, state)
    this.startDetailRefreshTimer(terminal, state)
    void this.refreshDetailModal(terminal)
  }

  private closeDetailModal (terminal: BaseTerminalTabComponent<any>): void {
    const state = this.detailModals.get(terminal)
    if (!state) {
      return
    }
    if (state.timer !== undefined) {
      window.clearInterval(state.timer)
    }
    this.closeContextMenu()
    state.modal.remove()
    this.detailModals.delete(terminal)
  }

  private async refreshDetailModal (terminal: BaseTerminalTabComponent<any>): Promise<void> {
    const state = this.detailModals.get(terminal)
    if (!state || state.inflight || state.paused) {
      return
    }

    const sshSession = (terminal as any).sshSession ?? (terminal.session as any)?.ssh
    const ssh = sshSession?.ssh
    if (!ssh?.openSessionChannel || !ssh?.activateChannel) {
      if (state.kind !== 'latency') {
        state.status.textContent = ''
        this.renderEmptyDetailRows(state)
        return
      }
    }

    state.inflight = true
    try {
      let streamedText = ''
      const text = state.kind === 'latency'
        ? await this.collectLatencyDetails(terminal, ssh, text => {
            if (this.detailModals.get(terminal) !== state) {
              return
            }
            streamedText = text
            state.lastText = text
            state.status.textContent = ''
            this.renderDetailRows(terminal, state, streamedText)
          })
        : await this.runSshExec(ssh, this.detailCollectorExecCommand(terminal, state.kind), 8000)
      if (this.detailModals.get(terminal) !== state) {
        return
      }
      state.status.textContent = ''
      const finalText = state.kind === 'latency' && this.parseLatencyDetails(text).length === 0
        ? state.lastText || text
        : text
      if (this.hasDetailRows(state, finalText)) {
        state.lastText = finalText
      }
      this.renderDetailRows(terminal, state, finalText)
    } catch (error) {
      if (this.detailModals.get(terminal) === state) {
        state.status.textContent = ''
        if (state.kind === 'latency' && state.lastText && this.hasDetailRows(state, state.lastText)) {
          this.renderDetailRows(terminal, state, state.lastText)
        } else {
          this.renderEmptyDetailRows(state)
        }
      }
    } finally {
      state.inflight = false
    }
  }

  private startDetailRefreshTimer (terminal: BaseTerminalTabComponent<any>, state: DetailModalState): void {
    if (state.timer !== undefined) {
      window.clearInterval(state.timer)
    }
    if (state.kind === 'latency') {
      return
    }
    const refresh = () => void this.refreshDetailModal(terminal)
    state.timer = window.setInterval(refresh, 1000)
  }

  private toggleDetailPause (terminal: BaseTerminalTabComponent<any>): void {
    const state = this.detailModals.get(terminal)
    if (!state) {
      return
    }
    state.paused = !state.paused
    state.pauseButton.title = state.paused ? '继续自动刷新' : '暂停自动刷新'
    state.pauseButton.setAttribute('aria-label', state.pauseButton.title)
    state.pauseButton.classList.toggle('tfs-detail-paused', state.paused)
    if (state.paused) {
      if (state.timer !== undefined) {
        window.clearInterval(state.timer)
        state.timer = undefined
      }
    } else {
      this.startDetailRefreshTimer(terminal, state)
      void this.refreshDetailModal(terminal)
    }
  }

  private getDetailTitle (kind: DetailKind): string {
    if (kind === 'process') {
      return '进程详情'
    }
    if (kind === 'network') {
      return '网络详情'
    }
    return '延迟详情'
  }

  private renderDetailShell (terminal: BaseTerminalTabComponent<any>, state: DetailModalState): void {
    const columns = this.getDetailColumns(state.kind)
    state.body.innerHTML = `
      <table class="tfs-detail-table" style="width:${this.getDetailColumnsWidth(columns)}px">
        <colgroup>${columns.map(column => `<col data-col="${column.key}" data-default-width="${column.width}" data-min-width="${column.minWidth}" data-max-width="${column.maxWidth}"${column.fill ? ' data-fill="1"' : ''} style="width:${column.width}px">`).join('')}</colgroup>
        <thead><tr>${columns.map(column => `<th class="tfs-resizable-col">${column.sortable ? `<button type="button" data-detail-sort="${column.key}">${this.escape(column.label)}</button>` : this.escape(column.label)}<span class="tfs-col-resizer" data-resize-col="${column.key}" title="拖动调整列宽"></span></th>`).join('')}</tr></thead>
        <tbody></tbody>
      </table>
    `
    this.renderEmptyDetailRows(state)

    for (const button of Array.from(state.body.querySelectorAll<HTMLButtonElement>('button[data-detail-sort]'))) {
      button.addEventListener('click', () => {
        const key = button.dataset.detailSort || ''
        const current = this.detailSort.get(terminal)
        const direction: DetailSortDirection = current?.key === key && current.direction === 'desc' ? 'asc' : 'desc'
        this.detailSort.set(terminal, { key, direction })
        void this.refreshDetailModal(terminal)
      })
    }
    this.bindDetailColumnResize(state)
    this.bindDetailContextMenu(terminal, state)
    this.fillDetailTableWidth(state)
  }

  private bindDetailContextMenu (terminal: BaseTerminalTabComponent<any>, state: DetailModalState): void {
    state.body.addEventListener('contextmenu', event => {
      if (state.kind !== 'process') {
        return
      }
      const row = (event.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-process-pid]')
      if (!row) {
        return
      }
      event.preventDefault()
      this.openProcessContextMenu(terminal, state, row, event.clientX, event.clientY)
    })
  }

  private openProcessContextMenu (terminal: BaseTerminalTabComponent<any>, state: DetailModalState, row: HTMLTableRowElement, x: number, y: number): void {
    this.closeContextMenu()
    const pid = row.dataset.processPid || ''
    const name = row.dataset.processName || ''
    const command = row.dataset.processCommand || ''
    const location = row.dataset.processLocation || ''
    const menu = document.createElement('div')
    menu.className = 'tfs-context-menu'
    this.applyCurrentThemeToOverlay(terminal, menu)
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`
    menu.innerHTML = `
      <button type="button" data-action="kill">终止进程</button>
      <button type="button" data-action="copy-pid">复制PID</button>
      <button type="button" data-action="copy-name">复制名称</button>
      <button type="button" data-action="copy-command">复制命令</button>
      <button type="button" data-action="copy-location">复制位置</button>
    `

    menu.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]')?.dataset.action
      if (!action) {
        return
      }
      if (action === 'kill') {
        void this.terminateProcess(terminal, state, pid)
      } else if (action === 'copy-pid') {
        void navigator.clipboard?.writeText(pid)
      } else if (action === 'copy-name') {
        void navigator.clipboard?.writeText(name)
      } else if (action === 'copy-command') {
        void navigator.clipboard?.writeText(command)
      } else if (action === 'copy-location') {
        void navigator.clipboard?.writeText(location)
      }
      this.closeContextMenu()
    })

    document.body.appendChild(menu)
    const rect = menu.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`
    }
    window.setTimeout(() => {
      const close = () => {
        this.closeContextMenu()
        document.removeEventListener('click', close)
      }
      document.addEventListener('click', close)
    })
  }

  private closeContextMenu (): void {
    for (const menu of Array.from(document.querySelectorAll('.tfs-context-menu'))) {
      menu.remove()
    }
  }

  private async terminateProcess (terminal: BaseTerminalTabComponent<any>, state: DetailModalState, pid: string): Promise<void> {
    if (!/^[0-9]+$/.test(pid)) {
      state.status.textContent = 'PID 无效'
      return
    }
    const sshSession = (terminal as any).sshSession ?? (terminal.session as any)?.ssh
    const ssh = sshSession?.ssh
    if (!ssh?.openSessionChannel || !ssh?.activateChannel) {
      state.status.textContent = '等待 SSH'
      return
    }
    try {
      await this.runSshExec(ssh, this.encodeShellScript(`kill -TERM ${pid}`))
      state.status.textContent = `已终止 PID ${pid}`
      void this.refreshDetailModal(terminal)
    } catch (error) {
      state.status.textContent = `终止失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  private bindDetailColumnResize (state: DetailModalState): void {
    for (const handle of Array.from(state.body.querySelectorAll<HTMLElement>('.tfs-col-resizer[data-resize-col]'))) {
      handle.addEventListener('mousedown', event => {
        event.preventDefault()
        event.stopPropagation()
        const key = handle.dataset.resizeCol
        const col = key ? state.body.querySelector<HTMLTableColElement>(`col[data-col="${key}"]`) : null
        if (!col) {
          return
        }
        const startX = event.clientX
        const startWidth = col.getBoundingClientRect().width || Number(col.style.width.replace('px', '')) || 220
        const minWidth = Number(col.dataset.minWidth || 64)
        const maxWidth = Number(col.dataset.maxWidth || 720)
        const move = (moveEvent: MouseEvent) => {
          const width = Math.max(minWidth, Math.min(maxWidth, Math.round(startWidth + moveEvent.clientX - startX)))
          col.style.width = `${width}px`
          this.updateDetailTableWidth(state)
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          document.body.classList.remove('tfs-col-resizing')
        }
        document.body.classList.add('tfs-col-resizing')
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      })
      handle.addEventListener('dblclick', event => {
        event.preventDefault()
        event.stopPropagation()
        const key = handle.dataset.resizeCol
        const col = key ? state.body.querySelector<HTMLTableColElement>(`col[data-col="${key}"]`) : null
        const width = Number(col?.dataset.defaultWidth || 0)
        if (col && width > 0) {
          col.style.width = `${width}px`
          this.updateDetailTableWidth(state)
        }
      })
    }
  }

  private updateDetailTableWidth (state: DetailModalState): void {
    const table = state.body.querySelector<HTMLTableElement>('.tfs-detail-table')
    const cols = Array.from(state.body.querySelectorAll<HTMLTableColElement>('col[data-col]'))
    if (!table || cols.length === 0) {
      return
    }

    const width = this.getCurrentDetailColumnsWidth(cols)
    table.style.width = `${Math.round(width)}px`
  }

  private fillDetailTableWidth (state: DetailModalState): void {
    const table = state.body.querySelector<HTMLTableElement>('.tfs-detail-table')
    const cols = Array.from(state.body.querySelectorAll<HTMLTableColElement>('col[data-col]'))
    if (!table || cols.length === 0) {
      return
    }

    let width = this.getCurrentDetailColumnsWidth(cols)
    const targetWidth = state.body.clientWidth
    const extra = targetWidth - width
    if (extra > 0) {
      const fillCols = cols.filter(col => col.dataset.fill === '1')
      if (fillCols.length > 0) {
        const perCol = extra / fillCols.length
        for (const col of fillCols) {
          const current = Number(col.style.width.replace('px', '')) || Number(col.dataset.defaultWidth || 0)
          const maxWidth = Number(col.dataset.maxWidth || 1200)
          const next = Math.min(maxWidth, current + perCol)
          col.style.width = `${Math.round(next)}px`
        }
      }
      width = this.getCurrentDetailColumnsWidth(cols)
    }
    table.style.width = `${Math.round(width)}px`
  }

  private getDetailColumnsWidth (columns: DetailColumn[]): number {
    return columns.reduce((total, column) => total + column.width, 0)
  }

  private getCurrentDetailColumnsWidth (cols: HTMLTableColElement[]): number {
    return cols.reduce((total, col) => total + (Number(col.style.width.replace('px', '')) || Number(col.dataset.defaultWidth || 0)), 0)
  }

  private getDetailColumns (kind: DetailKind): DetailColumn[] {
    if (kind === 'process') {
      return [
        { key: 'pid', label: 'PID', sortable: true, width: 88, minWidth: 64, maxWidth: 180 },
        { key: 'user', label: '用户', sortable: true, width: 104, minWidth: 72, maxWidth: 220 },
        { key: 'mem', label: '内存', sortable: true, width: 84, minWidth: 64, maxWidth: 160 },
        { key: 'cpu', label: 'CPU', sortable: true, width: 84, minWidth: 64, maxWidth: 160 },
        { key: 'command', label: '命令', sortable: false, width: 340, minWidth: 160, maxWidth: 1200, fill: true },
        { key: 'location', label: '位置', sortable: false, width: 360, minWidth: 160, maxWidth: 1200, fill: true },
      ]
    }
    if (kind === 'network') {
      return [
        { key: 'pid', label: 'PID', sortable: true, width: 82, minWidth: 64, maxWidth: 180 },
        { key: 'name', label: '名称', sortable: true, width: 130, minWidth: 90, maxWidth: 720, fill: true },
        { key: 'listenIp', label: '监听IP', sortable: true, width: 150, minWidth: 100, maxWidth: 720, fill: true },
        { key: 'port', label: '端口', sortable: true, width: 82, minWidth: 64, maxWidth: 140 },
        { key: 'ipCount', label: 'IP数', sortable: true, width: 76, minWidth: 64, maxWidth: 140 },
        { key: 'connCount', label: '连接数', sortable: true, width: 86, minWidth: 70, maxWidth: 160 },
        { key: 'upload', label: '上传', sortable: true, width: 92, minWidth: 76, maxWidth: 180 },
        { key: 'download', label: '下载', sortable: true, width: 92, minWidth: 76, maxWidth: 180 },
      ]
    }
    return [
      { key: 'hop', label: '跳数', sortable: false, width: 70, minWidth: 56, maxWidth: 110 },
      { key: 'ip', label: 'IP', sortable: false, width: 160, minWidth: 120, maxWidth: 420 },
      { key: 'ptr', label: 'PTR', sortable: false, width: 220, minWidth: 140, maxWidth: 720, fill: true },
      { key: 'location', label: '地理位置 / 仅供参考', sortable: false, width: 180, minWidth: 140, maxWidth: 520, fill: true },
      { key: 'asn', label: 'AS', sortable: false, width: 92, minWidth: 72, maxWidth: 160 },
      { key: 'loss', label: '丢包率', sortable: false, width: 92, minWidth: 76, maxWidth: 150 },
      { key: 'sent', label: '发包', sortable: false, width: 76, minWidth: 64, maxWidth: 120 },
      { key: 'last', label: '最新(ms)', sortable: false, width: 96, minWidth: 80, maxWidth: 150 },
      { key: 'best', label: '最快(ms)', sortable: false, width: 96, minWidth: 80, maxWidth: 150 },
      { key: 'worst', label: '最慢(ms)', sortable: false, width: 96, minWidth: 80, maxWidth: 150 },
      { key: 'avg', label: '平均(ms)', sortable: false, width: 96, minWidth: 80, maxWidth: 150 },
    ]
  }

  private detailCollectorExecCommand (terminal: BaseTerminalTabComponent<any>, kind: DetailKind): string {
    if (kind === 'process') {
      return this.processDetailCollectorExecCommand()
    }
    if (kind === 'network') {
      return this.networkDetailCollectorExecCommand()
    }
    return this.latencyDetailCollectorExecCommand(this.getLatencyTraceTarget(terminal))
  }

  private async collectLatencyDetails (terminal: BaseTerminalTabComponent<any>, ssh: any, onText?: (text: string) => void): Promise<string> {
    const target = this.getLatencyTraceTarget(terminal)
    if (target !== this.defaultLatencyTraceTarget()) {
      try {
        const local = await this.collectLocalLatencyDetails(target, (_chunkText, stdout) => {
          if (this.parseLatencyDetails(stdout).length > 0) {
            onText?.(stdout)
          }
        })
        if (this.parseLatencyDetails(local).length > 0) {
          return local
        }
      } catch (error) {
        console.warn('[tabby-status] local traceroute failed', error)
      }
      return ''
    }
    if (!ssh?.openSessionChannel || !ssh?.activateChannel) {
      throw new Error('等待 SSH')
    }
    return this.runSshExec(ssh, this.latencyDetailCollectorExecCommand(target), 30000)
  }

  private async collectLocalLatencyDetails (target: string, onStdout?: (chunkText: string, stdout: string) => void): Promise<string> {
    if (this.getLocalPlatform() === 'win32') {
      return this.runLocalCommandStream('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', this.windowsLatencyDetailScript(target)], 45000, onStdout)
    }
    return this.runLocalCommandStream('/bin/sh', ['-lc', this.localLatencyDetailScript(target)], 45000, onStdout)
  }

  private getLocalPlatform (): string {
    try {
      const requireFn = typeof __non_webpack_require__ === 'function' ? __non_webpack_require__ : (globalThis as any).require
      return String(requireFn?.('os')?.platform?.() || (globalThis as any).process?.platform || '')
    } catch {
      return String((globalThis as any).process?.platform || '')
    }
  }

  private windowsLatencyDetailScript (target: string): string {
    const safeTarget = this.powershellQuote(this.isTraceTarget(target) ? target : this.defaultLatencyTraceTarget())
    return [
      `$target = ${safeTarget}`,
      '$tab = [char]9',
      'function Test-PrivateIp {',
      '  param([string]$Ip)',
      '  if (-not $Ip) { return $false }',
      "  if ($Ip -match '^(10\\.|127\\.|169\\.254\\.|192\\.168\\.)') { return $true }",
      "  if ($Ip -match '^172\\.(1[6-9]|2[0-9]|3[0-1])\\.') { return $true }",
      '  return $false',
      '}',
      'function Write-RouteRow {',
      '  param(',
      '    [string]$Hop,',
      '    [string]$Ip,',
      '    [string]$Loss,',
      '    [string]$Sent,',
      '    [string]$Last,',
      '    [string]$Best,',
      '    [string]$Worst,',
      '    [string]$Avg',
      '  )',
      "  if (-not $Ip -or $Ip -eq '*') { $Ip = '--' }",
      "  if (-not $Loss) { $Loss = '--' }",
      "  if (-not $Sent) { $Sent = '--' }",
      "  if (-not $Last) { $Last = '--' }",
      "  if (-not $Best) { $Best = '--' }",
      "  if (-not $Worst) { $Worst = '--' }",
      "  if (-not $Avg) { $Avg = '--' }",
      "  $location = '--'",
      "  if (Test-PrivateIp $Ip) { $location = '局域网' }",
      "  [Console]::Out.WriteLine((@('ldetail', $Hop, $Ip, '--', $location, '--', $Loss, $Sent, $Last, $Best, $Worst, $Avg) -join $tab))",
      '  [Console]::Out.Flush()',
      '}',
      '$lines = & tracert.exe -d -h 30 -w 1000 $target 2>$null',
      'foreach ($line in $lines) {',
      "  if ($line -notmatch '^\\s*(\\d+)\\s+(.+)$') { continue }",
      '  $hop = $Matches[1]',
      '  $body = $Matches[2].Trim()',
      "  $ip = '--'",
      "  $ipMatches = [regex]::Matches($body, '(?i)(?:\\d{1,3}\\.){3}\\d{1,3}|(?:[0-9a-f]{1,4}:){1,}[0-9a-f:]*')",
      '  if ($ipMatches.Count -gt 0) {',
      '    $ip = $ipMatches[$ipMatches.Count - 1].Value',
      '  }',
      "  $timeMatches = [regex]::Matches($body, '(<\\s*1|\\d+)\\s*(?:ms|毫秒)')",
      '  $sent = 3',
      '  $received = $timeMatches.Count',
      '  if ($received -le 0) {',
      "    Write-RouteRow $hop $ip '100%' $sent '*' '--' '--' '--'",
      '    continue',
      '  }',
      '  $values = @()',
      '  $labels = @()',
      '  foreach ($match in $timeMatches) {',
      "    $raw = $match.Groups[1].Value -replace '\\s+', ''",
      "    if ($raw.StartsWith('<')) {",
      '      $values += 1',
      "      $labels += '<1'",
      '    } else {',
      '      $values += [int]$raw',
      '      $labels += ([string][int]$raw)',
      '    }',
      '  }',
      '  $last = $labels[$labels.Count - 1]',
      '  $bestValue = ($values | Measure-Object -Minimum).Minimum',
      '  $worstValue = ($values | Measure-Object -Maximum).Maximum',
      '  $avgValue = [math]::Round((($values | Measure-Object -Average).Average))',
      "  $best = if ($bestValue -le 1 -and ($labels -contains '<1')) { '<1' } else { [string][int]$bestValue }",
      '  $worst = [string][int]$worstValue',
      '  $avg = [string][int]$avgValue',
      "  $loss = ('{0}%' -f [math]::Round((($sent - $received) * 100) / $sent))",
      '  Write-RouteRow $hop $ip $loss $sent $last $best $worst $avg',
      '}',
    ].join('\n')
  }

  private hasDetailRows (state: DetailModalState, text: string): boolean {
    if (state.kind === 'process') {
      return this.parseProcessDetails(text).length > 0
    }
    if (state.kind === 'network') {
      return this.parseNetworkDetails(text).length > 0
    }
    return this.parseLatencyDetails(text).length > 0
  }

  private async runLocalCommandStream (app: string, argv: string[], timeoutMs = 8000, onStdout?: (chunkText: string, stdout: string) => void): Promise<string> {
    const requireFn = typeof __non_webpack_require__ === 'function' ? __non_webpack_require__ : (globalThis as any).require
    if (!requireFn) {
      throw new Error('local command API unavailable')
    }
    const childProcess = requireFn('child_process')
    return new Promise<string>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const child = childProcess.spawn(app, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
      const timeout = window.setTimeout(() => {
        child.kill?.()
        if (stdout.trim()) {
          resolve(stdout)
        } else {
          reject(new Error('timeout'))
        }
      }, timeoutMs)
      child.stdout?.on('data', (data: Buffer | string) => {
        const chunkText = String(data)
        stdout += chunkText
        if (onStdout) {
          onStdout(chunkText, stdout)
        }
      })
      child.stderr?.on('data', (data: Buffer | string) => {
        stderr += String(data)
      })
      child.on('error', (error: Error) => {
        window.clearTimeout(timeout)
        reject(error)
      })
      child.on('close', () => {
        window.clearTimeout(timeout)
        if (!stdout.trim() && stderr.trim()) {
          reject(new Error(stderr.trim().slice(0, 120)))
          return
        }
        resolve(stdout)
      })
    })
  }

  private async runLocalCommand (app: string, argv: string[], timeoutMs = 8000): Promise<string> {
    const requireFn = typeof __non_webpack_require__ === 'function' ? __non_webpack_require__ : (globalThis as any).require
    if (!requireFn) {
      throw new Error('local command API unavailable')
    }
    const childProcess = requireFn('child_process')
    return new Promise<string>((resolve, reject) => {
      const child = childProcess.execFile(app, argv, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error: Error | null, stdout: string, stderr: string) => {
        if (error && !stdout) {
          reject(new Error(stderr?.trim() || error.message))
          return
        }
        resolve(stdout || '')
      })
      child.on?.('error', reject)
    })
  }

  private getLatencyTraceTarget (terminal: BaseTerminalTabComponent<any>): string {
    const sources = [
      (terminal as any).profile?.options,
      (terminal as any).profile,
      (terminal as any).sshSession,
      (terminal.session as any)?.ssh,
      terminal.session,
    ]
    const keys = ['host', 'hostname', 'address', 'destination', 'target']
    for (const source of sources) {
      if (!source || typeof source !== 'object') {
        continue
      }
      for (const key of keys) {
        const value = source[key]
        if (this.isTraceTarget(value)) {
          return String(value).trim()
        }
      }
    }
    const current = this.state.get(terminal) ?? {}
    for (const value of [current.publicIp, current.ip, current.localIp]) {
      if (this.isTraceTarget(value)) {
        return String(value).trim()
      }
    }
    return this.defaultLatencyTraceTarget()
  }

  private defaultLatencyTraceTarget (): string {
    return '1.1.1.1'
  }

  private isTraceTarget (value: unknown): boolean {
    if (typeof value !== 'string') {
      return false
    }
    const target = value.trim()
    if (!target || target.includes('\n') || target.includes('\r') || target.startsWith('-')) {
      return false
    }
    return /^[A-Za-z0-9.:-]+$/.test(target)
  }

  private processDetailCollectorExecCommand (): string {
    const script = String.raw`os=$(uname -s 2>/dev/null)
if [ "$os" = "Darwin" ]; then
  ps axo pid,user,pmem,pcpu,command -r 2>/dev/null | awk 'NR>1{cmd=$5; for(i=6;i<=NF;i++) cmd=cmd" "$i; printf "pdetail\t%s\t%s\t%s\t%s\t%s\t-\n",$1,$2,$3,$4,cmd; count++; if(count>=80) exit}'
else
  ps -eo pid,user,pmem,pcpu,args --sort=-pcpu 2>/dev/null | awk 'NR>1{cmd=$5; for(i=6;i<=NF;i++) cmd=cmd" "$i; printf "%s\t%s\t%s\t%s\t%s\n",$1,$2,$3,$4,cmd; count++; if(count>=80) exit}' | while IFS="$(printf '\t')" read -r pid user mem cpu cmd; do
    loc=$(readlink "/proc/$pid/cwd" 2>/dev/null || readlink "/proc/$pid/exe" 2>/dev/null || printf "-")
    printf "pdetail\t%s\t%s\t%s\t%s\t%s\t%s\n" "$pid" "$user" "$mem" "$cpu" "$cmd" "$loc"
  done
fi
`
    return this.encodeShellScript(script)
  }

  private networkDetailCollectorExecCommand (): string {
    const script = String.raw`if command -v ss >/dev/null 2>&1; then
  ss -H -tunapi 2>/dev/null | awk '
  /^[[:space:]]/ { record=record " " $0; next }
  { if (record!="") print record; record=$0 }
  END { if (record!="") print record }
  ' | awk '
  function strip_addr(value, result, n) {
    gsub(/^\[/, "", value); gsub(/\]$/, "", value)
    n=split(value, result, ":")
    return n > 1 ? result[n] : "-"
  }
  function host_part(value) {
    gsub(/^\[/, "", value); gsub(/\]$/, "", value)
    sub(/:[^:]*$/, "", value)
    return value == "" ? "*" : value
  }
  {
    if ($1 !~ /^(tcp|udp|raw|u_str|icmp)/ && NF < 5) next
    local=$5; peer=$6; pid="-"; name="-"
    if (match($0, /pid=[0-9]+/)) { pid=substr($0, RSTART+4, RLENGTH-4) }
    if (match($0, /\("[^"]+"/)) { name=substr($0, RSTART+2, RLENGTH-3) }
    port=strip_addr(local)
    listen=host_part(local)
    key=pid "|" name "|" listen "|" port
    conn[key]++
    sent=0; received=0
    if (match($0, /bytes_sent:[0-9]+/)) sent=substr($0, RSTART+11, RLENGTH-11)
    if (match($0, /bytes_received:[0-9]+/)) received=substr($0, RSTART+15, RLENGTH-15)
    upload[key]+=sent
    download[key]+=received
    if (peer != "*:*" && peer != "-") {
      remote=host_part(peer)
      if (remote != "*" && remote != "") {
        seen=key "|" remote
        if (!remoteSeen[seen]++) ipCount[key]++
      }
    }
    meta[key]=pid "\t" name "\t" listen "\t" port
  }
  END {
    for (key in conn) {
      printf "ndetail\t%s\t%s\t%s\t%s\t%s\n", meta[key], ipCount[key]+0, conn[key]+0, upload[key]+0, download[key]+0
    }
  }' | sort -t "$(printf '\t')" -k7,7nr | head -120
else
  netstat -tunap 2>/dev/null | awk 'NR>2{print "ndetail\t-\t-\t-\t-\t0\t0\t0\t0"}' | head -1
fi
`
    return this.encodeShellScript(script)
  }

  private localLatencyDetailScript (target: string): string {
    const safeTarget = this.shellQuote(this.isTraceTarget(target) ? target : this.defaultLatencyTraceTarget())
    return String.raw`target=__TABBY_STATUS_TRACE_TARGET__
is_private_ip() {
  case "$1" in
    10.*|127.*|169.254.*|192.168.*) return 0 ;;
    172.16.*|172.17.*|172.18.*|172.19.*|172.20.*|172.21.*|172.22.*|172.23.*|172.24.*|172.25.*|172.26.*|172.27.*|172.28.*|172.29.*|172.30.*|172.31.*) return 0 ;;
    *) return 1 ;;
  esac
}
geo_lookup() {
  ip="$1"
  case "$ip" in ""|"-"|"*"|"--") printf -- "--\t--"; return ;; esac
  if is_private_ip "$ip"; then
    printf "局域网\t--"
    return
  fi
  location="--"; asn="--"
  if command -v curl >/dev/null 2>&1; then
    geo=$(curl -4 -fsS --connect-timeout 1 --max-time 1 "http://ip-api.com/line/$ip?fields=status,country,regionName,city,isp,as&lang=zh-CN" 2>/dev/null || true)
    if [ -n "$geo" ] && [ "$(printf "%s\n" "$geo" | awk 'NR==1{print}')" = "success" ]; then
      country=$(printf "%s\n" "$geo" | awk 'NR==2{print}')
      region=$(printf "%s\n" "$geo" | awk 'NR==3{print}')
      city=$(printf "%s\n" "$geo" | awk 'NR==4{print}')
      isp=$(printf "%s\n" "$geo" | awk 'NR==5{print}')
      asline=$(printf "%s\n" "$geo" | awk 'NR==6{print}')
      location=$(printf "%s/%s/%s/%s" "$country" "$region" "$city" "$isp" | awk '{gsub(/\/+/, "/"); gsub(/^\/|\/$/, ""); if($0=="") print "--"; else print $0}')
      asn=$(printf "%s" "$asline" | awk '{print $1}')
      [ -z "$asn" ] && asn="--"
    fi
  fi
  printf "%s\t%s" "$location" "$asn"
}
ptr_lookup() {
  ip="$1"
  case "$ip" in ""|"-"|"*"|"--") printf -- "--"; return ;; esac
  if command -v getent >/dev/null 2>&1; then
    ptr=$(getent hosts "$ip" 2>/dev/null | awk '{print $2; exit}')
    [ -n "$ptr" ] && { printf "%s" "$ptr"; return; }
  fi
  if command -v nslookup >/dev/null 2>&1; then
    ptr=$(nslookup "$ip" 2>/dev/null | awk -F'= ' '/name =/{gsub(/\.$/,"",$2); print $2; exit}')
    [ -n "$ptr" ] && { printf "%s" "$ptr"; return; }
  fi
  printf -- "--"
}
emit_fast_row() {
  hop="$1"; ip="$2"; loss="$3"; sent="$4"; last="$5"; best="$6"; worst="$7"; avg="$8"
  location="--"; asn="--"
  if is_private_ip "$ip"; then
    location="局域网"
  fi
  [ -z "$ip" ] && ip="--"
  [ -z "$loss" ] && loss="--"
  [ -z "$sent" ] && sent="--"
  [ -z "$last" ] && last="--"
  [ -z "$best" ] && best="--"
  [ -z "$worst" ] && worst="--"
  [ -z "$avg" ] && avg="--"
  printf "ldetail\t%s\t%s\t--\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$hop" "$ip" "$location" "$asn" "$loss" "$sent" "$last" "$best" "$worst" "$avg"
}
emit_geo_row() {
  hop="$1"; ip="$2"; loss="$3"; sent="$4"; last="$5"; best="$6"; worst="$7"; avg="$8"
  geo=$(geo_lookup "$ip")
  ptr=$(ptr_lookup "$ip")
  location=$(printf "%s" "$geo" | awk -F '\t' '{print $1}')
  asn=$(printf "%s" "$geo" | awk -F '\t' '{print $2}')
  [ -z "$ip" ] && ip="--"
  [ -z "$ptr" ] && ptr="--"
  [ -z "$location" ] && location="--"
  [ -z "$asn" ] && asn="--"
  printf "ldetail\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$hop" "$ip" "$ptr" "$location" "$asn" "$loss" "$sent" "$last" "$best" "$worst" "$avg"
}
emit_row() {
  emit_fast_row "$@"
  emit_geo_row "$@" &
}
parse_traceroute() {
  awk '{
    hop=$1; ip=$2
    if(hop !~ /^[0-9]+$/) next
    sent=1
    if(ip=="*"||ip=="") {printf "%s\t--\t100%%\t1\t*\t--\t--\t--\n", hop; next}
    count=0; sum=0; best=""; worst=""; last="*"
    for(i=3;i<=NF;i++){
      if($i ~ /^[0-9.]+$/ && $(i+1)=="ms"){
        v=$i+0; count++; sum+=v; last=sprintf("%.0f", v)
        if(best==""||v<best) best=v
        if(worst==""||v>worst) worst=v
      }
    }
    loss=sprintf("%.0f%%", (sent-count)*100/sent)
    avg=count?sprintf("%.0f", sum/count):"--"
    best=count?sprintf("%.0f", best):"--"
    worst=count?sprintf("%.0f", worst):"--"
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", hop, ip, loss, sent, last, best, worst, avg
    fflush()
  }'
}
score_rows() {
  awk -F '\t' 'NF>=2{rows++; if($2!="--") valid++} END{printf "%s\t%s", valid+0, rows+0}'
}
emit_direct_target() {
  printf "%s\n" "$best_direct" | awk -F '\t' 'BEGIN{OFS="\t"} NF>=8{$1="目标"; print; exit}'
}
target_seen_in_rows() {
  rows="$1"
  case "$target" in
    *[!0-9.]*|"") return 1 ;;
  esac
  printf "%s\n" "$rows" | awk -F '\t' -v target="$target" '$2==target{found=1} END{exit found?0:1}'
}
probe_target_direct() {
  [ -z "$direct_src" ] && return
  os=$(uname -s 2>/dev/null)
  if [ "$os" = "Darwin" ]; then
    ping -S "$direct_src" -c 1 -W 1000 "$target" 2>/dev/null | awk '
      /bytes from/ {
        ip=$4; gsub(/:$/,"",ip)
        for(i=1;i<=NF;i++){
          if($i ~ /^time[=<]/){
            value=$i
            sub(/^time[=<]/, "", value)
            sub(/ms$/, "", value)
            if($i ~ /^time</) last="<1"; else last=sprintf("%.0f", value+0)
          }
        }
      }
      END {
        if(ip!="" && last!="") printf "目标\t%s\t0%%\t1\t%s\t%s\t%s\t%s\n", ip, last, last, last, last
      }'
  else
    ping -I "$direct_src" -c 1 -W 1 "$target" 2>/dev/null | awk '
      /bytes from/ {
        ip=$4; gsub(/:$/,"",ip)
        for(i=1;i<=NF;i++){
          if($i ~ /^time[=<]/){
            value=$i
            sub(/^time[=<]/, "", value)
            sub(/ms$/, "", value)
            if($i ~ /^time</) last="<1"; else last=sprintf("%.0f", value+0)
          }
        }
      }
      END {
        if(ip!="" && last!="") printf "目标\t%s\t0%%\t1\t%s\t%s\t%s\t%s\n", ip, last, last, last, last
      }'
  fi
}
emit_raw_rows() {
  while IFS="$(printf '\t')" read -r hop ip loss sent last best worst avg; do
    [ -z "$hop" ] && continue
    emit_row "$hop" "$ip" "$loss" "$sent" "$last" "$best" "$worst" "$avg"
  done
}
get_current_route_iface() {
  if command -v route >/dev/null 2>&1; then
    route -n get "$target" 2>/dev/null | awk '/interface:/{print $2; exit}'
  fi
}
get_iface_ipv4() {
  iface="$1"
  [ -z "$iface" ] && return
  if command -v ip >/dev/null 2>&1; then
    ip -o -4 addr show dev "$iface" 2>/dev/null | awk '{split($4,a,"/"); print a[1]; exit}'
    return
  fi
  if command -v ifconfig >/dev/null 2>&1; then
    ifconfig "$iface" 2>/dev/null | awk '/inet /{print $2; exit}'
  fi
}
is_tun_iface() {
  case "$1" in
    utun*|tun*|tap*|wg*|tailscale*|zt*|gif*|stf*|lo*) return 0 ;;
    *) return 1 ;;
  esac
}
get_direct_route() {
  current_iface=$(get_current_route_iface)
  if [ -n "$current_iface" ] && ! is_tun_iface "$current_iface"; then
    current_src=$(get_iface_ipv4 "$current_iface")
    [ -n "$current_src" ] && { printf "%s\t%s" "$current_iface" "$current_src"; return; }
  fi
  if command -v netstat >/dev/null 2>&1; then
    direct_iface=$(netstat -rn -f inet 2>/dev/null | awk '$1=="default" && $NF !~ /^(utun|tun|tap|wg|tailscale|zt|gif|stf|lo)/ {print $NF; exit}')
    direct_src=$(get_iface_ipv4 "$direct_iface")
    [ -n "$direct_iface" ] && [ -n "$direct_src" ] && { printf "%s\t%s" "$direct_iface" "$direct_src"; return; }
  fi
}
choose_trace() {
  best=""
  best_valid=-1
  best_rows=0
  best_direct=""
  run_candidate() {
    rows="$("$@" 2>/dev/null | parse_traceroute)"
    [ -z "$rows" ] && return
    score=$(printf "%s\n" "$rows" | score_rows)
    valid=$(printf "%s" "$score" | awk -F '\t' '{print $1+0}')
    count=$(printf "%s" "$score" | awk -F '\t' '{print $2+0}')
    if [ "$count" -le 1 ]; then
      [ -z "$best_direct" ] && [ "$valid" -gt 0 ] && best_direct="$rows"
      return
    fi
    if [ "$valid" -gt "$best_valid" ] || { [ "$valid" -eq "$best_valid" ] && [ "$count" -gt "$best_rows" ]; }; then
      best="$rows"
      best_valid="$valid"
      best_rows="$count"
    fi
  }
  emit_best_if_route_shaped() {
    if [ "$best_rows" -gt 1 ] && [ "$best_valid" -gt 0 ]; then
      printf "%s\n" "$best" | emit_raw_rows
      if ! target_seen_in_rows "$best"; then
        probe_target_direct | emit_raw_rows
      fi
      wait
      return 0
    fi
    return 1
  }
  run_direct_stream() {
    tmpdir="$TMPDIR"
    [ -z "$tmpdir" ] && tmpdir="/tmp"
    tmp="$tmpdir/tabby-status-trace-$$-$RANDOM.tsv"
    "$@" 2>/dev/null | parse_traceroute | while IFS="$(printf '\t')" read -r hop ip loss sent last best worst avg; do
      [ -z "$hop" ] && continue
      printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$hop" "$ip" "$loss" "$sent" "$last" "$best" "$worst" "$avg" >> "$tmp"
      emit_row "$hop" "$ip" "$loss" "$sent" "$last" "$best" "$worst" "$avg"
    done
    rows=$(cat "$tmp" 2>/dev/null)
    rm -f "$tmp" 2>/dev/null
    [ -z "$rows" ] && return 1
    score=$(printf "%s\n" "$rows" | score_rows)
    valid=$(printf "%s" "$score" | awk -F '\t' '{print $1+0}')
    count=$(printf "%s" "$score" | awk -F '\t' '{print $2+0}')
    if [ "$count" -gt 1 ] && [ "$valid" -gt 0 ]; then
      if ! target_seen_in_rows "$rows"; then
        probe_target_direct | emit_raw_rows
      fi
      wait
      return 0
    fi
    wait
    return 1
  }
  if command -v traceroute >/dev/null 2>&1; then
    direct_route=$(get_direct_route)
    direct_iface=$(printf "%s" "$direct_route" | awk -F '\t' '{print $1}')
    direct_src=$(printf "%s" "$direct_route" | awk -F '\t' '{print $2}')
    if [ -n "$direct_iface" ] && [ -n "$direct_src" ]; then
      run_direct_stream traceroute -I -i "$direct_iface" -s "$direct_src" -n -w 1 -q 1 -m 30 "$target" && return
      run_direct_stream traceroute -i "$direct_iface" -s "$direct_src" -n -w 1 -q 1 -m 30 "$target" && return
    fi
    run_candidate traceroute -I -n -w 1 -q 1 -m 12 "$target"
    run_candidate traceroute -T -p 22 -n -w 1 -q 1 -m 12 "$target"
    run_candidate traceroute -P TCP -p 22 -n -w 1 -q 1 -m 12 "$target"
    run_candidate traceroute -n -w 1 -q 1 -m 12 "$target"
  fi
  if [ "$best_rows" -gt 1 ]; then
    printf "%s\n" "$best" | emit_raw_rows
    if [ "$best_valid" -eq 0 ] && [ -n "$best_direct" ]; then
      emit_direct_target | emit_raw_rows
    fi
  else
    printf "%s\n" "$best_direct" | emit_raw_rows
  fi
  wait
}
if command -v traceroute >/dev/null 2>&1; then
  choose_trace
elif command -v tracepath >/dev/null 2>&1; then
  tracepath -n -m 12 "$target" 2>/dev/null | awk '{
    hop=$1; ip=$2
    if(hop ~ /^[0-9]+:/){
      gsub(":","",hop)
      if(ip=="no" || ip=="") ip="--"
      printf "%s\t%s\t--\t--\t--\t--\t--\t--\n", hop, ip
    }
  }' | emit_raw_rows
  wait
fi
`.replace('__TABBY_STATUS_TRACE_TARGET__', safeTarget)
  }

  private latencyDetailCollectorExecCommand (target: string): string {
    const safeTarget = this.shellQuote(this.isTraceTarget(target) ? target : this.defaultLatencyTraceTarget())
    const script = String.raw`target=__TABBY_STATUS_TRACE_TARGET__
resolve_target_ip() {
  value="$1"
  case "$value" in
    *[!0-9.]*|"") ;;
    *.*) printf "%s" "$value"; return ;;
  esac
  if command -v getent >/dev/null 2>&1; then
    resolved=$(getent ahostsv4 "$value" 2>/dev/null | awk '{print $1; exit}')
    [ -n "$resolved" ] && { printf "%s" "$resolved"; return; }
  fi
  if command -v nslookup >/dev/null 2>&1; then
    resolved=$(nslookup "$value" 2>/dev/null | awk '/^Address: /{print $2; exit}')
    [ -n "$resolved" ] && { printf "%s" "$resolved"; return; }
  fi
  printf "%s" "$value"
}
target_ip=$(resolve_target_ip "$target")
ptr_lookup() {
  ip="$1"
  case "$ip" in ""|"-"|"*"|"--") printf -- "--"; return ;; esac
  if command -v getent >/dev/null 2>&1; then
    ptr=$(getent hosts "$ip" 2>/dev/null | awk '{print $2; exit}')
    [ -n "$ptr" ] && { printf "%s" "$ptr"; return; }
  fi
  if command -v nslookup >/dev/null 2>&1; then
    ptr=$(nslookup "$ip" 2>/dev/null | awk -F'= ' '/name =/{gsub(/\.$/,"",$2); print $2; exit}')
    [ -n "$ptr" ] && { printf "%s" "$ptr"; return; }
  fi
  printf -- "--"
}
is_private_ip() {
  case "$1" in
    10.*|127.*|169.254.*|192.168.*) return 0 ;;
    172.16.*|172.17.*|172.18.*|172.19.*|172.20.*|172.21.*|172.22.*|172.23.*|172.24.*|172.25.*|172.26.*|172.27.*|172.28.*|172.29.*|172.30.*|172.31.*) return 0 ;;
    *) return 1 ;;
  esac
}
geo_lookup() {
  ip="$1"
  case "$ip" in ""|"-"|"*"|"--") printf -- "--\t--"; return ;; esac
  if is_private_ip "$ip"; then
    printf "局域网\t--"
    return
  fi

  tmpdir="$TMPDIR"
  [ -z "$tmpdir" ] && tmpdir="/tmp"
  cache="$tmpdir/tabby-status-ipgeo.tsv"
  if [ -r "$cache" ]; then
    cached=$(awk -F '\t' -v ip="$ip" '$1==ip{print $2 "\t" $3; exit}' "$cache" 2>/dev/null)
    if [ -n "$cached" ]; then
      printf "%s" "$cached"
      return
    fi
  fi

  location="--"; asn="--"
  if command -v curl >/dev/null 2>&1; then
    geo=$(curl -4 -fsS --connect-timeout 1 --max-time 1 "http://ip-api.com/line/$ip?fields=status,country,regionName,city,isp,as&lang=zh-CN" 2>/dev/null || true)
    if [ -n "$geo" ]; then
      status=$(printf "%s\n" "$geo" | awk 'NR==1{print}')
      if [ "$status" = "success" ]; then
        country=$(printf "%s\n" "$geo" | awk 'NR==2{print}')
        region=$(printf "%s\n" "$geo" | awk 'NR==3{print}')
        city=$(printf "%s\n" "$geo" | awk 'NR==4{print}')
        isp=$(printf "%s\n" "$geo" | awk 'NR==5{print}')
        asline=$(printf "%s\n" "$geo" | awk 'NR==6{print}')
        location=$(printf "%s/%s/%s/%s" "$country" "$region" "$city" "$isp" | awk '{gsub(/\/+/, "/"); gsub(/^\/|\/$/, ""); if($0=="") print "--"; else print $0}')
        asn=$(printf "%s" "$asline" | awk '{print $1}')
        [ -z "$asn" ] && asn="--"
      fi
    fi
  fi
  printf "%s\t%s" "$location" "$asn"
  [ "$location" = "--" ] && [ "$asn" = "--" ] || { mkdir -p "$(dirname "$cache")" 2>/dev/null; printf "%s\t%s\t%s\n" "$ip" "$location" "$asn" >> "$cache" 2>/dev/null; }
}
emit_row() {
  hop="$1"; ip="$2"; loss="$3"; sent="$4"; last="$5"; best="$6"; worst="$7"; avg="$8"
  [ -z "$ip" ] && ip="--"
  [ "$ip" = "???" ] && ip="--"
  [ "$ip" = "*" ] && ptr="--" || ptr=$(ptr_lookup "$ip")
  geo=$(geo_lookup "$ip")
  location=$(printf "%s" "$geo" | awk -F '\t' '{print $1}')
  asn=$(printf "%s" "$geo" | awk -F '\t' '{print $2}')
  [ -z "$loss" ] && loss="--"
  [ -z "$sent" ] && sent="--"
  [ -z "$last" ] && last="--"
  [ -z "$best" ] && best="--"
  [ -z "$worst" ] && worst="--"
  [ -z "$avg" ] && avg="--"
  [ -z "$location" ] && location="--"
  [ -z "$asn" ] && asn="--"
  printf "ldetail\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$hop" "$ip" "$ptr" "$location" "$asn" "$loss" "$sent" "$last" "$best" "$worst" "$avg"
}
if command -v mtr >/dev/null 2>&1; then
  mtr -n -r -c 20 -i 0.2 -w -b "$target" 2>/dev/null | awk '
    /^[[:space:]]*[0-9]+\./ {
      hop=$1; gsub(/[^0-9]/,"",hop)
      ip=$2
      loss=$3
      sent=$4
      last=$5
      avg=$6
      best=$7
      worst=$8
      if(last=="") last="--"
      if(avg=="") avg="--"
      if(best=="") best="--"
      if(worst=="") worst="--"
      printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", hop, ip, loss, sent, last, best, worst, avg
    }' | while IFS="$(printf '\t')" read -r hop ip loss sent last best worst avg; do
      emit_row "$hop" "$ip" "$loss" "$sent" "$last" "$best" "$worst" "$avg"
    done
elif command -v traceroute >/dev/null 2>&1; then
  traceroute -n -w 1 -q 1 -m 12 "$target" 2>/dev/null | awk '{
    hop=$1; ip=$2
    if(ip=="*"||ip=="") {printf "%s\t--\t100%%\t1\t*\t--\t--\t--\n", hop; next}
    if(hop !~ /^[0-9]+$/) next
    sent=1; count=0; sum=0; best=""; worst=""; last="*"
    for(i=3;i<=NF;i++){
      if($i ~ /^[0-9.]+$/ && $(i+1)=="ms"){
        v=$i+0; count++; sum+=v; last=sprintf("%.0f", v)
        if(best==""||v<best) best=v
        if(worst==""||v>worst) worst=v
      }
    }
    loss=sprintf("%.0f%%", (sent-count)*100/sent)
    avg=count?sprintf("%.0f", sum/count):"--"
    best=count?sprintf("%.0f", best):"--"
    worst=count?sprintf("%.0f", worst):"--"
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", hop, ip, loss, sent, last, best, worst, avg
  }' | while IFS="$(printf '\t')" read -r hop ip loss sent last best worst avg; do
    emit_row "$hop" "$ip" "$loss" "$sent" "$last" "$best" "$worst" "$avg"
  done
elif command -v tracepath >/dev/null 2>&1; then
  tracepath -n -m 12 "$target" 2>/dev/null | awk '{
    hop=$1; ip=$2
    if(hop ~ /^[0-9]+:/){
      gsub(":","",hop)
      if(ip=="no" || ip=="") ip="--"
      printf "%s\t%s\n", hop, ip
    }
  }' | while IFS="$(printf '\t')" read -r hop ip; do
    if [ "$ip" = "--" ]; then
      printf "%s\t--\t100%%\t3\t*\t--\t--\t--\n" "$hop"
      continue
    fi
    ping -c 3 -W 1 "$ip" 2>/dev/null | awk -v hop="$hop" -v ip="$ip" '
      BEGIN { sent=3; received=0; loss="100%"; last="*"; best="--"; worst="--"; avg="--" }
      /bytes from/ {
        received++
        for(i=1;i<=NF;i++){
          if($i ~ /^time[=<]/){
            value=$i
            sub(/^time[=<]/, "", value)
            sub(/ms$/, "", value)
            if(value=="") next
            if($i ~ /^time</){
              last="<1"; if(best=="--") best="<1"; worst="<1"
            } else {
              v=value+0
              last=sprintf("%.0f", v)
              sum+=v
              if(best=="--"||v<best) best=v
              if(worst=="--"||v>worst) worst=v
            }
          }
        }
      }
      /packets transmitted/ {
        sent=$1
        for(i=1;i<=NF;i++){
          if($i=="received," && i>1) received=$(i-1)+0
          if($i=="received" && i>1) received=$(i-1)+0
        }
      }
      END {
        loss=sprintf("%.0f%%", sent>0 ? (sent-received)*100/sent : 0)
        if(received>0 && best!="<1"){
          avg=sprintf("%.0f", sum/received)
          best=sprintf("%.0f", best)
          worst=sprintf("%.0f", worst)
        } else if(received>0) {
          avg="<1"; best="<1"; worst="<1"
        }
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", hop, ip, loss, sent, last, best, worst, avg
      }'
  done | while IFS="$(printf '\t')" read -r hop ip loss sent last best worst avg; do
    emit_row "$hop" "$ip" "$loss" "$sent" "$last" "$best" "$worst" "$avg"
  done
else
  ttl=1
  while [ "$ttl" -le 16 ]; do
    row=$(ping -c 1 -W 1 -t "$ttl" "$target" 2>/dev/null | awk -v ttl="$ttl" -v target="$target" '
      BEGIN { ip="--"; sent=1; received=0; last="*"; best="--"; worst="--"; avg="--"; reached=0 }
      /From / {
        for(i=1;i<=NF;i++){
          if($i=="From" && i<NF){ ip=$(i+1); gsub(/:$/,"",ip) }
        }
        received=1
      }
      / bytes from / {
        for(i=1;i<=NF;i++){
          if($i=="from" && i<NF){ ip=$(i+1); gsub(/:$/,"",ip); reached=1 }
        }
      }
      {
        for(i=1;i<=NF;i++){
          if($i ~ /^time[=<]/){
            value=$i
            sub(/^time[=<]/, "", value)
            sub(/ms$/, "", value)
            if(value=="") next
            received=1
            if($i ~ /^time</){
              last="<1"; best="<1"; worst="<1"; avg="<1"
            } else {
              last=sprintf("%.0f", value+0)
              best=last; worst=last; avg=last
            }
          }
        }
      }
      /packets transmitted/ {
        sent=$1
        for(i=1;i<=NF;i++){
          if($i=="received," && i>1) received=$(i-1)+0
          if($i=="received" && i>1) received=$(i-1)+0
        }
      }
      END {
        if(ip=="--" && received==0) {
          printf "%s\t--\t100%%\t%s\t*\t--\t--\t--\t0\n", ttl, sent
        } else {
          loss=sprintf("%.0f%%", sent>0 ? (sent-received)*100/sent : 0)
          printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", ttl, ip, loss, sent, last, best, worst, avg, reached
        }
      }')
    IFS="$(printf '\t')" read -r hop ip loss sent last best worst avg reached <<EOF
$row
EOF
    emit_row "$hop" "$ip" "$loss" "$sent" "$last" "$best" "$worst" "$avg"
    [ "$reached" = "1" ] && break
    ttl=$((ttl + 1))
  done
fi
`
    return this.encodeShellScript(script
      .replace('__TABBY_STATUS_TRACE_TARGET__', safeTarget))
  }

  private renderDetailRows (terminal: BaseTerminalTabComponent<any>, state: DetailModalState, text: string): void {
    const body = state.body.querySelector('tbody')
    if (!body) {
      return
    }
    const sort = this.detailSort.get(terminal)
    this.renderDetailSortState(state, sort)

    if (state.kind === 'process') {
      const rows = this.sortDetailRows(this.parseProcessDetails(text), sort)
      if (rows.length === 0) {
        this.renderEmptyDetailRows(state)
        return
      }
      body.innerHTML = rows.map(row => `
        <tr data-process-pid="${this.escape(row.pid)}" data-process-name="${this.escape(this.getProcessName(row.command))}" data-process-command="${this.escape(row.command)}" data-process-location="${this.escape(row.location)}">
          <td>${this.escape(row.pid)}</td>
          <td>${this.escape(row.user)}</td>
          <td>${this.escape(row.mem)}%</td>
          <td>${this.escape(row.cpu)}%</td>
          <td title="${this.escape(row.command)}">${this.escape(row.command)}</td>
          <td title="${this.escape(row.location)}">${this.escape(row.location)}</td>
        </tr>
      `).join('')
      return
    }

    if (state.kind === 'network') {
      const rows = this.sortDetailRows(this.withNetworkRates(state, this.parseNetworkDetails(text)), sort)
      if (rows.length === 0) {
        this.renderEmptyDetailRows(state)
        return
      }
      body.innerHTML = rows.map(row => `
        <tr>
          <td>${this.escape(row.pid)}</td>
          <td>${this.escape(row.name)}</td>
          <td title="${this.escape(row.listenIp)}">${this.escape(row.listenIp)}</td>
          <td>${this.escape(row.port)}</td>
          <td>${this.escape(row.ipCount)}</td>
          <td>${this.escape(row.connCount)}</td>
          <td>${this.escape(row.upload)}</td>
          <td>${this.escape(row.download)}</td>
        </tr>
      `).join('')
      return
    }

    const rows = this.parseLatencyDetails(text)
    if (rows.length === 0) {
      this.renderEmptyDetailRows(state)
      return
    }
    body.innerHTML = rows.map(row => `
      <tr>
        <td>${this.escape(row.hop)}</td>
        <td>${this.escape(row.ip)}</td>
        <td title="${this.escape(row.ptr)}">${this.escape(row.ptr)}</td>
        <td>${this.escape(row.location)}</td>
        <td>${this.escape(row.asn)}</td>
        <td>${this.escape(row.loss)}</td>
        <td>${this.escape(row.sent)}</td>
        <td>${this.escape(row.last)}</td>
        <td>${this.escape(row.best)}</td>
        <td>${this.escape(row.worst)}</td>
        <td>${this.escape(row.avg)}</td>
      </tr>
    `).join('')
  }

  private renderEmptyDetailRows (state: DetailModalState): void {
    const body = state.body.querySelector('tbody')
    if (!body) {
      return
    }
    const columns = this.getDetailColumns(state.kind)
    const rows = Array.from({ length: 8 }, (_, rowIndex) => `
      <tr class="tfs-detail-empty-row" data-empty-detail="1">
        ${columns.map((column, colIndex) => {
          const width = Math.max(28, Math.min(86, Math.round(42 + ((rowIndex + colIndex) % 4) * 12 + (column.fill ? 18 : 0))))
          return `<td><span class="tfs-detail-skeleton" style="width:${width}%"></span></td>`
        }).join('')}
      </tr>
    `).join('')
    body.innerHTML = rows
  }

  private parseProcessDetails (text: string): ProcessDetailRow[] {
    return text.split(/\r?\n/).filter(Boolean).map(line => line.split('\t')).filter(parts => parts[0] === 'pdetail').map(parts => ({
      pid: parts[1] || '-',
      user: parts[2] || '-',
      mem: parts[3] || '0',
      cpu: parts[4] || '0',
      command: parts[5] || '-',
      location: parts[6] || '-',
    }))
  }

  private getProcessName (command: string): string {
    const first = String(command || '').trim().split(/\s+/)[0] || '-'
    const parts = first.split('/')
    return parts[parts.length - 1] || first
  }

  private parseNetworkDetails (text: string): NetworkDetailRow[] {
    return text.split(/\r?\n/).filter(Boolean).map(line => line.split('\t')).filter(parts => parts[0] === 'ndetail').map(parts => ({
      pid: parts[1] || '-',
      name: parts[2] || '-',
      listenIp: parts[3] || '-',
      port: parts[4] || '-',
      ipCount: parts[5] || '0',
      connCount: parts[6] || '0',
      upload: '-',
      download: '-',
      uploadBytes: Number(parts[7] || 0),
      downloadBytes: Number(parts[8] || 0),
    }))
  }

  private withNetworkRates (state: DetailModalState, rows: NetworkDetailRow[]): NetworkDetailRow[] {
    const now = Date.now()
    const previous = state.networkSnapshots ?? new Map<string, { uploadBytes: number, downloadBytes: number, ts: number }>()
    const next = new Map<string, { uploadBytes: number, downloadBytes: number, ts: number }>()
    const withRates = rows.map(row => {
      const key = `${row.pid}|${row.name}|${row.listenIp}|${row.port}`
      const uploadBytes = Number(row.uploadBytes || 0)
      const downloadBytes = Number(row.downloadBytes || 0)
      const before = previous.get(key)
      let upload = '-'
      let download = '-'
      if (before && uploadBytes >= before.uploadBytes && downloadBytes >= before.downloadBytes) {
        const seconds = Math.max(0.001, (now - before.ts) / 1000)
        upload = this.formatBytesPerSecond((uploadBytes - before.uploadBytes) / seconds)
        download = this.formatBytesPerSecond((downloadBytes - before.downloadBytes) / seconds)
      }
      next.set(key, { uploadBytes, downloadBytes, ts: now })
      return { ...row, upload, download }
    })
    state.networkSnapshots = next
    return withRates
  }

  private parseLatencyDetails (text: string): LatencyDetailRow[] {
    const rowsByHop = new Map<string, LatencyDetailRow>()
    for (const parts of text.split(/\r?\n/).filter(Boolean).map(line => line.split('\t')).filter(parts => parts[0] === 'ldetail')) {
      const row: LatencyDetailRow = {
        hop: parts[1] || '-',
        ip: parts[2] || '--',
        ptr: parts[3] || '--',
        location: parts[4] || '--',
        asn: parts[5] || '--',
        loss: parts[6] || '--',
        sent: parts[7] || '--',
        last: parts[8] || '--',
        best: parts[9] || '--',
        worst: parts[10] || '--',
        avg: parts[11] || '--',
      }
      const previous = rowsByHop.get(row.hop)
      rowsByHop.set(row.hop, previous ? this.mergeLatencyDetailRow(previous, row) : row)
    }
    return Array.from(rowsByHop.values())
  }

  private mergeLatencyDetailRow (previous: LatencyDetailRow, next: LatencyDetailRow): LatencyDetailRow {
    const pick = (newValue: string, oldValue: string) => newValue && newValue !== '--' ? newValue : oldValue
    return {
      hop: previous.hop,
      ip: pick(next.ip, previous.ip),
      ptr: pick(next.ptr, previous.ptr),
      location: pick(next.location, previous.location),
      asn: pick(next.asn, previous.asn),
      loss: pick(next.loss, previous.loss),
      sent: pick(next.sent, previous.sent),
      last: pick(next.last, previous.last),
      best: pick(next.best, previous.best),
      worst: pick(next.worst, previous.worst),
      avg: pick(next.avg, previous.avg),
    }
  }

  private sortDetailRows<T extends Record<string, unknown>> (rows: T[], sort?: DetailSortState): T[] {
    if (!sort) {
      return rows
    }

    const direction = sort.direction === 'asc' ? 1 : -1
    return [...rows].sort((left, right) => {
      const leftValue = String(left[sort.key] ?? '')
      const rightValue = String(right[sort.key] ?? '')
      const leftNumber = this.parseSortableNumber(leftValue)
      const rightNumber = this.parseSortableNumber(rightValue)
      const diff = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
        ? leftNumber - rightNumber
        : String(leftValue).localeCompare(String(rightValue))
      return diff * direction
    })
  }

  private parseSortableNumber (value: string): number {
    if (value === '-' || value === '') {
      return Number.NaN
    }
    const parsed = Number(String(value).replace(/[%A-Za-z/]+/g, ''))
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }

  private renderDetailSortState (state: DetailModalState, sort?: DetailSortState): void {
    for (const button of Array.from(state.body.querySelectorAll<HTMLButtonElement>('button[data-detail-sort]'))) {
      const active = sort?.key === button.dataset.detailSort
      button.classList.toggle('tfs-sort-active', active)
      if (active && sort) {
        button.dataset.dir = sort.direction
      } else {
        button.removeAttribute('data-dir')
      }
    }
  }

  private mountPanel (terminal: BaseTerminalTabComponent<any>, panel: HTMLElement): void {
    const terminalElement = terminal.element?.nativeElement ?? document.body
    const layoutHost = terminalElement.parentElement ?? terminalElement
    layoutHost.classList.add('tabby-status-layout')
    this.setPanelWidth(layoutHost, this.getSavedPanelWidth())
    layoutHost.appendChild(panel)
    this.hosts.set(terminal, layoutHost)
    this.bindPanelCollapse(terminal, layoutHost, panel)
    this.setPanelCollapsed(terminal, layoutHost, panel, this.getSavedPanelCollapsed(), false, false)
    this.bindPanelResize(terminal, layoutHost, panel)
    this.bindThemeSync(terminal, layoutHost, panel, terminalElement)
    this.scheduleTerminalResize(terminal)
  }

  private bindThemeSync (terminal: BaseTerminalTabComponent<any>, host: HTMLElement, panel: HTMLElement, terminalElement: HTMLElement): void {
    this.clearThemeSync(terminal)
    const state: ThemeSyncState = {}
    this.themeSyncs.set(terminal, state)
    const refresh = () => this.syncThemeVars(terminal, host, panel, terminalElement)

    refresh()
    window.requestAnimationFrame(refresh)
    window.setTimeout(refresh, 80)

    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(refresh)
      for (const node of this.uniqueElements([document.documentElement, document.body, terminalElement, host])) {
        observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
      }
      state.observer = observer
    }

    state.interval = window.setInterval(refresh, 1000)
  }

  private clearThemeSync (terminal: BaseTerminalTabComponent<any>): void {
    const state = this.themeSyncs.get(terminal)
    if (!state) {
      return
    }
    state.observer?.disconnect()
    if (state.interval !== undefined) {
      window.clearInterval(state.interval)
    }
    this.themeSyncs.delete(terminal)
  }

  private syncThemeVars (terminal: BaseTerminalTabComponent<any>, host: HTMLElement, panel: HTMLElement, terminalElement: HTMLElement): void {
    const state = this.themeSyncs.get(terminal)
    const colors = this.resolveThemeColors(host, panel, terminalElement)
    const signature = `${colors.background}|${colors.foreground}|${colors.accent}`
    if (state?.lastSignature === signature) {
      return
    }
    if (state) {
      state.lastSignature = signature
    }
    this.applyThemeVars(host, colors)

    const detail = this.detailModals.get(terminal)
    if (detail) {
      this.applyThemeVars(detail.modal, colors)
    }
    for (const overlay of Array.from(document.querySelectorAll<HTMLElement>('.tfs-context-menu, .tfs-iface-menu'))) {
      this.applyThemeVars(overlay, colors)
    }
  }

  private resolveThemeColors (host: HTMLElement, panel: HTMLElement, terminalElement: HTMLElement): ThemeColors {
    const candidates = this.getThemeCandidates(host, panel, terminalElement)
    const background = this.firstThemeCustomColor(candidates, ['--theme-background', '--terminal-background', '--background-color', '--body-bg-color']) ||
      this.firstComputedColor(candidates, 'backgroundColor') ||
      '#1f272a'
    const foreground = this.firstThemeCustomColor(candidates, ['--theme-foreground', '--terminal-foreground', '--foreground-color', '--body-color']) ||
      this.firstComputedColor(candidates, 'color') ||
      (this.isLightColor(background) ? '#1f2933' : '#d7dee0')
    const accent = this.firstThemeCustomColor(candidates, ['--theme-color', '--theme-primary', '--color-primary', '--color-accent', '--accent-color']) ||
      (this.isLightColor(background) ? '#2563eb' : '#7fc8ff')

    return { background, foreground, accent }
  }

  private getThemeCandidates (host: HTMLElement, panel: HTMLElement, terminalElement: HTMLElement): HTMLElement[] {
    const selectors = [
      '.xterm-viewport',
      '.xterm-screen',
      '.xterm-rows',
      '.xterm',
      '.terminal',
      '.content',
    ]
    const candidates: HTMLElement[] = []
    const add = (node: Element | null | undefined) => {
      if (node instanceof HTMLElement && node !== panel && !panel.contains(node)) {
        candidates.push(node)
      }
    }

    for (const selector of selectors) {
      add(terminalElement.querySelector(selector))
      add(host.querySelector(selector))
    }
    add(terminalElement)
    add(host.querySelector('.content'))
    add(host)
    add(host.parentElement)
    add(document.body)
    add(document.documentElement)

    return this.uniqueElements(candidates)
  }

  private uniqueElements (elements: Array<HTMLElement | null | undefined>): HTMLElement[] {
    const seen = new Set<HTMLElement>()
    const unique: HTMLElement[] = []
    for (const element of elements) {
      if (!element || seen.has(element)) {
        continue
      }
      seen.add(element)
      unique.push(element)
    }
    return unique
  }

  private firstThemeCustomColor (elements: HTMLElement[], names: string[]): string {
    for (const element of elements) {
      const style = window.getComputedStyle(element)
      for (const name of names) {
        const value = style.getPropertyValue(name).trim()
        if (this.isUsableColor(value)) {
          return value
        }
      }
    }
    return ''
  }

  private firstComputedColor (elements: HTMLElement[], property: 'backgroundColor' | 'color'): string {
    for (const element of elements) {
      const value = window.getComputedStyle(element)[property]
      if (this.isUsableColor(value)) {
        return value
      }
    }
    return ''
  }

  private isUsableColor (value: string): boolean {
    const normalized = String(value || '').trim().toLowerCase()
    return Boolean(normalized) &&
      normalized !== 'transparent' &&
      !normalized.startsWith('var(') &&
      !normalized.includes('rgba(0, 0, 0, 0)') &&
      !normalized.includes('rgba(0,0,0,0)')
  }

  private isLightColor (value: string): boolean {
    const rgb = this.parseRgbColor(value)
    if (!rgb) {
      return false
    }
    return ((rgb.r * 299) + (rgb.g * 587) + (rgb.b * 114)) / 1000 > 170
  }

  private parseRgbColor (value: string): { r: number, g: number, b: number } | undefined {
    const hex = String(value).trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
    if (hex) {
      const raw = hex[1]
      const full = raw.length === 3 ? raw.split('').map(char => `${char}${char}`).join('') : raw
      return {
        r: parseInt(full.slice(0, 2), 16),
        g: parseInt(full.slice(2, 4), 16),
        b: parseInt(full.slice(4, 6), 16),
      }
    }

    const rgb = String(value).match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i)
    if (!rgb) {
      return undefined
    }
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
    }
  }

  private applyThemeVars (element: HTMLElement, colors: ThemeColors): void {
    element.style.setProperty('--tfs-bg', colors.background)
    element.style.setProperty('--tfs-text-primary', colors.foreground)
    element.style.setProperty('--tfs-accent', colors.accent)
  }

  private applyCurrentThemeToOverlay (terminal: BaseTerminalTabComponent<any>, overlay: HTMLElement): void {
    const host = this.hosts.get(terminal)
    if (!host) {
      return
    }
    const background = host.style.getPropertyValue('--tfs-bg').trim()
    const foreground = host.style.getPropertyValue('--tfs-text-primary').trim()
    const accent = host.style.getPropertyValue('--tfs-accent').trim()
    if (background && foreground && accent) {
      this.applyThemeVars(overlay, { background, foreground, accent })
    }
  }

  private clearThemeVars (element?: HTMLElement): void {
    if (!element) {
      return
    }
    element.style.removeProperty('--tfs-bg')
    element.style.removeProperty('--tfs-text-primary')
    element.style.removeProperty('--tfs-accent')
  }

  private bindPanelResize (terminal: BaseTerminalTabComponent<any>, host: HTMLElement, panel: HTMLElement): void {
    const handle = panel.querySelector('.tfs-resizer') as HTMLElement | null
    if (!handle) {
      return
    }

    let startX = 0
    let startWidth = 0

    const move = (event: MouseEvent) => {
      const nextWidth = this.clampPanelWidth(startWidth + event.clientX - startX)
      this.setPanelWidth(host, nextWidth)
      this.scheduleTerminalResize(terminal)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('tfs-resizing')
      const width = this.readPanelWidth(host)
      window.localStorage?.setItem(this.panelWidthStorageKey, String(width))
      this.scheduleTerminalResize(terminal)
    }

    handle.addEventListener('mousedown', event => {
      event.preventDefault()
      startX = event.clientX
      startWidth = this.readPanelWidth(host)
      document.body.classList.add('tfs-resizing')
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
  }

  private bindPanelCollapse (terminal: BaseTerminalTabComponent<any>, host: HTMLElement, panel: HTMLElement): void {
    const button = panel.querySelector<HTMLButtonElement>('button[data-action="panel-collapse"]')
    button?.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      this.setPanelCollapsed(terminal, host, panel, !host.classList.contains('tabby-status-collapsed'), true, true)
    })
  }

  private getSavedPanelWidth (): number {
    return this.clampPanelWidth(Number(window.localStorage?.getItem(this.panelWidthStorageKey) || 320))
  }

  private getSavedPanelCollapsed (): boolean {
    return window.localStorage?.getItem(this.panelCollapsedStorageKey) === '1'
  }

  private readPanelWidth (host: HTMLElement): number {
    return this.clampPanelWidth(Number(host.style.getPropertyValue('--tfs-panel-width').replace('px', '')) || 320)
  }

  private setPanelWidth (host: HTMLElement, width: number): void {
    host.style.setProperty('--tfs-panel-width', `${this.clampPanelWidth(width)}px`)
    host.style.setProperty('--tfs-panel-rail-width', `${this.collapsedPanelWidth}px`)
  }

  private setPanelCollapsed (terminal: BaseTerminalTabComponent<any>, host: HTMLElement, panel: HTMLElement, collapsed: boolean, persist = true, animate = true): void {
    if (animate) {
      host.classList.add('tfs-panel-toggling')
      void host.offsetWidth
    } else {
      host.classList.remove('tfs-panel-toggling')
    }
    host.classList.toggle('tabby-status-collapsed', collapsed)
    const button = panel.querySelector<HTMLButtonElement>('button[data-action="panel-collapse"]')
    if (button) {
      const label = collapsed ? '展开状态面板' : '收起状态面板'
      button.title = label
      button.setAttribute('aria-label', label)
      button.setAttribute('aria-expanded', String(!collapsed))
    }
    if (persist) {
      window.localStorage?.setItem(this.panelCollapsedStorageKey, collapsed ? '1' : '0')
    }
    this.scheduleTerminalResize(terminal)
    if (animate) {
      window.setTimeout(() => {
        host.classList.remove('tfs-panel-toggling')
        this.scheduleTerminalResize(terminal)
      }, 240)
    }
  }

  private scheduleTerminalResize (terminal: BaseTerminalTabComponent<any>): void {
    const resize = () => {
      const frontend = terminal.frontend as any
      if (typeof frontend?.resizeHandler === 'function') {
        frontend.resizeHandler()
        return
      }
      window.dispatchEvent(new Event('resize'))
    }
    window.requestAnimationFrame(resize)
    window.setTimeout(resize, 80)
  }

  private clampPanelWidth (width: number): number {
    return Math.max(this.minPanelWidth, Math.min(this.maxPanelWidth, Math.round(width)))
  }

  private render (terminal: BaseTerminalTabComponent<any>, panel: HTMLElement, raw: any): void {
    const memParts = String(raw.mem ?? '0|0G|0G|0|0M|0M').split('|')
    const publicIp = String(raw.publicIp || '')
    const localIp = String(raw.localIp || '')
    const displayIp = publicIp || raw.ip || localIp || '-'
    const payload: StatusPayload = {
      ip: displayIp,
      ipType: publicIp ? '公网' : (localIp || raw.ip ? '本机' : '-'),
      uptime: raw.uptime || '-',
      load: raw.load || '-',
      cpuCores: Number(raw.cpuCores || 0),
      cpu: this.clampPercent(raw.cpu, 1),
      memPct: this.clampPercent(memParts[0]),
      memUsed: memParts[1] || '0G',
      memTotal: memParts[2] || '0G',
      swapPct: this.clampPercent(memParts[3]),
      swapUsed: memParts[4] || '0M',
      swapTotal: memParts[5] || '0M',
      rx: raw.rx || '0K',
      tx: raw.tx || '0K',
      iface: raw.iface || '-',
      ifaceList: raw.ifaceList || raw.iface || '',
      disks: this.parseDisks(raw.disks),
      processes: this.parseProcesses(raw.processes),
      latency: Number(raw.latency || 0),
    }

    panel.querySelector('.tfs-dot')?.classList.add('on')
    this.setText(panel, '.tfs-ip strong', payload.ip)
    this.setData(panel, 'ip-type', payload.ipType)
    this.setData(panel, 'uptime', payload.uptime)
    this.setData(panel, 'load', payload.cpuCores ? `${payload.load} / ${payload.cpuCores}核` : payload.load)
    this.setMeterData(panel, 'cpu', this.formatPercent(payload.cpu))
    this.setMeterData(panel, 'mem', this.formatPercent(payload.memPct), `${payload.memUsed}/${payload.memTotal}`)
    this.setMeterData(panel, 'swap', payload.swapTotal === '0M' ? '未启用' : this.formatPercent(payload.swapPct), payload.swapTotal === '0M' ? '' : `${payload.swapUsed}/${payload.swapTotal}`, payload.swapTotal === '0M')
    this.setData(panel, 'rx', `↓${payload.rx}`)
    this.setData(panel, 'tx', `↑${payload.tx}`)
    this.setData(panel, 'iface', payload.iface)
    this.setData(panel, 'latency', `${payload.latency}ms`)
    this.setBar(panel, 'cpu', payload.cpu)
    this.setBar(panel, 'mem', payload.memPct)
    this.setBar(panel, 'swap', payload.swapPct)
    this.renderNetworkChart(panel, raw.netHistory)
    this.renderLatencyChart(panel, raw.latencyHistory)
    this.renderDisks(panel, payload.disks)
    const processSort = this.processSort.get(terminal)
    this.renderProcessSortState(panel, processSort)
    this.renderProcesses(panel, payload.processes, processSort)
  }

  private parseMetricPayload (text: string, kind?: CollectorKind): any {
    const trimmed = text.trim()
    if (trimmed.startsWith('{')) {
      return JSON.parse(trimmed)
    }

    const result: any = {}
    const disks: string[] = []
    const processes: string[] = []

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
        const [path, avail, size, pct] = parts
        disks.push([path, avail, size, pct].join(','))
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
    if (kind === 'process' && !processes.length) {
      result.processes = ''
    } else if (!result.ip && !result.publicIp && !result.localIp && !result.uptime && !result.cpu && !result.cpuCores && !result.cpuBusy && !result.cpuTotal && !result.mem && !result.rxBytes && !result.txBytes && !disks.length && !processes.length) {
      throw new Error(`empty payload: ${text.slice(0, 80)}`)
    }
    result.kind = kind
    return result
  }

  private mergeMetricPatch (terminal: BaseTerminalTabComponent<any>, patch: any): any {
    const current = this.state.get(terminal) ?? {}
    const next = { ...current, ...patch }
    const stablePublicIp = this.resolveStablePublicIp(terminal, current, patch)
    if (stablePublicIp) {
      next.publicIp = stablePublicIp
    }

    if (patch.cpuBusy !== undefined && patch.cpuTotal !== undefined) {
      const busy = Number(patch.cpuBusy || 0)
      const total = Number(patch.cpuTotal || 0)
      const previous = this.cpuSnapshots.get(terminal)
      if (previous && Number.isFinite(busy) && Number.isFinite(total) && total > 0) {
        const busyDelta = busy - previous.busy
        const totalDelta = total - previous.total
        if (busyDelta >= 0 && totalDelta > 0 && busyDelta <= totalDelta) {
          next.cpu = this.clampPercent((busyDelta * 100) / totalDelta, 1)
        } else {
          next.cpu = this.clampPercent(current.cpu, 1)
        }
      } else {
        next.cpu = this.clampPercent(current.cpu, 1)
      }
      this.cpuSnapshots.set(terminal, { busy, total })
    }

    if (patch.iface !== undefined && current.iface !== undefined && patch.iface !== current.iface) {
      this.netSnapshots.delete(terminal)
      this.netHistory.delete(terminal)
    }

    if (patch.rxBytes !== undefined && patch.txBytes !== undefined) {
      const now = Date.now()
      const rx = Number(patch.rxBytes || 0)
      const tx = Number(patch.txBytes || 0)
      const previous = this.netSnapshots.get(terminal)
      let rxRate = 0
      let txRate = 0

      if (previous) {
        const seconds = Math.max(0.001, (now - previous.ts) / 1000)
        rxRate = Math.max(0, (rx - previous.rx) / seconds)
        txRate = Math.max(0, (tx - previous.tx) / seconds)
        next.rx = this.formatBytesPerSecond(rxRate)
        next.tx = this.formatBytesPerSecond(txRate)
      } else {
        next.rx = '0B/s'
        next.tx = '0B/s'
      }
      this.netSnapshots.set(terminal, { rx, tx, ts: now })
      const history = this.netHistory.get(terminal) ?? { rx: [], tx: [] }
      history.rx = [...history.rx, rxRate].slice(-24)
      history.tx = [...history.tx, txRate].slice(-24)
      this.netHistory.set(terminal, history)
      next.netHistory = history
    }

    if (patch.latency !== undefined) {
      const latency = Math.max(0, Number(patch.latency || 0))
      const history = this.latencyHistory.get(terminal) ?? { values: [] }
      history.values = [...history.values, latency].slice(-24)
      this.latencyHistory.set(terminal, history)
      next.latencyHistory = history
    }

    if (patch.processes === '') {
      next.processes = current.processes
    }

    delete next.rxBytes
    delete next.txBytes
    delete next.cpuBusy
    delete next.cpuTotal
    delete next.kind
    this.state.set(terminal, next)
    return next
  }

  private resolveStablePublicIp (terminal: BaseTerminalTabComponent<any>, current: any, patch: any): string {
    const pinned = this.pinnedPublicIps.get(terminal)
    if (pinned) {
      return pinned
    }
    const publicIp = String(patch.publicIp || current.publicIp || '').trim()
    if (publicIp) {
      this.pinnedPublicIps.set(terminal, publicIp)
    }
    return publicIp
  }

  private formatBytesPerSecond (value: number): string {
    const bytes = Math.max(0, value)
    const units = ['B/s', 'K/s', 'M/s', 'G/s', 'T/s']
    let scaled = bytes
    let unit = 0
    while (scaled >= 1024 && unit < units.length - 1) {
      scaled /= 1024
      unit++
    }
    const digits = unit === 0 || scaled >= 10 ? 0 : 1
    return `${scaled.toFixed(digits)}${units[unit]}`
  }

  private clampPercent (value: unknown, fractionDigits = 0): number {
    const number = Number(value || 0)
    if (!Number.isFinite(number)) {
      return 0
    }
    const clamped = Math.max(0, Math.min(100, number))
    const factor = 10 ** fractionDigits
    const rounded = Math.round(clamped * factor) / factor
    if (fractionDigits > 0 && clamped > 0 && rounded === 0) {
      return 1 / factor
    }
    return rounded
  }

  private formatPercent (value: number): string {
    const number = Number(value || 0)
    return `${Math.round(Number.isFinite(number) ? number : 0)}%`
  }

  private parseDisks (value: string): DiskRow[] {
    return String(value || '').split(';').filter(Boolean).map(row => {
      const [path, avail, size, pct] = row.split(',')
      return { path, avail, size, pct: Number(pct || 0) }
    })
  }

  private parseProcesses (value: string): ProcessRow[] {
    return String(value || '').split(';').filter(Boolean).map(row => {
      const [pid, cpu, mem, command] = row.split(',')
      return { pid, cpu, mem, command }
    })
  }

  private renderDisks (panel: HTMLElement, disks: DiskRow[]): void {
    const body = panel.querySelector('[data-k="disks"]')
    if (!body) {
      return
    }
    body.innerHTML = disks.map(d => `
      <tr>
        <td title="${this.escape(d.path)}">${this.escape(d.path)}</td>
        <td><span>${this.escape(d.avail)}/${this.escape(d.size)}</span><i style="width:${Math.max(0, Math.min(100, d.pct))}%"></i></td>
      </tr>
    `).join('')
  }

  private renderProcesses (panel: HTMLElement, processes: ProcessRow[], sort?: ProcessSortState): void {
    const body = panel.querySelector('[data-k="processes"]')
    if (!body) {
      return
    }
    body.innerHTML = this.sortProcesses(processes, sort).map(p => `
      <div><span>${this.escape(p.mem)}%</span><span>${this.escape(p.cpu)}%</span><span>${this.escape(p.command)} #${this.escape(p.pid)}</span></div>
    `).join('')
  }

  private sortProcesses (processes: ProcessRow[], sort?: ProcessSortState): ProcessRow[] {
    if (!sort) {
      return processes
    }

    const direction = sort.direction === 'asc' ? 1 : -1
    return [...processes].sort((left, right) => {
      const leftValue = Number(left[sort.key] || 0)
      const rightValue = Number(right[sort.key] || 0)
      const diff = leftValue - rightValue
      if (diff !== 0) {
        return diff * direction
      }
      return left.command.localeCompare(right.command)
    })
  }

  private renderProcessSortState (panel: HTMLElement, sort?: ProcessSortState): void {
    for (const button of Array.from(panel.querySelectorAll<HTMLButtonElement>('.tfs-tabs button[data-sort]'))) {
      const active = sort?.key === button.dataset.sort
      button.classList.toggle('tfs-sort-active', active)
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
      if (active && sort) {
        button.dataset.dir = sort.direction
        button.title = `按${button.textContent || ''}排序：${sort.direction === 'desc' ? '降序' : '升序'}`
      } else {
        button.removeAttribute('data-dir')
        button.title = `按${button.textContent || ''}排序`
      }
    }
  }

  private renderNetworkChart (panel: HTMLElement, history?: NetHistory): void {
    const body = panel.querySelector('[data-k="net-bars"]')
    if (!body) {
      return
    }
    const rx = history?.rx ?? []
    const tx = history?.tx ?? []
    const size = Math.max(rx.length, tx.length, 24)
    const values = Array.from({ length: size }, (_, index) => ({
      rx: rx[index - (size - rx.length)] ?? 0,
      tx: tx[index - (size - tx.length)] ?? 0,
    })).slice(-24)
    const max = Math.max(1, ...values.flatMap(v => [v.rx, v.tx]))
    const isIdle = values.every(v => v.rx <= 0 && v.tx <= 0)

    body.classList.toggle('tfs-idle', isIdle)
    this.setData(panel, 'net-peak', isIdle ? '空闲' : `峰值 ${this.formatBytesPerSecond(max)}`)

    body.innerHTML = values.map(v => {
      const rxHeight = Math.max(2, Math.round((v.rx / max) * 26))
      const txHeight = Math.max(2, Math.round((v.tx / max) * 26))
      return `<span><i class="tx" style="height:${txHeight}px"></i><i class="rx" style="height:${rxHeight}px"></i></span>`
    }).join('')
  }

  private renderLatencyChart (panel: HTMLElement, history?: LatencyHistory): void {
    const body = panel.querySelector('[data-k="latency-bars"]')
    if (!body) {
      return
    }
    const source = history?.values ?? []
    const size = Math.max(source.length, 24)
    const values = Array.from({ length: size }, (_, index) => source[index - (size - source.length)] ?? 0).slice(-24)
    const max = Math.max(1, ...values)
    const isIdle = values.every(v => v <= 0)

    body.classList.toggle('tfs-idle', isIdle)
    this.setData(panel, 'latency-peak', isIdle ? '延迟 -' : `峰值 ${Math.round(max)}ms`)
    body.innerHTML = values.map(value => {
      const height = Math.max(2, Math.round((value / max) * 24))
      return `<span style="height:${height}px"></span>`
    }).join('')
  }

  private setData (panel: HTMLElement, key: string, value: string): void {
    this.setText(panel, `[data-k="${key}"]`, value)
  }

  private setMeterData (panel: HTMLElement, key: string, percent: string, detail = '', disabled = false): void {
    this.setData(panel, `${key}-pct`, detail ? `${percent} · ${detail}` : percent)
    this.setData(panel, `${key}-detail`, '')
    const value = panel.querySelector(`[data-meter="${key}"]`)
    value?.classList.toggle('tfs-disabled-value', disabled)
    value?.classList.toggle('tfs-meter-no-detail', !detail)
  }

  private setText (panel: HTMLElement, selector: string, value: string): void {
    const node = panel.querySelector(selector)
    if (node) {
      node.textContent = value
    }
  }

  private setBar (panel: HTMLElement, key: string, value: number): void {
    const node = panel.querySelector(`[data-bar="${key}"]`) as HTMLElement | null
    if (node) {
      node.style.width = `${Math.max(0, Math.min(100, value))}%`
    }
  }

  private setStatus (panel: HTMLElement): void {
    panel.querySelector('.tfs-dot')?.classList.remove('on')
  }

  private escape (value: string): string {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    }[c] ?? c))
  }

  private shellQuote (value: string): string {
    return `'${String(value).replace(/'/g, "'\\''")}'`
  }

  private powershellQuote (value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`
  }

  private injectStyles (): void {
    if (document.getElementById('tabby-status-style')) {
      return
    }

    const style = document.createElement('style')
    style.id = 'tabby-status-style'
    style.textContent = `
      .tabby-status-layout,
      .tfs-detail-backdrop,
      .tfs-context-menu,
      .tfs-iface-menu {
        --tfs-bg: var(--theme-background, var(--terminal-background, #1f272a));
        --tfs-surface: color-mix(in srgb, var(--tfs-bg) 92%, var(--tfs-text-primary) 8%);
        --tfs-surface-strong: color-mix(in srgb, var(--tfs-bg) 84%, var(--tfs-text-primary) 16%);
        --tfs-border: color-mix(in srgb, var(--tfs-text-primary) 16%, transparent);
        --tfs-muted: color-mix(in srgb, var(--tfs-text-primary) 62%, transparent);
        --tfs-faint: color-mix(in srgb, var(--tfs-text-primary) 38%, transparent);
        --tfs-text-primary: var(--theme-foreground, var(--terminal-foreground, #d7dee0));
        --tfs-accent: var(--theme-color, #7fc8ff);
      }
      .tabby-status-layout {
        position: relative !important;
        box-sizing: border-box !important;
        --tfs-panel-width: 320px;
        --tfs-panel-rail-width: 32px;
        --tfs-panel-active-width: var(--tfs-panel-width);
        --tfs-content-margin: max(0px, 30px * var(--spaciness) - 15px);
        transition: none !important;
        animation: none !important;
      }
      .tabby-status-layout.tabby-status-collapsed {
        --tfs-panel-active-width: var(--tfs-panel-rail-width);
      }
      .tabby-status {
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        width: var(--tfs-panel-active-width);
        z-index: 20;
        overflow: visible;
        background: var(--tfs-bg);
        color: var(--tfs-text-primary);
        border-left: 1px solid var(--tfs-border);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        font-size: 13px;
        line-height: 1.28;
        box-sizing: border-box;
        scrollbar-width: none;
      }
      .tfs-panel-body {
        position: absolute;
        inset: 0;
        min-width: var(--tfs-panel-width);
        overflow: auto;
        scrollbar-width: none;
        transition: none;
      }
      .tfs-panel-body::-webkit-scrollbar { display: none; }
      .tabby-status-layout.tabby-status-collapsed .tfs-panel-body {
        opacity: 0;
        pointer-events: none;
        transform: translateX(-8px);
      }
      .tabby-status-layout.tfs-panel-toggling .tabby-status {
        transition: width 200ms ease-out, background-color 160ms ease-out, border-color 160ms ease-out;
      }
      .tabby-status-layout.tfs-panel-toggling .tfs-panel-body {
        transition: opacity 150ms ease-out, transform 200ms ease-out;
      }
      .tabby-status-layout.tfs-panel-toggling .content {
        transition: margin 200ms ease-out !important;
      }
      .tabby-status-layout.tfs-panel-toggling sftp-panel {
        transition: left 200ms ease-out, width 200ms ease-out !important;
      }
      .tabby-status-layout .content {
        margin: var(--tfs-content-margin) var(--tfs-content-margin) var(--tfs-content-margin) calc(var(--tfs-panel-active-width) + var(--tfs-content-margin)) !important;
      }
      .tabby-status-layout sftp-panel {
        left: var(--tfs-panel-active-width) !important;
        width: calc(100% - var(--tfs-panel-active-width)) !important;
      }
      .tabby-status::-webkit-scrollbar { display: none; }
      .tfs-resizer { position: absolute; top: 0; right: 0; bottom: 0; width: 8px; cursor: ew-resize; z-index: 30; }
      .tfs-resizer::after { content: ""; position: absolute; top: 0; right: 2px; bottom: 0; width: 1px; background: color-mix(in srgb, var(--tfs-accent) 22%, transparent); }
      .tfs-resizer:hover::after, .tfs-resizing .tfs-resizer::after { width: 2px; background: color-mix(in srgb, var(--tfs-accent) 72%, transparent); }
      .tabby-status-layout.tabby-status-collapsed .tfs-resizer { display: none; }
      .tfs-collapse-toggle {
        position: absolute;
        top: 9px;
        right: 10px;
        width: 22px;
        height: 22px;
        display: grid;
        place-items: center;
        border: 1px solid transparent;
        border-radius: 7px;
        background: transparent;
        color: var(--tfs-muted);
        box-shadow: none;
        box-sizing: border-box;
        cursor: pointer;
        z-index: 42;
        opacity: .72;
        padding: 0;
        transition: background-color 140ms ease-out, border-color 140ms ease-out, color 140ms ease-out, opacity 140ms ease-out;
      }
      .tfs-collapse-toggle:hover {
        opacity: 1;
        color: var(--tfs-text-primary);
        border-color: var(--tfs-border);
        background: color-mix(in srgb, var(--tfs-text-primary) 8%, transparent);
      }
      .tfs-collapse-toggle:focus-visible {
        outline: 1px solid color-mix(in srgb, var(--tfs-accent) 72%, transparent);
        outline-offset: 2px;
      }
      .tfs-collapse-icon {
        width: 7px;
        height: 7px;
        border-top: 2px solid currentColor;
        border-right: 2px solid currentColor;
        transform: translateX(1px) rotate(225deg);
        transition: transform 160ms ease-out;
      }
      .tabby-status-layout.tabby-status-collapsed .tfs-collapse-toggle {
        top: 6px;
        left: 5px;
        right: auto;
        width: 22px;
        height: 22px;
        border: 1px solid transparent;
        border-radius: 7px;
        background: transparent;
        color: var(--tfs-muted);
        opacity: 1;
      }
      .tabby-status-layout.tabby-status-collapsed .tfs-collapse-toggle:hover {
        color: var(--tfs-text-primary);
        border-color: var(--tfs-border);
        background: color-mix(in srgb, var(--tfs-text-primary) 8%, transparent);
      }
      .tabby-status-layout.tabby-status-collapsed .tfs-collapse-icon {
        width: 8px;
        height: 8px;
        border-width: 2px;
        opacity: .8;
        transform: translateX(-1px) rotate(45deg);
      }
      .tfs-resizing { cursor: ew-resize !important; user-select: none !important; }
      .tabby-status .tfs-nowrap,
      .tabby-status .tfs-top span,
      .tabby-status .tfs-ip span,
      .tabby-status .tfs-ip em,
      .tabby-status .tfs-ip strong,
      .tabby-status .tfs-ip button,
      .tabby-status .tfs-kv span,
      .tabby-status .tfs-kv b,
      .tabby-status .tfs-meter span,
      .tabby-status .tfs-meter b,
      .tabby-status .tfs-section,
      .tabby-status .tfs-tabs span,
      .tabby-status .tfs-chart b,
      .tabby-status .tfs-chart strong,
      .tabby-status th,
      .tabby-status td { white-space: nowrap; min-width: 0; }
      .tfs-top, .tfs-ip, .tfs-kv { display: flex; align-items: center; gap: 8px; padding: 5px 10px; }
      .tfs-top { font-size: 15px; font-weight: 700; padding-top: 10px; padding-right: 38px; }
      .tfs-dot { width: 8px; height: 8px; border-radius: 50%; background: #6f777a; display: inline-block; }
      .tfs-dot.on { background: #31c66b; box-shadow: 0 0 8px rgba(49,198,107,.5); }
      .tfs-ip { color: var(--tfs-muted); }
      .tfs-ip em { color: var(--tfs-accent); font-style: normal; font-size: 12px; font-weight: 700; }
      .tfs-ip strong { flex: 1; font-weight: 600; color: var(--tfs-text-primary); overflow: hidden; text-overflow: ellipsis; }
      .tfs-ip button { border: 0; background: transparent; color: var(--tfs-muted); font-size: 12px; cursor: pointer; }
      .tfs-ip button.tfs-copy-ok { color: #4fd17f; }
      .tfs-ip button.tfs-copy-fail { color: #ff8b65; }
      .tfs-kv span, .tfs-meter span { color: var(--tfs-muted); }
      .tfs-kv span { width: 34px; }
      .tfs-kv b { font-weight: 500; color: var(--tfs-text-primary); }
      .tfs-meter { display: grid; grid-template-columns: 42px minmax(0, 1fr); align-items: center; column-gap: 8px; padding: 3px 10px; }
      .tfs-meter span { overflow: hidden; text-overflow: ellipsis; }
      .tfs-meter i { position: relative; height: 15px; border-radius: 999px; background: color-mix(in srgb, var(--tfs-text-primary) 13%, transparent); overflow: hidden; }
      .tfs-meter em { position: absolute; inset: 0 auto 0 0; display: block; height: 100%; background: linear-gradient(90deg, #5fb3ff, #31c66b); opacity: .95; }
      .tfs-meter b { text-align: right; color: var(--tfs-text-primary) !important; opacity: 1; font-weight: 600; font-size: 11px; line-height: 15px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tfs-meter-value { position: absolute; inset: 0 8px 0 8px; z-index: 1; display: grid; grid-template-columns: 1fr; align-items: center; color: var(--tfs-text-primary) !important; opacity: 1; text-shadow: none; }
      .tfs-meter-value span:first-child { text-align: right; color: var(--tfs-text-primary) !important; opacity: 1; }
      .tfs-meter-value span:last-child { display: none; text-align: right; overflow: hidden; text-overflow: ellipsis; }
      .tfs-meter-value.tfs-meter-no-detail { grid-template-columns: 1fr; }
      .tfs-meter b.tfs-disabled-value { color: var(--tfs-text-primary) !important; opacity: 1; font-weight: 600; }
      .tfs-section { margin: 10px 10px 5px; color: var(--tfs-accent); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; }
      .tfs-clickable { cursor: pointer; }
      .tfs-clickable:hover { background: color-mix(in srgb, var(--tfs-accent) 8%, transparent); }
      .tfs-tabs, .tfs-processes div { --tfs-proc-columns: 56px 56px minmax(0, 1fr); }
      .tfs-tabs { display: grid; grid-template-columns: var(--tfs-proc-columns); column-gap: 8px; color: var(--tfs-muted); border-top: 1px solid var(--tfs-border); border-bottom: 1px solid var(--tfs-border); margin: 0 10px; }
      .tfs-tabs button, .tfs-tabs span { padding: 4px 0; font-size: 11px; text-align: left; min-width: 0; }
      .tfs-tabs button { border: 0; background: transparent; color: inherit; font-family: inherit; font-size: 11px; line-height: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
      .tfs-tabs button:hover, .tfs-tabs button.tfs-sort-active { color: var(--tfs-text-primary); }
      .tfs-tabs button.tfs-sort-active { font-weight: 700; }
      .tfs-tabs button[data-dir="desc"]::after { content: "↓"; color: var(--tfs-accent); font-size: 10px; }
      .tfs-tabs button[data-dir="asc"]::after { content: "↑"; color: var(--tfs-accent); font-size: 10px; }
      .tfs-tabs button:nth-child(1), .tfs-tabs button:nth-child(2), .tfs-processes span:nth-child(1), .tfs-processes span:nth-child(2) { text-align: left; }
      .tfs-processes { height: 110px; overflow-y: auto; overflow-x: hidden; font-size: 12px; margin: 0 10px; scrollbar-width: none; }
      .tfs-processes::-webkit-scrollbar { display: none; }
      .tfs-processes div { display: grid; grid-template-columns: var(--tfs-proc-columns); padding: 3px 0; white-space: nowrap; overflow: hidden; border-bottom: 1px solid var(--tfs-border); column-gap: 8px; }
      .tfs-processes span { overflow: hidden; text-overflow: ellipsis; min-width: 0; color: var(--tfs-text-primary); opacity: 1; }
      .tfs-processes span:nth-child(1), .tfs-processes span:nth-child(2) { font-variant-numeric: tabular-nums; }
      .tfs-chart { padding: 4px 10px; border-bottom: 1px solid var(--tfs-border); }
      .tfs-chart-head { display: grid; align-items: center; gap: 12px; overflow: hidden; }
      .tfs-net-head { grid-template-columns: max-content max-content minmax(52px, 1fr) minmax(32px, 64px); }
      .tfs-lat-head { grid-template-columns: max-content minmax(64px, 1fr); }
      .tfs-chart b { font-weight: 700; color: #4fd17f; font-size: 12px; }
      .tfs-chart b:first-child { color: #ff8b65; }
      .tfs-chart strong { font-weight: 500; color: var(--tfs-text-primary); overflow: hidden; text-overflow: ellipsis; text-align: right; }
      .tfs-chart-head button[data-action="iface-picker"] { border: 0; background: transparent; color: var(--tfs-text-primary); padding: 0; font: inherit; font-weight: 500; overflow: hidden; text-overflow: ellipsis; text-align: right; cursor: pointer; }
      .tfs-chart-head button[data-action="iface-picker"]:hover { color: var(--tfs-accent); }
      .tfs-chart p { height: 12px; margin: 0; border-top: 1px dotted var(--tfs-border); }
      .tfs-net-bars { height: 38px; margin: 5px 0 2px; display: grid !important; grid-template-columns: repeat(24, 1fr); align-items: end; gap: 3px !important; border-top: 1px dotted var(--tfs-border); border-bottom: 1px dotted var(--tfs-border); }
      .tfs-net-bars span { height: 30px; display: flex; align-items: end; justify-content: center; gap: 1px; }
      .tfs-net-bars i { width: 3px; min-height: 2px; border-radius: 2px 2px 0 0; opacity: .9; }
      .tfs-net-bars .tx { background: #ff8b65; }
      .tfs-net-bars .rx { background: #4fd17f; }
      .tfs-lat b:first-child { color: var(--tfs-accent); }
      .tfs-latency-bars { height: 34px; margin: 5px 0 2px; display: grid !important; grid-template-columns: repeat(24, 1fr); align-items: end; gap: 3px !important; border-top: 1px dotted var(--tfs-border); border-bottom: 1px dotted var(--tfs-border); }
      .tfs-latency-bars span { display: block; min-height: 2px; border-radius: 2px 2px 0 0; background: var(--tfs-accent); opacity: .9; }
      .tfs-idle { opacity: .42; }
      .tabby-status table { width: calc(100% - 20px); margin: 0 10px 10px; border-collapse: collapse; table-layout: fixed; }
      .tabby-status th { border-bottom: 1px solid var(--tfs-border); padding: 5px 4px; font-weight: 600; color: var(--tfs-muted); }
      .tabby-status th:last-child { text-align: right; }
      .tabby-status td { position: relative; padding: 3px 5px; color: var(--tfs-text-primary); opacity: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tabby-status tr:nth-child(even) td { background: color-mix(in srgb, var(--tfs-text-primary) 4%, transparent); }
      .tabby-status td:first-child { width: 62%; }
      .tabby-status td:last-child { text-align: right; }
      .tabby-status td:last-child i { position: absolute; top: 0; right: 0; bottom: 0; background: color-mix(in srgb, #31c66b 22%, transparent); z-index: 0; }
      .tabby-status td:last-child span { position: relative; z-index: 1; }
      .tfs-detail-backdrop { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--tfs-bg) 72%, transparent); color: var(--tfs-text-primary); }
      .tfs-detail-dialog { width: min(980px, calc(100vw - 56px)); height: min(680px, calc(100vh - 56px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid color-mix(in srgb, var(--tfs-accent) 28%, transparent); background: var(--tfs-surface); color: var(--tfs-text-primary); box-shadow: 0 18px 60px rgba(0,0,0,.42); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 12px; }
      .tfs-detail-top { display: grid; grid-template-columns: max-content 1fr max-content; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--tfs-border); }
      .tfs-detail-title { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
      .tfs-detail-top strong { font-size: 14px; color: var(--tfs-text-primary); }
      .tfs-detail-top span { color: var(--tfs-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tfs-detail-top button { border: 1px solid var(--tfs-border); background: color-mix(in srgb, var(--tfs-text-primary) 7%, transparent); color: var(--tfs-text-primary); padding: 4px 10px; font: inherit; cursor: pointer; }
      .tfs-detail-top .tfs-detail-icon-button { width: 18px; height: 18px; display: inline-grid; place-items: center; padding: 0; border-radius: 4px; background: transparent; }
      .tfs-detail-pause-icon { width: 10px; height: 10px; position: relative; display: block; }
      .tfs-detail-pause-icon::before,
      .tfs-detail-pause-icon::after { content: ""; position: absolute; top: 1px; bottom: 1px; width: 3px; border-radius: 1px; background: currentColor; }
      .tfs-detail-pause-icon::before { left: 1px; }
      .tfs-detail-pause-icon::after { right: 1px; }
      .tfs-detail-top button.tfs-detail-paused { border-color: color-mix(in srgb, var(--tfs-accent) 42%, transparent); background: color-mix(in srgb, var(--tfs-accent) 12%, transparent); color: var(--tfs-text-primary); }
      .tfs-detail-top button.tfs-detail-paused .tfs-detail-pause-icon::before { top: 1px; left: 3px; bottom: auto; width: 0; height: 0; border-radius: 0; background: transparent; border-top: 4px solid transparent; border-bottom: 4px solid transparent; border-left: 7px solid currentColor; }
      .tfs-detail-top button.tfs-detail-paused .tfs-detail-pause-icon::after { display: none; }
      .tfs-detail-body { flex: 1; overflow: auto; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--tfs-accent) 42%, transparent) color-mix(in srgb, var(--tfs-text-primary) 7%, transparent); }
      .tfs-detail-body::-webkit-scrollbar { width: 8px; height: 8px; }
      .tfs-detail-body::-webkit-scrollbar-track { background: color-mix(in srgb, var(--tfs-text-primary) 7%, transparent); }
      .tfs-detail-body::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--tfs-accent) 42%, transparent); border-radius: 8px; }
      .tfs-detail-body::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--tfs-accent) 62%, transparent); }
      .tfs-detail-table { border-collapse: collapse; table-layout: fixed; }
      .tfs-detail-table th, .tfs-detail-table td { padding: 7px 8px; border-bottom: 1px solid var(--tfs-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; }
      .tfs-detail-table th { position: sticky; top: 0; z-index: 1; background: var(--tfs-surface-strong); color: var(--tfs-muted); font-weight: 600; }
      .tfs-detail-table th.tfs-resizable-col { position: sticky; }
      .tfs-detail-table td { color: var(--tfs-text-primary); font-variant-numeric: tabular-nums; }
      .tfs-detail-table tr:nth-child(even) td { background: color-mix(in srgb, var(--tfs-text-primary) 3%, transparent); }
      .tfs-detail-table th button { border: 0; background: transparent; color: inherit; padding: 0; font: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
      .tfs-detail-table th button:hover, .tfs-detail-table th button.tfs-sort-active { color: var(--tfs-text-primary); }
      .tfs-detail-table th button[data-dir="desc"]::after { content: "↓"; color: var(--tfs-accent); font-size: 10px; }
      .tfs-detail-table th button[data-dir="asc"]::after { content: "↑"; color: var(--tfs-accent); font-size: 10px; }
      .tfs-detail-empty-row td { height: 34px; color: transparent; }
      .tfs-detail-empty-row:nth-child(even) td { background: color-mix(in srgb, var(--tfs-text-primary) 2%, transparent) !important; }
      .tfs-detail-skeleton { display: block; height: 10px; border-radius: 2px; background: linear-gradient(90deg, color-mix(in srgb, var(--tfs-muted) 28%, transparent), color-mix(in srgb, var(--tfs-accent) 18%, transparent)); opacity: .72; }
      .tfs-col-resizer { position: absolute; top: 0; right: 0; bottom: 0; width: 8px; cursor: col-resize; }
      .tfs-col-resizer::after { content: ""; position: absolute; top: 6px; right: 3px; bottom: 6px; width: 1px; background: color-mix(in srgb, var(--tfs-accent) 24%, transparent); }
      .tfs-col-resizer:hover::after, .tfs-col-resizing .tfs-col-resizer::after { background: color-mix(in srgb, var(--tfs-accent) 72%, transparent); }
      .tfs-col-resizing { cursor: col-resize !important; user-select: none !important; }
      .tfs-context-menu { position: fixed; z-index: 10000; min-width: 132px; padding: 5px; border: 1px solid color-mix(in srgb, var(--tfs-accent) 28%, transparent); background: var(--tfs-surface); color: var(--tfs-text-primary); box-shadow: 0 12px 32px rgba(0,0,0,.38); }
      .tfs-context-menu button { display: block; width: 100%; border: 0; background: transparent; color: var(--tfs-text-primary); padding: 6px 9px; text-align: left; font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; cursor: pointer; }
      .tfs-context-menu button:hover { background: color-mix(in srgb, var(--tfs-accent) 12%, transparent); color: var(--tfs-text-primary); }
      .tfs-iface-menu { position: fixed; z-index: 10000; min-width: 140px; max-width: 180px; max-height: 260px; overflow: auto; padding: 5px; border: 1px solid color-mix(in srgb, var(--tfs-accent) 28%, transparent); background: var(--tfs-surface); color: var(--tfs-text-primary); box-shadow: 0 12px 32px rgba(0,0,0,.38); scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--tfs-accent) 42%, transparent) color-mix(in srgb, var(--tfs-text-primary) 7%, transparent); }
      .tfs-iface-menu button { display: block; width: 100%; border: 0; background: transparent; color: var(--tfs-text-primary); padding: 6px 9px; text-align: left; font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tfs-iface-menu button:hover, .tfs-iface-menu button.active { background: color-mix(in srgb, var(--tfs-accent) 12%, transparent); color: var(--tfs-text-primary); }
    `
    document.head.appendChild(style)
  }
}

@NgModule({
  imports: [
    TabbyCoreModule,
  ],
  providers: [
    { provide: TerminalDecorator, useClass: TabbyStatusDecorator, multi: true },
  ],
})
export default class TabbyStatusModule {}
