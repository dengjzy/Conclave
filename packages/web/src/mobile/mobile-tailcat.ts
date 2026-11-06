import type { MobileTunnel } from './mobile-platform'
declare global {
  var Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> }
  var tailcatDial: (options: { addr: string; port: number }) => Promise<MobileTunnel>
  var onTailcatReady: (() => void) | undefined
}

let runtime: Promise<void> | undefined

export function loadTailcatRuntime(wasmUrl = '/assets/main.wasm.gz'): Promise<void> {
  runtime ??= (async () => {
    if (!globalThis.Go) await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = '/assets/wasm_exec.js'
      script.onload = () => resolve()
      script.onerror = () => { script.remove(); reject(new Error('网络组件下载失败，请重试')) }
      document.head.append(script)
    })
    const go = new Go()
    let timer: ReturnType<typeof setTimeout> | undefined
    const ready = new Promise<void>((resolve) => { globalThis.onTailcatReady = resolve })
    try {
      const response = await fetch(wasmUrl, { signal: AbortSignal.timeout(120000) })
      if (!response.ok) throw new Error('网络组件下载失败，请重试')
      const bytes = new Uint8Array(await response.arrayBuffer())
      const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b
      if (compressed && typeof DecompressionStream === 'undefined') throw new Error('请更新 Safari 或 Chrome 后重试')
      const wasm = compressed ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : bytes
      const { instance } = await WebAssembly.instantiate(wasm, go.importObject)
      void go.run(instance).catch(() => {})
      await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('网络组件启动超时')), 30000) })])
    } finally { clearTimeout(timer) }
  })().catch((error: unknown) => { runtime = undefined; throw error })
  return runtime
}


export function dialTailcat(options: { addr: string; port: number }): Promise<MobileTunnel> {
  return globalThis.tailcatDial(options)
}
