import { useId, useRef, useState } from 'react'
import { useBackgroundRest } from '../background-rest'
import { petBits } from '../pet-bits'
import type { Mood, PetLevel } from '../pet-brain'
import type { Say } from '../pet-stage-api'
import { setPreference, usePreferences } from '../preferences'
import { usePetSkin } from './PetSprite'
import { PetStylePicker } from './PetSettings'
import { useReducedMotion } from '../reduced-motion'
import { PalettePicker } from './PalettePicker'
import { PetStage, type PetStageHandle } from './PetStage'
import type { PetPose } from './pet-skin'
import { Segmented } from './SettingsControls'
import './pet-playground.css'

// A room to watch the pet in: a mock of the window with the lines it walks and the things it must
// keep off, and every pose, bit and mood on a button. Opened with #pet-playground; the settings
// page will embed a small one. It is the real stage with a stand-in for the app.

const POSES: PetPose[] = ['idle', 'running', 'waiting', 'review', 'failed', 'waving', 'jumping', 'nap', 'sit', 'hang', 'peek', 'sprint']
const MOODS: { value: Mood; label: string }[] = [
  { value: 'idle', label: '没事' }, { value: 'running', label: '在跑' }, { value: 'waiting', label: '等你' }, { value: 'review', label: '没看' }, { value: 'failed', label: '出错' }
]
// The bits one can ask for by hand; the urges and the hold are the stage's own business.
const BITS = petBits().map((bit) => bit.id).filter((bit) => !['speak', 'yield', 'flee', 'greet', 'hold'].includes(bit))
const LEVELS: { value: PetLevel; label: string }[] = [
  { value: 'off', label: '关' }, { value: 'quiet', label: '安静' }, { value: 'medium', label: '适中' }, { value: 'lively', label: '活泼' }
]

export function PetPlayground() {
  const stage = useRef<PetStageHandle>(null)
  const card = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  const level = usePreferences((s) => s.petLevel)
  const setLevel = (value: PetLevel) => setPreference('petLevel', value)
  const style = usePreferences((s) => s.petStyle)
  const size = usePreferences((s) => s.petSize)
  const skin = usePetSkin(style, size)
  const [mood, setMood] = useState<Mood>('idle')
  const [reduced, setReduced] = useState(false)
  const systemReduced = useReducedMotion()
  const [browser, setBrowser] = useState(false)
  const [message, setMessage] = useState<Say | null>(null)
  const [note, setNote] = useState('')
  const theme = usePreferences((s) => s.theme)
  const resting = useBackgroundRest((s) => s.resting)
  const themeId = useId()
  const paletteId = useId()
  const levelId = useId()
  const moodId = useId()
  const styleId = useId()

  const rectOf = (element: HTMLElement | null) => {
    if (!element) return null
    const box = element.getBoundingClientRect()
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
  }
  const sayAt = (key: string, text: string, element: HTMLElement | null, holdMs: number | null) => {
    setMessage({ key: `${key}:${Date.now()}`, text, anchor: () => rectOf(element), open: () => setNote(`点了「${text}」`), holdMs })
  }

  return (
    <main className="pet-playground" data-reduced={reduced || undefined}>
      <section className="pg-window" aria-label="模拟窗口">
        <aside className="pg-sidebar" data-pet-perch="wall" data-pet-anchor="sidebar">
          <div className="pg-brand">Conclave</div>
          <div className="pg-nav">总览</div>
          <div className="pg-nav">收件箱</div>
          <div className="pg-group">会话</div>
          <div className="pg-row" data-pet-perch="ledge">修复登录页的闪烁</div>
          <div className="pg-row" data-pet-perch="ledge">导出报表加筛选</div>
          <div className="pg-row" data-pet-perch="ledge">整理 README</div>
        </aside>
        <div className="pg-main">
          <header className="pg-header" data-pet-perch="ledge">修复登录页的闪烁 <span>Claude Code · 进行中</span></header>
          <div className="pg-content">
            <div className="pg-card" data-pet-perch="ledge" ref={card}>
              <strong>子 Agent · 调查样式</strong>
              <p>正在读 <code>login.css</code>，找出触发重绘的属性。这是一段可以选中的文字，选中后蚂蚁会让开。</p>
            </div>
            <div className="pg-card" data-pet-perch="ledge">
              <strong>工具调用 · 读取文件</strong>
              <p>src/pages/login.tsx</p>
            </div>
            {browser && <div className="pg-browser browser-stage" data-pet-perch="ledge"><span>内置浏览器（原生视图，蚂蚁不能走上来）</span></div>}
          </div>
          <div className="pg-dock" data-pet-perch="ledge" data-pet-anchor="composer" ref={dock}>
            <textarea placeholder="在这里打字，蚂蚁会让开…" rows={2} />
          </div>
        </div>
        <footer className="pg-statusbar" data-pet-perch="ledge">
          <span>main</span><span className="pg-usage">Claude 5h 42% · 周 18%</span>
        </footer>
        <PetStage ref={stage} skin={skin} level={level} mood={mood} message={message} reduced={reduced || systemReduced} />
      </section>

      <aside className="pg-controls">
        <h1>小蚂蚁游乐场</h1>
        <p className="pg-hint">{resting ? '窗口在后台，动作已暂停。' : note || '把鼠标凑近它、停在它身上、点它、拖它试试。'}</p>
        <h2 id={styleId}>宠物风格</h2>
        <PetStylePicker labelId={styleId} />

        <h2 id={levelId}>档位</h2>
        <Segmented labelId={levelId} value={level} options={LEVELS} onChange={setLevel} />

        <h2 id={moodId}>心情（跟着 Agent 走）</h2>
        <Segmented labelId={moodId} value={mood} options={MOODS} onChange={setMood} />

        <h2>姿势</h2>
        <div className="pg-gallery" aria-label="全部姿势">
          {POSES.map((pose) => (
            <figure key={pose}>
              <div className="pg-gallery-ant" style={{ width: 72, height: 72 }}>{skin.render({ pose, walking: pose === 'sprint', lookX: 0, lookY: 0, reduced: reduced || systemReduced })}</div>
              <figcaption>{pose}</figcaption>
            </figure>
          ))}
        </div>
        <div className="pg-buttons">
          {POSES.map((pose) => <button key={pose} type="button" className="button" onClick={() => { stage.current?.interrupt(); stage.current?.pose(pose) }}>{pose}</button>)}
        </div>

        <h2>段子</h2>
        <div className="pg-buttons">
          {BITS.map((bit) => <button key={bit} type="button" className="button" onClick={() => stage.current?.play(bit)}>{bit}</button>)}
        </div>

        <h2>说话</h2>
        <div className="pg-buttons">
          <button type="button" className="button" onClick={() => sayAt('awaiting', '「修复登录页的闪烁」在等你回答', card.current, null)}>等你回答 → 卡片</button>
          <button type="button" className="button" onClick={() => sayAt('composer', '这条会话的 Agent 在等你', dock.current, 12_000)}>提醒 → 输入框</button>
          <button type="button" className="button" onClick={() => sayAt('quota', 'Claude 的 5 小时额度照这个速度会在重置前用完。', document.querySelector('.pg-usage'), 12_000)}>额度 → 状态栏</button>
          <button type="button" className="button" onClick={() => setMessage(null)}>收起</button>
        </div>

        <h2>环境</h2>
        <div className="pg-buttons">
          <button type="button" className="button" aria-pressed={reduced} onClick={() => setReduced((value) => !value)}>减少动态效果</button>
          <button type="button" className="button" aria-pressed={browser} onClick={() => setBrowser((value) => !value)}>内置浏览器</button>
          <button type="button" className="button" onClick={() => stage.current?.interrupt()}>打断</button>
        </div>
        <div className="pg-appearance">
          <span id={themeId} className="visually-hidden">主题</span>
          <Segmented labelId={themeId} value={theme} onChange={(value) => setPreference('theme', value)} options={[{ value: 'system', label: '系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} />
          <span id={paletteId} className="visually-hidden">配色</span><PalettePicker labelId={paletteId} />
        </div>
      </aside>
    </main>
  )
}
