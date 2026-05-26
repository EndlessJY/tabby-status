import { Injectable, NgModule } from '@angular/core'
import TabbyCoreModule from 'tabby-core'
import { TerminalDecorator, BaseTerminalTabComponent } from 'tabby-terminal'

type DiskRow = {
  path: string
  used: string
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
  ip: string
  latency: string
  loss: string
  location: string
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

type DetailModalState = {
  kind: DetailKind
  modal: HTMLElement
  body: HTMLElement
  title: HTMLElement
  status: HTMLElement
  timer?: number
  inflight: boolean
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

@Injectable()
export class TabbyStatusDecorator extends TerminalDecorator {
  private readonly panelWidthStorageKey = 'tabby-status-width'
  private readonly minPanelWidth = 260
  private readonly maxPanelWidth = 560
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

  attach (terminal: BaseTerminalTabComponent<any>): void {
    super.attach(terminal)
    // Keep this visible for every terminal tab. Data collection is still harmless
    // on local shells and makes plugin loading immediately obvious.
    console.info('[tabby-status] decorator attached', terminal.profile)

    const panel = this.createPanel()
    this.bindProcessSorting(terminal, panel)
    this.bindDetailEntrypoints(terminal, panel)
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
    host?.classList.remove('tabby-status-host')
    host?.style.removeProperty('--tfs-panel-width')
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
    this.closeDetailModal(terminal)
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
      this.cpuSnapshots.delete(terminal)
      this.netSnapshots.delete(terminal)
      this.netHistory.delete(terminal)
      this.latencyHistory.delete(terminal)
    }

    const fastLaunch = () => {
      if (this.collectorGenerations.get(terminal) === generation) {
        void this.collectViaSshExec(terminal, 'fast', this.fastCollectorExecCommand(), generation)
      }
    }
    const processLaunch = () => {
      if (this.collectorGenerations.get(terminal) === generation) {
        void this.collectViaSshExec(terminal, 'process', this.processCollectorExecCommand(), generation)
      }
    }
    const slowLaunch = () => {
      if (this.collectorGenerations.get(terminal) === generation) {
        void this.collectViaSshExec(terminal, 'slow', this.slowCollectorExecCommand(), generation)
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
      this.setStatus(panel, kind, '等待 SSH')
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
        this.setStatus(panel, kind, `采集失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      inflight.delete(kind)
    }
  }

  private async runSshExec (ssh: any, command: string): Promise<string> {
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
        const timeout = window.setTimeout(() => reject(new Error('timeout')), 8000)
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

  private fastCollectorExecCommand (): string {
    const script = String.raw`now_ms() { perl -MTime::HiRes=time -e 'printf "%.0f", time()*1000' 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || printf "%s000" "$(date +%s)"; }
ts=$(now_ms)
os=$(uname -s 2>/dev/null)
if [ "$os" = "Darwin" ]; then
  load=$(uptime 2>/dev/null | awk -F'load averages?: ' '{print $2}' | awk -F', ' '{print $1", "$2", "$3}')
  cpu=$(top -l 1 -n 0 2>/dev/null | awk '/CPU usage/ {for(i=1;i<=NF;i++){if($i=="user,") user=$(i-1); if($i=="sys,") sys=$(i-1)} gsub("%","",user); gsub("%","",sys); printf "%d", user+sys}')
  cpuCores=$(sysctl -n hw.ncpu 2>/dev/null)
  mem=$(vm_stat 2>/dev/null | awk -v total="$(sysctl -n hw.memsize 2>/dev/null)" '/page size of/{page=$8; gsub(/\./,"",page)} /Pages active/{active=$3; gsub(/\./,"",active)} /Pages wired down/{wired=$4; gsub(/\./,"",wired)} /Pages occupied by compressor/{comp=$5; gsub(/\./,"",comp)} END{used=(active+wired+comp)*page; if(total>0) printf "%d|%.1fG|%.1fG|0|0M|0M", used*100/total, used/1073741824, total/1073741824; else printf "0|0G|0G|0|0M|0M"}')
  iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')
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
  iface=$(ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="dev"){print $(i+1);exit}}')
  [ -z "$iface" ] && iface=$(ls /sys/class/net 2>/dev/null | grep -v lo | head -1)
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
printf 'latency\t%s\n' "$lat"
`
    return this.encodeShellScript(script)
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

  private slowCollectorExecCommand (): string {
    const script = String.raw`os=$(uname -s 2>/dev/null)
publicIp=""
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
for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com https://checkip.amazonaws.com; do
  [ -n "$publicIp" ] && break
  publicIp=$(fetch_public_ip "$url")
  case "$publicIp" in *.*) ;; *) publicIp="" ;; esac
done
ipaddr="$publicIp"
[ -z "$ipaddr" ] && ipaddr="$localIp"
printf 'ip\t%s\n' "$ipaddr"
printf 'publicIp\t%s\n' "$publicIp"
printf 'localIp\t%s\n' "$localIp"
printf 'uptime\t%s\n' "$up"
df -P -h 2>/dev/null | awk 'NR>1{gsub("%","",$5); printf "disk\t%s\t%s\t%s\t%s\n", $6,$3,$2,$5}' | head -40
`
    return this.encodeShellScript(script)
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
      <div class="tfs-top"><span>系统监控</span><span class="tfs-dot"></span></div>
      <div class="tfs-ip"><span>IP</span><em data-k="ip-type">-</em><strong>等待连接</strong><button>复制</button></div>
      <div class="tfs-status" data-k="status"></div>
      <div class="tfs-kv"><span>运行</span><b data-k="uptime">-</b></div>
      <div class="tfs-kv"><span>负载</span><b data-k="load">-</b></div>
      <div class="tfs-meter"><span>CPU</span><i><em data-bar="cpu"></em></i><b class="tfs-meter-value" data-meter="cpu"><span data-k="cpu-pct"></span><span data-k="cpu-detail"></span></b></div>
      <div class="tfs-meter"><span>内存</span><i><em data-bar="mem"></em></i><b class="tfs-meter-value" data-meter="mem"><span data-k="mem-pct">-</span><span data-k="mem-detail"></span></b></div>
      <div class="tfs-meter"><span>交换</span><i><em data-bar="swap"></em></i><b class="tfs-meter-value" data-meter="swap"><span data-k="swap-pct">-</span><span data-k="swap-detail"></span></b></div>
      <div class="tfs-section tfs-clickable" data-open-detail="process" title="打开进程详情">进程</div>
      <div class="tfs-tabs"><button type="button" data-sort="mem" aria-pressed="false" title="按内存排序">内存</button><button type="button" data-sort="cpu" aria-pressed="false" title="按 CPU 排序">CPU</button><span>命令</span></div>
      <div class="tfs-processes tfs-clickable" data-open-detail="process" data-k="processes" title="打开进程详情"></div>
      <div class="tfs-section tfs-clickable" data-open-detail="network" title="打开网络详情">网络</div>
      <div class="tfs-chart tfs-clickable" data-open-detail="network" title="打开网络详情"><div class="tfs-chart-head tfs-net-head tfs-nowrap"><b data-k="tx">0B/s</b><b data-k="rx">0B/s</b><strong data-k="net-peak">峰值 -</strong><strong data-k="iface">-</strong></div><div class="tfs-net-bars tfs-idle" data-k="net-bars"></div></div>
      <div class="tfs-chart tfs-lat tfs-clickable" data-open-detail="latency" title="打开延迟详情"><div class="tfs-chart-head tfs-lat-head tfs-nowrap"><b data-k="latency">0ms</b><strong data-k="latency-peak">延迟 -</strong></div><div class="tfs-latency-bars tfs-idle" data-k="latency-bars"></div></div>
      <div class="tfs-section">磁盘</div>
      <table><thead><tr><th>路径</th><th>可用/大小</th></tr></thead><tbody data-k="disks"></tbody></table>
      <div class="tfs-resizer" title="拖动调整面板宽度"></div>
    `

    panel.querySelector('button')?.addEventListener('click', () => {
      const ip = panel.querySelector('.tfs-ip strong')?.textContent ?? ''
      navigator.clipboard?.writeText(ip)
    })

    this.injectStyles()
    return panel
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
    modal.innerHTML = `
      <div class="tfs-detail-dialog" role="dialog" aria-modal="true">
        <div class="tfs-detail-top">
          <strong></strong>
          <span data-k="detail-status"></span>
          <button type="button" title="关闭">关闭</button>
        </div>
        <div class="tfs-detail-body"></div>
      </div>
    `

    const title = modal.querySelector('.tfs-detail-top strong') as HTMLElement
    const status = modal.querySelector('[data-k="detail-status"]') as HTMLElement
    const body = modal.querySelector('.tfs-detail-body') as HTMLElement
    title.textContent = this.getDetailTitle(kind)

    modal.addEventListener('click', event => {
      if (event.target === modal) {
        this.closeDetailModal(terminal)
      }
    })
    modal.querySelector('button')?.addEventListener('click', () => this.closeDetailModal(terminal))

    document.body.appendChild(modal)
    const state: DetailModalState = { kind, modal, body, title, status, inflight: false, networkSnapshots: kind === 'network' ? new Map() : undefined }
    this.detailModals.set(terminal, state)
    this.renderDetailShell(terminal, state)
    const refresh = () => void this.refreshDetailModal(terminal)
    state.timer = window.setInterval(refresh, 1000)
    refresh()
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
    if (!state || state.inflight) {
      return
    }

    const sshSession = (terminal as any).sshSession ?? (terminal.session as any)?.ssh
    const ssh = sshSession?.ssh
    if (!ssh?.openSessionChannel || !ssh?.activateChannel) {
      state.status.textContent = '等待 SSH'
      return
    }

    state.inflight = true
    try {
      const text = await this.runSshExec(ssh, this.detailCollectorExecCommand(state.kind))
      if (this.detailModals.get(terminal) !== state) {
        return
      }
      state.status.textContent = ''
      this.renderDetailRows(terminal, state, text)
    } catch (error) {
      if (this.detailModals.get(terminal) === state) {
        state.status.textContent = `刷新失败: ${error instanceof Error ? error.message : String(error)}`
      }
    } finally {
      state.inflight = false
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
      <table class="tfs-detail-table">
        <colgroup>${columns.map(column => `<col data-col="${column.key}"${column.width ? ` style="width:${column.width}px"` : ''}>`).join('')}</colgroup>
        <thead><tr>${columns.map(column => `<th class="tfs-resizable-col">${column.sortable ? `<button type="button" data-detail-sort="${column.key}">${this.escape(column.label)}</button>` : this.escape(column.label)}<span class="tfs-col-resizer" data-resize-col="${column.key}" title="拖动调整列宽"></span></th>`).join('')}</tr></thead>
        <tbody></tbody>
      </table>
    `

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
        const move = (moveEvent: MouseEvent) => {
          const width = Math.max(140, Math.min(720, Math.round(startWidth + moveEvent.clientX - startX)))
          col.style.width = `${width}px`
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
    }
  }

  private getDetailColumns (kind: DetailKind): Array<{ key: string, label: string, sortable: boolean, width?: number }> {
    if (kind === 'process') {
      return [
        { key: 'pid', label: 'PID', sortable: true, width: 72 },
        { key: 'user', label: '用户', sortable: true, width: 96 },
        { key: 'mem', label: '内存', sortable: true, width: 72 },
        { key: 'cpu', label: 'CPU', sortable: true, width: 72 },
        { key: 'command', label: '命令', sortable: false, width: 260 },
        { key: 'location', label: '位置', sortable: false, width: 320 },
      ]
    }
    if (kind === 'network') {
      return [
        { key: 'pid', label: 'PID', sortable: true, width: 72 },
        { key: 'name', label: '名称', sortable: true, width: 130 },
        { key: 'listenIp', label: '监听IP', sortable: true, width: 150 },
        { key: 'port', label: '端口', sortable: true, width: 82 },
        { key: 'ipCount', label: 'IP数', sortable: true, width: 76 },
        { key: 'connCount', label: '连接数', sortable: true, width: 86 },
        { key: 'upload', label: '上传', sortable: true, width: 92 },
        { key: 'download', label: '下载', sortable: true, width: 92 },
      ]
    }
    return [
      { key: 'ip', label: 'IP', sortable: false, width: 180 },
      { key: 'latency', label: '延迟', sortable: false, width: 110 },
      { key: 'loss', label: '丢包', sortable: false, width: 90 },
      { key: 'location', label: '位置', sortable: false, width: 140 },
    ]
  }

  private detailCollectorExecCommand (kind: DetailKind): string {
    if (kind === 'process') {
      return this.processDetailCollectorExecCommand()
    }
    if (kind === 'network') {
      return this.networkDetailCollectorExecCommand()
    }
    return this.latencyDetailCollectorExecCommand()
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

  private latencyDetailCollectorExecCommand (): string {
    const script = String.raw`target=1.1.1.1
if command -v traceroute >/dev/null 2>&1; then
  traceroute -n -w 1 -q 1 -m 12 "$target" 2>/dev/null | awk 'NR>1{hop=$1; ip=$2; if(ip=="*"||ip=="") {printf "ldetail\t*\t-\t100%%\t第%s跳\n", hop; next} lat=$3; loss="-"; if(lat=="*"||lat=="") lat="-"; else lat=sprintf("%.0fms", lat); printf "ldetail\t%s\t%s\t%s\t第%s跳\n", ip, lat, loss, hop}'
elif command -v tracepath >/dev/null 2>&1; then
  tracepath -n -m 12 "$target" 2>/dev/null | awk '{hop=$1; ip=$2; lat="-"; for(i=1;i<=NF;i++){if($i=="ms"){lat=sprintf("%.0fms", $(i-1))}} if(hop ~ /^[0-9]+:/){gsub(":","",hop); if(ip=="no") ip="*"; printf "ldetail\t%s\t%s\t%s\t第%s跳\n", ip, lat, ip=="*"?"100%":"-", hop}}'
else
  ping -c 4 -W 1 "$target" 2>/dev/null | awk -v target="$target" -F', ' '/packet loss/{loss=$3} /min\/avg\/max/{split($4,a,"/"); lat=sprintf("%.0fms", a[2])} END{if(loss=="") loss="100%"; if(lat=="") lat="-"; printf "ldetail\t%s\t%s\t%s\t目标\n", target, lat, loss}'
fi
`
    return this.encodeShellScript(script)
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
    body.innerHTML = rows.map(row => `
      <tr>
        <td>${this.escape(row.ip)}</td>
        <td>${this.escape(row.latency)}</td>
        <td>${this.escape(row.loss)}</td>
        <td>${this.escape(row.location)}</td>
      </tr>
    `).join('')
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
    return text.split(/\r?\n/).filter(Boolean).map(line => line.split('\t')).filter(parts => parts[0] === 'ldetail').map(parts => ({
      ip: parts[1] || '-',
      latency: parts[2] || '-',
      loss: parts[3] || '-',
      location: parts[4] || '-',
    }))
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
    const host = terminal.element?.nativeElement ?? document.body
    host.classList.add('tabby-status-host')
    this.setPanelWidth(host, this.getSavedPanelWidth())
    host.appendChild(panel)
    this.hosts.set(terminal, host)
    this.bindPanelResize(host, panel)
  }

  private bindPanelResize (host: HTMLElement, panel: HTMLElement): void {
    const handle = panel.querySelector('.tfs-resizer') as HTMLElement | null
    if (!handle) {
      return
    }

    let startX = 0
    let startWidth = 0

    const move = (event: MouseEvent) => {
      const nextWidth = this.clampPanelWidth(startWidth + event.clientX - startX)
      this.setPanelWidth(host, nextWidth)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('tfs-resizing')
      const width = this.readPanelWidth(host)
      window.localStorage?.setItem(this.panelWidthStorageKey, String(width))
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

  private getSavedPanelWidth (): number {
    return this.clampPanelWidth(Number(window.localStorage?.getItem(this.panelWidthStorageKey) || 320))
  }

  private readPanelWidth (host: HTMLElement): number {
    return this.clampPanelWidth(Number(host.style.getPropertyValue('--tfs-panel-width').replace('px', '')) || 320)
  }

  private setPanelWidth (host: HTMLElement, width: number): void {
    host.style.setProperty('--tfs-panel-width', `${this.clampPanelWidth(width)}px`)
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
      disks: this.parseDisks(raw.disks),
      processes: this.parseProcesses(raw.processes),
      latency: Number(raw.latency || 0),
    }

    panel.querySelector('.tfs-dot')?.classList.add('on')
    this.setText(panel, '.tfs-ip strong', payload.ip)
    this.setData(panel, 'ip-type', payload.ipType)
    this.setData(panel, 'status', '')
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
        const [path, used, size, pct] = parts
        disks.push([path, used, size, pct].join(','))
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
      const [path, used, size, pct] = row.split(',')
      return { path, used, size, pct: Number(pct || 0) }
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
        <td><span>${this.escape(d.used)}/${this.escape(d.size)}</span><i style="width:${Math.max(0, Math.min(100, d.pct))}%"></i></td>
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
    this.setData(panel, `${key}-pct`, percent)
    this.setData(panel, `${key}-detail`, detail)
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

  private setStatus (panel: HTMLElement, kind: CollectorKind, value: string): void {
    panel.querySelector('.tfs-dot')?.classList.remove('on')
    this.setData(panel, 'status', `${kind}: ${value}`)
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

  private injectStyles (): void {
    if (document.getElementById('tabby-status-style')) {
      return
    }

    const style = document.createElement('style')
    style.id = 'tabby-status-style'
    style.textContent = `
      .tabby-status-host {
        position: relative !important;
        box-sizing: border-box !important;
        --tfs-panel-width: 320px;
        padding-left: var(--tfs-panel-width) !important;
      }
      .tabby-status {
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        width: var(--tfs-panel-width);
        z-index: 20;
        overflow: auto;
        background: #1f272a;
        color: #d7dee0;
        border-left: 1px solid rgba(255,255,255,.12);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        font-size: 13px;
        line-height: 1.28;
        box-sizing: border-box;
        scrollbar-width: none;
      }
      .tabby-status::-webkit-scrollbar { display: none; }
      .tfs-resizer { position: absolute; top: 0; right: 0; bottom: 0; width: 8px; cursor: ew-resize; z-index: 30; }
      .tfs-resizer::after { content: ""; position: absolute; top: 0; right: 2px; bottom: 0; width: 1px; background: rgba(127,200,255,.16); }
      .tfs-resizer:hover::after, .tfs-resizing .tfs-resizer::after { width: 2px; background: rgba(127,200,255,.72); }
      .tfs-resizing { cursor: ew-resize !important; user-select: none !important; }
      .tabby-status .tfs-nowrap,
      .tabby-status .tfs-top span,
      .tabby-status .tfs-ip span,
      .tabby-status .tfs-ip em,
      .tabby-status .tfs-ip strong,
      .tabby-status .tfs-ip button,
      .tabby-status .tfs-status,
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
      .tfs-top { font-size: 15px; font-weight: 700; padding-top: 10px; }
      .tfs-dot { width: 8px; height: 8px; border-radius: 50%; background: #6f777a; display: inline-block; }
      .tfs-dot.on { background: #31c66b; box-shadow: 0 0 8px rgba(49,198,107,.5); }
      .tfs-ip { color: #aeb8bb; }
      .tfs-ip em { color: #7fc8ff; font-style: normal; font-size: 12px; font-weight: 700; }
      .tfs-ip strong { flex: 1; font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; }
      .tfs-ip button { border: 0; background: transparent; color: #8ea1a7; font-size: 12px; cursor: pointer; }
      .tfs-status { margin: -1px 10px 4px 52px; color: #8ea1a7; font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
      .tfs-kv span, .tfs-meter span { color: #91a0a5; }
      .tfs-kv span { width: 34px; }
      .tfs-kv b { font-weight: 500; color: #edf3f5; }
      .tfs-meter { display: grid; grid-template-columns: 42px minmax(148px, 1fr) max-content; align-items: center; column-gap: 8px; padding: 3px 10px; }
      .tfs-meter span { overflow: hidden; text-overflow: ellipsis; }
      .tfs-meter i { position: relative; flex: 1; height: 8px; border-radius: 999px; background: rgba(255,255,255,.12); overflow: hidden; }
      .tfs-meter em { display: block; height: 100%; background: linear-gradient(90deg, #5fb3ff, #31c66b); opacity: .95; }
      .tfs-meter b { text-align: left; color: rgba(215,222,224,.62); font-weight: 500; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tfs-meter-value { display: inline-flex; align-items: center; gap: 10px; }
      .tfs-meter-value span:first-child { text-align: left; }
      .tfs-meter-value span:last-child { text-align: left; overflow: hidden; text-overflow: ellipsis; }
      .tfs-meter-value.tfs-meter-no-detail span:last-child { display: none; }
      .tfs-meter b.tfs-disabled-value { color: rgba(215,222,224,.48); font-weight: 500; }
      .tfs-section { margin: 10px 10px 5px; color: #7fc8ff; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; }
      .tfs-clickable { cursor: pointer; }
      .tfs-clickable:hover { background: rgba(127,200,255,.06); }
      .tfs-tabs, .tfs-processes div { --tfs-proc-columns: 56px 56px minmax(0, 1fr); }
      .tfs-tabs { display: grid; grid-template-columns: var(--tfs-proc-columns); column-gap: 8px; color: #8ea1a7; border-top: 1px solid rgba(255,255,255,.08); border-bottom: 1px solid rgba(255,255,255,.08); margin: 0 10px; }
      .tfs-tabs button, .tfs-tabs span { padding: 4px 0; font-size: 11px; text-align: left; min-width: 0; }
      .tfs-tabs button { border: 0; background: transparent; color: inherit; font-family: inherit; font-size: 11px; line-height: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
      .tfs-tabs button:hover, .tfs-tabs button.tfs-sort-active { color: #d7dee0; }
      .tfs-tabs button.tfs-sort-active { font-weight: 700; }
      .tfs-tabs button[data-dir="desc"]::after { content: "↓"; color: #7fc8ff; font-size: 10px; }
      .tfs-tabs button[data-dir="asc"]::after { content: "↑"; color: #7fc8ff; font-size: 10px; }
      .tfs-tabs button:nth-child(1), .tfs-tabs button:nth-child(2), .tfs-processes span:nth-child(1), .tfs-processes span:nth-child(2) { text-align: left; }
      .tfs-processes { height: 110px; overflow-y: auto; overflow-x: hidden; font-size: 12px; margin: 0 10px; scrollbar-width: none; }
      .tfs-processes::-webkit-scrollbar { display: none; }
      .tfs-processes div { display: grid; grid-template-columns: var(--tfs-proc-columns); padding: 3px 0; white-space: nowrap; overflow: hidden; border-bottom: 1px solid rgba(255,255,255,.05); column-gap: 8px; }
      .tfs-processes span { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      .tfs-processes span:nth-child(1), .tfs-processes span:nth-child(2) { font-variant-numeric: tabular-nums; }
      .tfs-chart { padding: 4px 10px; border-bottom: 1px solid rgba(255,255,255,.08); }
      .tfs-chart-head { display: grid; align-items: center; gap: 12px; overflow: hidden; }
      .tfs-net-head { grid-template-columns: max-content max-content minmax(52px, 1fr) minmax(32px, 64px); }
      .tfs-lat-head { grid-template-columns: max-content minmax(64px, 1fr); }
      .tfs-chart b { font-weight: 700; color: #4fd17f; font-size: 12px; }
      .tfs-chart b:first-child { color: #ff8b65; }
      .tfs-chart strong { font-weight: 500; color: #d7dee0; overflow: hidden; text-overflow: ellipsis; text-align: right; }
      .tfs-chart p { height: 12px; margin: 0 0 0 42px; border-top: 1px dotted rgba(255,255,255,.18); }
      .tfs-net-bars { height: 38px; margin: 5px 0 2px 42px; display: grid !important; grid-template-columns: repeat(24, 1fr); align-items: end; gap: 3px !important; border-top: 1px dotted rgba(255,255,255,.18); border-bottom: 1px dotted rgba(255,255,255,.18); }
      .tfs-net-bars span { height: 30px; display: flex; align-items: end; justify-content: center; gap: 1px; }
      .tfs-net-bars i { width: 3px; min-height: 2px; border-radius: 2px 2px 0 0; opacity: .9; }
      .tfs-net-bars .tx { background: #ff8b65; }
      .tfs-net-bars .rx { background: #4fd17f; }
      .tfs-lat b:first-child { color: #7fc8ff; }
      .tfs-latency-bars { height: 34px; margin: 5px 0 2px 42px; display: grid !important; grid-template-columns: repeat(24, 1fr); align-items: end; gap: 3px !important; border-top: 1px dotted rgba(255,255,255,.18); border-bottom: 1px dotted rgba(255,255,255,.18); }
      .tfs-latency-bars span { display: block; min-height: 2px; border-radius: 2px 2px 0 0; background: #7fc8ff; opacity: .9; }
      .tfs-idle { opacity: .42; }
      .tabby-status table { width: calc(100% - 20px); margin: 0 10px 10px; border-collapse: collapse; table-layout: fixed; }
      .tabby-status th { border-bottom: 1px solid rgba(255,255,255,.1); padding: 5px 4px; font-weight: 600; color: #8ea1a7; }
      .tabby-status th:last-child { text-align: right; }
      .tabby-status td { position: relative; padding: 3px 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tabby-status tr:nth-child(even) td { background: rgba(255,255,255,.035); }
      .tabby-status td:first-child { width: 62%; }
      .tabby-status td:last-child { text-align: right; }
      .tabby-status td:last-child i { position: absolute; top: 0; right: 0; bottom: 0; background: rgba(49, 198, 107, .16); z-index: 0; }
      .tabby-status td:last-child span { position: relative; z-index: 1; }
      .tfs-detail-backdrop { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; background: rgba(8,12,14,.58); }
      .tfs-detail-dialog { width: min(980px, calc(100vw - 56px)); height: min(680px, calc(100vh - 56px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid rgba(127,200,255,.22); background: #1f272a; color: #d7dee0; box-shadow: 0 18px 60px rgba(0,0,0,.42); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 12px; }
      .tfs-detail-top { display: grid; grid-template-columns: max-content 1fr max-content; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.1); }
      .tfs-detail-top strong { font-size: 14px; color: #edf3f5; }
      .tfs-detail-top span { color: #8ea1a7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tfs-detail-top button { border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: #d7dee0; padding: 4px 10px; font: inherit; cursor: pointer; }
      .tfs-detail-body { flex: 1; overflow: auto; scrollbar-width: thin; scrollbar-color: rgba(127,200,255,.42) rgba(255,255,255,.06); }
      .tfs-detail-body::-webkit-scrollbar { width: 8px; height: 8px; }
      .tfs-detail-body::-webkit-scrollbar-track { background: rgba(255,255,255,.06); }
      .tfs-detail-body::-webkit-scrollbar-thumb { background: rgba(127,200,255,.42); border-radius: 8px; }
      .tfs-detail-body::-webkit-scrollbar-thumb:hover { background: rgba(127,200,255,.62); }
      .tfs-detail-table { width: max-content; min-width: 100%; border-collapse: collapse; table-layout: fixed; }
      .tfs-detail-table th, .tfs-detail-table td { padding: 7px 8px; border-bottom: 1px solid rgba(255,255,255,.07); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; }
      .tfs-detail-table th { position: sticky; top: 0; z-index: 1; background: #232c2f; color: #8ea1a7; font-weight: 600; }
      .tfs-detail-table th.tfs-resizable-col { position: sticky; }
      .tfs-detail-table td { color: #d7dee0; font-variant-numeric: tabular-nums; }
      .tfs-detail-table tr:nth-child(even) td { background: rgba(255,255,255,.025); }
      .tfs-detail-table th button { border: 0; background: transparent; color: inherit; padding: 0; font: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
      .tfs-detail-table th button:hover, .tfs-detail-table th button.tfs-sort-active { color: #edf3f5; }
      .tfs-detail-table th button[data-dir="desc"]::after { content: "↓"; color: #7fc8ff; font-size: 10px; }
      .tfs-detail-table th button[data-dir="asc"]::after { content: "↑"; color: #7fc8ff; font-size: 10px; }
      .tfs-col-resizer { position: absolute; top: 0; right: 0; bottom: 0; width: 8px; cursor: col-resize; }
      .tfs-col-resizer::after { content: ""; position: absolute; top: 6px; right: 3px; bottom: 6px; width: 1px; background: rgba(127,200,255,.2); }
      .tfs-col-resizer:hover::after, .tfs-col-resizing .tfs-col-resizer::after { background: rgba(127,200,255,.72); }
      .tfs-col-resizing { cursor: col-resize !important; user-select: none !important; }
      .tfs-context-menu { position: fixed; z-index: 10000; min-width: 132px; padding: 5px; border: 1px solid rgba(127,200,255,.24); background: #232c2f; box-shadow: 0 12px 32px rgba(0,0,0,.38); }
      .tfs-context-menu button { display: block; width: 100%; border: 0; background: transparent; color: #d7dee0; padding: 6px 9px; text-align: left; font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; cursor: pointer; }
      .tfs-context-menu button:hover { background: rgba(127,200,255,.12); color: #edf3f5; }
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
