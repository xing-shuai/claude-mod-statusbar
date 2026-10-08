// statusbar: claude-statuspane's figures as one colored line under the prompt's hint line.
// The helpers cols, fit, shortDir, clean, fmtEta, gauge, prettyModel and fromUsage come from
// claude-statuspane (https://github.com/xuanji86/claude-statuspane, MIT, © 2026 Anji Xu; see LICENSE).
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

export type Limit = { pct: number; resetsAt?: string }
export type Figures = {
  model: string | null; effort: string | null; dir: string | null; branch: string | null
  ctxPct?: number; ctxTokens?: number; ctxWindow?: number
  ctxEstTokens?: number // the engine's own estimate, as /context counts: what stands in while no response has reported the fill
  fiveHour?: Limit; week?: Limit; costUsd?: number
}

const EMPTY: Figures = { model: null, effort: null, dir: null, branch: null }
const SEP = '  ' // each part opens with its icon or reads as a word of its own: no mark between them
// What stands for a part's name: the context window as far as it is filled, the 5-hour and the weekly limit.
const ICONS = { ctx: '◧', '5h': '◷', '7d': '▦' } as const
const PENDING = '—'
const CTX_GAUGE = 8 // cells of the context gauge
// Past these a figure takes the theme's warning color, then its error color: statuspane's thresholds.
const CTX_WARN = 50
const CTX_HIGH = 80
const LIMIT_WARN = 60
const LIMIT_HIGH = 85
const DEFAULT_COLUMNS = 120 // where the surface has not measured
const MARGIN = 4 // the hint line's own indent, and a spare column or two
const REFRESH_MS = 30_000 // the branch may have moved, and the reset countdowns count down
const SETTLE_MS = 1000 // after a compaction, until the engine has the compacted conversation in place

export const STRINGS = {
  hidden: 'Status line hidden.', shown: 'Status line shown.',
  usage: '/statusbar hides or shows the line; /statusbar <part> turns one part off or on.',
  stillHidden: 'The line itself is hidden: /statusbar shows it.',
} as const

// Emoji below the emoji block that terminals draw two columns wide (East Asian Width W): ⌛ ⚡ ✅ ❌ ⭐ …
const EMOJI_WIDE: [number, number][] = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
]

// Terminal columns a string takes: East Asian wide and fullwidth characters and emoji take two.
export const cols = (s: string) => {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd) ||
      (c >= 0x231a && c <= 0x2b55 && EMOJI_WIDE.some(([lo, hi]) => c >= lo && c <= hi))
    n += wide ? 2 : 1
  }
  return n
}

// Cut text to `max` columns, keeping its end ("…tail") or its start ("head…").
export const fit = (s: string, max: number, keep: 'end' | 'start' = 'start') => {
  if (cols(s) <= max) return s
  const chars = [...s]
  const out: string[] = []
  let n = 1 // the ellipsis
  for (const ch of keep === 'end' ? chars.reverse() : chars) {
    if (n + cols(ch) > max) break
    n += cols(ch)
    out.push(ch)
  }
  return keep === 'end' ? `…${out.reverse().join('')}` : `${out.join('')}…`
}

// A long directory keeps its last segments: "~/Desktop/a/b/project" -> "…/b/project".
export const shortDir = (dir: string, max = 24) => {
  if (cols(dir) <= max) return dir
  const segs = dir.split('/')
  let tail = segs.pop() ?? ''
  if (cols(tail) + 2 > max) return fit(tail, max, 'end')
  while (segs.length && cols(`…/${segs[segs.length - 1]}/${tail}`) <= max) tail = `${segs.pop()}/${tail}`
  return `…/${tail}`
}

// A path or a branch name is drawn as text: no control, escape, bidi or zero-width characters, bounded length.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g
export const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? [...v.replace(UNSAFE, '')].slice(0, max).join('').trim() : ''

export const fmtEta = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return ''
  const s = Math.floor((Date.parse(resetsAt) - now) / 1000)
  if (!(s > 0)) return 'now'
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d${h}h` : `${h}h${m}m`
}

// A gauge as Claude Code draws one: ▰ used, ▱ left.
export const gauge = (pct: number, width: number) => {
  const on = Math.min(width, Math.max(0, Math.round((pct * width) / 100)))
  return { on: '▰'.repeat(on), off: '▱'.repeat(width - on) }
}

// "claude-opus-5-5[1m]" -> "Opus 5.5 (1M)", "claude-opus-4-20250514" -> "Opus 4"; anything else as given.
export const prettyModel = (id: string) => {
  const m = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(id)
  if (!m || !m[1]) return id
  return `${m[1][0]?.toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' (1M)' : ''}`
}

// The usage figures, from session.measure's input or $.session.usage() alike.
export const fromUsage = (u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): Partial<Figures> => {
  const find = (kind: string) => {
    const r = u.rateLimits.find(l => l.kind === kind)
    return r ? { pct: r.percentUsed, resetsAt: r.resetsAt } : undefined
  }
  return {
    ctxPct: u.context.percent,
    ctxTokens: u.context.tokens,
    ctxWindow: u.context.window,
    fiveHour: find('five_hour'),
    week: find('seven_day'),
    costUsd: u.cost?.usd,
  }
}

// A stretch of the line in one style. `color` is a theme key, so the line follows the person's theme.
export type Run = { text: string; color?: string; dim?: boolean; bold?: boolean }

// A part of the line: its forms from widest to narrowest, each but the last with the rank at which it
// gives way to the next when the line is too wide (the lowest first). GONE as the last form: the part leaves.
type Form = { runs: Run[]; giveUp?: number }
type Seg = Form[]
const GONE: Form = { runs: [] }

// The line's parts in the order drawn, by the names `/statusbar <part>` takes.
export const PARTS = ['model', 'effort', 'ctx', '5h', '7d', 'branch', 'cost', 'dir'] as const
export type Part = (typeof PARTS)[number]
const isPart = (v: unknown): v is Part => (PARTS as readonly unknown[]).includes(v)

const dim = (text: string): Run => ({ text, dim: true })
const levelColor = (pct: number, warnAt: number, errAt: number) => (pct >= errAt ? 'error' : pct >= warnAt ? 'warning' : undefined)

const limitSeg = (icon: string, l: Limit | undefined, now: number, dropEta: number, leave: number): Seg => {
  if (!l) return [GONE]
  const eta = fmtEta(l.resetsAt, now)
  const short: Run[] = [dim(`${icon} `), { text: `${Math.round(l.pct)}%`, color: levelColor(l.pct, LIMIT_WARN, LIMIT_HIGH) }]
  return [...(eta ? [{ runs: [...short, dim(` ↻ ${eta}`)], giveUp: dropEta }] : []), { runs: short, giveUp: leave }, GONE]
}

// The context never leaves: its last form is the figure alone. Before a response has reported the fill
// (a new session, or one just compacted) the engine's estimate stands in, marked "~".
const ctxSeg = (f: Figures): Seg => {
  const est = f.ctxPct === undefined && f.ctxWindow ? f.ctxEstTokens : undefined
  const pct = f.ctxPct ?? (est !== undefined && f.ctxWindow ? (est * 100) / f.ctxWindow : undefined)
  if (pct === undefined) return [{ runs: [dim(`${ICONS.ctx} ${PENDING}`)] }]
  const used = est ?? f.ctxTokens
  const k = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
  const level = levelColor(pct, CTX_WARN, CTX_HIGH)
  const figure: Run = { text: `${est !== undefined ? '~' : ''}${Math.round(pct)}%`, color: level, bold: true }
  const g = gauge(pct, CTX_GAUGE)
  const bar: Run[] = [dim(`${ICONS.ctx} `), { text: g.on, color: level ?? 'claude' }, { text: g.off, color: 'subtle' }, { text: ' ' }, figure]
  const tokens = used !== undefined && f.ctxWindow ? [{ runs: [...bar, dim(` ${k(used)}/${k(f.ctxWindow)}`)], giveUp: 5 }] : []
  return [...tokens, { runs: bar, giveUp: 8 }, { runs: [dim(`${ICONS.ctx} `), figure] }]
}

// Pure: the line's parts in the order drawn. What goes first as the terminal narrows: the directory, the
// countdowns, the effort, the token counts, a long branch's tail, the cost, the gauge, then whole parts.
// A part the person turned off is left out whatever the width.
const segments = (f: Figures, now: number, off: ReadonlySet<Part>): Seg[] => {
  const branch = (max: number): Run[] => [{ text: `⎇ ${fit(f.branch ?? '', max)}`, color: 'suggestion' }]
  const parts: Record<Part, Seg> = {
    model: f.model ? [{ runs: [{ text: prettyModel(f.model), color: 'claude', bold: true }], giveUp: 13 }, GONE] : [GONE],
    effort: f.effort ? [{ runs: [{ text: f.effort, color: 'claude' }], giveUp: 4 }, GONE] : [GONE],
    ctx: ctxSeg(f),
    '5h': limitSeg(ICONS['5h'], f.fiveHour, now, 3, 12),
    '7d': limitSeg(ICONS['7d'], f.week, now, 2, 11),
    branch: f.branch ? [{ runs: branch(32), giveUp: 6 }, { runs: branch(16), giveUp: 9 }, GONE] : [GONE],
    cost: f.costUsd !== undefined ? [{ runs: [{ text: `$${f.costUsd.toFixed(2)}`, color: 'success' }], giveUp: 7 }, GONE] : [GONE],
    dir: f.dir ? [{ runs: [dim(shortDir(f.dir))], giveUp: 1 }, GONE] : [GONE],
  }
  return PARTS.map(p => (off.has(p) ? [GONE] : parts[p]))
}

// Stored parts over the default (all shown): a name a later version dropped is ignored.
export const loadOff = (stored: unknown): Set<Part> => new Set(Array.isArray(stored) ? stored.filter(isPart) : [])

// What `/statusbar <anything else>` answers, and what follows a part's toggle: the parts as they stand.
export const partsSummary = (off: ReadonlySet<Part>) => {
  const shown = PARTS.filter(p => !off.has(p)), gone = PARTS.filter(p => off.has(p))
  return `Showing: ${shown.join(', ') || 'nothing'}.${gone.length ? ` Off: ${gone.join(', ')}.` : ''}`
}

const width = (runs: readonly Run[]) => runs.reduce((n, r) => n + cols(r.text), 0)

// Pure: the status line's runs within `budget` columns, its parts giving way one step at a time while it is
// too wide. Narrower than the context figure alone, the drawing cuts the line at its end.
export const statusRuns = (f: Figures, now: number, budget = Infinity, off: ReadonlySet<Part> = new Set()): Run[] => {
  const segs = segments(f, now, off)
  const line = () => segs.map(s => s[0]?.runs ?? []).filter(runs => runs.length)
  const lineWidth = () => line().reduce((n, runs, i) => n + (i ? cols(SEP) : 0) + width(runs), 0)
  while (lineWidth() > budget) {
    const next = segs.filter(s => s[0]?.giveUp !== undefined).sort((a, b) => (a[0]?.giveUp ?? 0) - (b[0]?.giveUp ?? 0))[0]
    if (!next) break
    next.shift()
  }
  return line().flatMap((runs, i) => (i ? [dim(SEP), ...runs] : runs)).filter(r => r.text)
}
export const statusText = (f: Figures, now: number, budget = Infinity, off: ReadonlySet<Part> = new Set()) =>
  statusRuns(f, now, budget, off).map(r => r.text).join('')

// lazy: module state, read again from the session when a reload starts the module over.
let figures = EMPTY
let hidden = false
let off: Set<Part> = new Set()
let columns = DEFAULT_COLUMNS
let drawn: string | null = null // the line as last drawn, or asked for; null before the first

// Never rejects. Asks for the hint line again when the status line under it would read differently.
// The figures are read after the clock answers, so the paint that lands last is the newest.
async function paint($: EngineInterface) {
  try {
    const now = await $.clock.now()
    const text = hidden ? '' : statusText(figures, now, columns - MARGIN, off)
    if (text === drawn) return
    drawn = text
    $.ui.invalidate('ui.render')
  } catch {
    // keep the last line
  }
}

// Never rejects. The window's fill as /context estimates it, counted locally: no request is sent. Undefined
// where the engine gives none, and while it still holds a response's figure: the estimate would be of a
// window about to be replaced.
async function estimate($: EngineInterface) {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    return context.tokens === undefined ? context.breakdown?.totalTokens : undefined
  } catch {
    return undefined
  }
}

// Never rejects; runs off the turn's path (callers do not await it).
async function refresh($: EngineInterface) {
  try {
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    const cwd = await $.session.cwd()
    const dir = clean(home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd, 400)
    const repo = await $.session.repo()
    const b = repo ? await $.process.run(['git', 'branch', '--show-current'], { cwd, timeoutMs: 3000 }).catch(() => null) : null
    const branch = (b && b.exitCode === 0 && clean(b.stdout, 200)) || null
    figures = { ...figures, dir, branch }
  } catch {
    // keep the last directory and branch
  }
  if (figures.ctxPct === undefined) {
    const ctxEstTokens = await estimate($)
    figures = { ...figures, ctxEstTokens }
  }
  await paint($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'statusbar', description: 'Hide or show the status line under the prompt, or one part of it',
      argumentHint: `[${PARTS.join('|')}]`, immediate: true,
    })
    hidden = (await $.store.get('hidden').catch(() => false)) === true
    off = loadOff(await $.store.get('off').catch(() => undefined))
    const model = await $.session.model()
    figures = { ...figures, ...fromUsage(await $.session.usage()), model: model || null }
    $.clock.every(REFRESH_MS, () => void refresh($))
    void refresh($)
    return next(e)
  })

  // `/statusbar` hides or shows the line; `/statusbar <part>` one part of it; anything else says what it takes.
  on('command.run', { command: 'statusbar' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (!arg) {
      hidden = !hidden
      await $.store.set('hidden', hidden)
      await paint($)
      return { text: hidden ? STRINGS.hidden : STRINGS.shown }
    }
    if (!isPart(arg)) return { text: `${STRINGS.usage} ${partsSummary(off)}` }
    const changed = new Set(off)
    if (!changed.delete(arg)) changed.add(arg)
    off = changed
    await $.store.set('off', [...off])
    await paint($)
    return { text: `${arg} ${off.has(arg) ? 'off' : 'on'}. ${partsSummary(off)}${hidden ? ` ${STRINGS.stillHidden}` : ''}` }
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      figures = { ...figures, model: e.model, effort: e.effort === undefined ? null : String(e.effort) }
      void paint($)
    }
    return yield* next(e)
  })

  on('session.measure', async ($, e, next) => {
    figures = { ...figures, ...fromUsage(e) }
    void paint($)
    return next(e)
  })

  // A compaction empties the live window, and no measurement follows until the next response: the figure
  // goes, and the engine's estimate of the compacted conversation stands in once that is in place.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.trigger !== 'precompute' && !result.skip) {
      figures = { ...figures, ctxPct: undefined, ctxTokens: undefined, ctxEstTokens: undefined }
      void paint($)
      $.clock.after(SETTLE_MS, () => void refresh($))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) void refresh($) // the branch may have moved; subagents' turns leave it be
    return result
  })

  // The hint line under the prompt (`? for shortcuts`, the permission mode) stays as the engine draws it;
  // the status line is a row of its own beneath it. Hidden, or with every part off, the hint line alone.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const hint = await next(e)
    if (e.surface !== 'terminal') return hint
    columns = e.viewport?.columns ?? columns
    const runs = hidden ? [] : statusRuns(figures, await $.clock.now(), columns - MARGIN, off)
    drawn = runs.map(r => r.text).join('')
    if (!runs.length) return hint
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {hint}
        <Text wrap="truncate-end">
          {runs.map(r => <Text color={r.color} dimColor={r.dim} bold={r.bold}>{r.text}</Text>)}
        </Text>
      </Box>
    )
  })
}
