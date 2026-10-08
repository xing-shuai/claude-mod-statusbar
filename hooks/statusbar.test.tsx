import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { STRINGS, cols, loadOff, partsSummary, statusRuns, statusText } from './register'
import type { Figures } from './register'

const NOW = Date.parse('2026-10-02T00:00:00Z')
const BASE: Figures = { model: null, effort: null, dir: null, branch: null }
const FULL: Figures = {
  model: 'claude-opus-5-5[1m]', effort: 'high', dir: '~/x', branch: 'develop',
  ctxPct: 62, ctxTokens: 620_000, ctxWindow: 1_000_000,
  fiveHour: { pct: 30, resetsAt: '2026-10-02T02:15:00Z' }, week: { pct: 91, resetsAt: '2026-10-04T05:00:00Z' }, costUsd: 1.5,
}

describe('line', () => {
  test('only the context placeholder before the first response', async () => {
    expect(statusText(BASE, NOW)).toBe('◧ —')
  })
  test('an estimate stands in for the context figure until a response reports one, marked as one', async () => {
    expect(statusText({ ...BASE, ctxWindow: 1_000_000, ctxEstTokens: 44_300 }, NOW)).toBe('◧ ▱▱▱▱▱▱▱▱ ~4% 44k/1M')
    expect(statusText({ ...BASE, ctxWindow: 1_000_000, ctxEstTokens: 44_300 }, NOW, 12)).toBe('◧ ~4%')
    expect(statusText({ ...FULL, ctxEstTokens: 44_300 }, NOW, 12)).toBe('◧ 62%') // a reported figure wins
  })
  test('every figure on one line when there is room', async () => {
    expect(statusText(FULL, NOW)).toBe('Opus 5.5 (1M)  high  ◧ ▰▰▰▰▰▱▱▱ 62% 620k/1M  ◷ 30% ↻ 2h15m  ▦ 91% ↻ 2d5h  ⎇ develop  $1.50  ~/x')
  })
  test('a narrower terminal drops details and the lesser parts first, the context last', async () => {
    expect(statusText(FULL, NOW, 80)).toBe('Opus 5.5 (1M)  high  ◧ ▰▰▰▰▰▱▱▱ 62% 620k/1M  ◷ 30%  ▦ 91%  ⎇ develop  $1.50')
    expect(statusText(FULL, NOW, 56)).toBe('Opus 5.5 (1M)  ◧ ▰▰▰▰▰▱▱▱ 62%  ◷ 30%  ▦ 91%  ⎇ develop')
    expect(statusText(FULL, NOW, 40)).toBe('Opus 5.5 (1M)  ◧ 62%  ◷ 30%  ▦ 91%')
    expect(statusText(FULL, NOW, 12)).toBe('◧ 62%')
    for (let budget = 5; budget <= 120; budget++) expect(cols(statusText(FULL, NOW, budget))).toBeLessThanOrEqual(budget)
  })
  test('a part turned off is left out at any width', async () => {
    expect(statusText(FULL, NOW, Infinity, new Set(['effort', 'dir', '7d'] as const))).toBe('Opus 5.5 (1M)  ◧ ▰▰▰▰▰▱▱▱ 62% 620k/1M  ◷ 30% ↻ 2h15m  ⎇ develop  $1.50')
    expect(statusRuns(FULL, NOW, Infinity, loadOff(['model', 'effort', 'ctx', '5h', '7d', 'branch', 'cost', 'dir']))).toEqual([])
  })
  test('stored parts: names it does not know are ignored', async () => {
    expect([...loadOff(['dir', 'weather', 7])]).toEqual(['dir'])
    expect([...loadOff('dir')]).toEqual([])
    expect(partsSummary(loadOff(['dir', 'cost']))).toBe('Showing: model, effort, ctx, 5h, 7d, branch. Off: cost, dir.')
  })
  test('the colors are theme keys: the accent, then warning and error past the thresholds', async () => {
    const run = (f: Figures, text: string) => statusRuns(f, NOW).find(r => r.text === text)
    expect(run(FULL, 'Opus 5.5 (1M)')).toEqual({ text: 'Opus 5.5 (1M)', color: 'claude', bold: true })
    expect(run(FULL, '▰▰▰▰▰')?.color).toBe('warning') // 62% of the context
    expect(run(FULL, '▱▱▱')?.color).toBe('subtle')
    expect(run(FULL, '62%')).toMatchObject({ color: 'warning', bold: true })
    expect(run({ ...FULL, ctxPct: 20 }, '▰▰')?.color).toBe('claude')
    expect(run({ ...FULL, ctxPct: 85 }, '85%')?.color).toBe('error')
    expect(run(FULL, '30%')?.color).toBeUndefined() // 30% of the 5h limit: plain text
    expect(run(FULL, '91%')?.color).toBe('error')
    expect(run(FULL, '⎇ develop')?.color).toBe('suggestion')
    expect(run(FULL, '$1.50')?.color).toBe('success')
    expect(run(FULL, '◷ ')?.dim).toBe(true) // an icon is drawn as the label it replaces was
  })
})

const HINT = { plugin: 'statusbar', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never

// The world beneath a started session: the engine's hint line as a Text, the store in `stored`.
const MEASURED = { startedAt: 0, context: { window: 1_000_000, tokens: 420_000, percent: 42 }, rateLimits: [] }
const startSession = async ($: { session: { start: (e: never) => Promise<unknown> } }, on: On, stored: Record<string, unknown> = {}, usage: () => unknown = () => MEASURED) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  on('store.get', ($, e) => ({ value: stored[e.key] }) as never)
  on('store.set', ($, e) => {
    stored[e.key] = e.value
    return { value: undefined } as never
  })
  on('command.register', () => ({ value: { command: 'statusbar' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: usage() }) as never)
  on('session.cwd', () => ({ value: '/home/u/r' }))
  on('session.repo', () => ({ value: { root: '/home/u/r' } }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'PromptHint' }, $ => {
    const { Text } = ($ as { ui: { resolve: (e: unknown) => { Text: (p: object) => unknown } } }).ui.resolve({ surface: 'terminal', component: 'PromptHint' })
    return h(Text as never, {}, 'ENGINE HINT') as never
  })
  await $.session.start({ cwd: '/home/u/r', surface: null, isInteractive: true } as never)
  await clock.advance(0) // the directory and branch are read off the start's path
  return clock
}

// The status line as drawn: the texts of its runs, in order, or undefined when only the hint line shows.
const lineOf = async (ui: { findAll: (q: never) => Promise<{ text?: string }[]> }) => {
  const texts = (await ui.findAll({ type: 'Text' } as never)).map(t => t.text ?? '')
  return texts.find(t => t.includes('◧'))
}

test('the status line is a row under the engine\'s hint line, which stays', async ($, on) => {
  await startSession($, on)
  const ui = await $.ui.mount(HINT)
  expect(await ui.find({ type: 'Text', text: /ENGINE HINT/ })).toBeDefined()
  expect(await lineOf(ui)).toBe('Opus 5.5  ◧ ▰▰▰▱▱▱▱▱ 42% 420k/1M  ⎇ main  ~/r')
  await ui.unmount()
})

test('/statusbar leaves the hint line alone and a second run brings the status line back', async ($, on) => {
  await startSession($, on)
  const ui = await $.ui.mount(HINT)
  expect(await $.command.run({ command: 'statusbar', args: '' } as never)).toMatchObject({ text: STRINGS.hidden })
  expect(await lineOf(ui)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /ENGINE HINT/ })).toBeDefined()
  expect(await $.command.run({ command: 'statusbar', args: '' } as never)).toMatchObject({ text: STRINGS.shown })
  expect(await lineOf(ui)).toContain('42%')
  await ui.unmount()
})

test('a line hidden in an earlier session stays hidden', async ($, on) => {
  await startSession($, on, { hidden: true })
  const ui = await $.ui.mount(HINT)
  expect(await lineOf(ui)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /ENGINE HINT/ })).toBeDefined()
  await ui.unmount()
})

test('/statusbar <part> turns one part off and on, and the choice is stored', async ($, on) => {
  const stored: Record<string, unknown> = { off: ['dir'] }
  await startSession($, on, stored)
  const ui = await $.ui.mount(HINT)
  expect(await lineOf(ui)).toBe('Opus 5.5  ◧ ▰▰▰▱▱▱▱▱ 42% 420k/1M  ⎇ main')
  expect(await $.command.run({ command: 'statusbar', args: ' Branch ' } as never)).toMatchObject({ text: 'branch off. Showing: model, effort, ctx, 5h, 7d, cost. Off: branch, dir.' })
  expect(await lineOf(ui)).toBe('Opus 5.5  ◧ ▰▰▰▱▱▱▱▱ 42% 420k/1M')
  expect(stored.off).toEqual(['dir', 'branch'])
  await $.command.run({ command: 'statusbar', args: 'dir' } as never)
  expect(await lineOf(ui)).toBe('Opus 5.5  ◧ ▰▰▰▱▱▱▱▱ 42% 420k/1M  ~/r')
  await ui.unmount()
})

test('/statusbar with a word it does not know says what it takes and changes nothing', async ($, on) => {
  const stored: Record<string, unknown> = {}
  await startSession($, on, stored)
  expect(await $.command.run({ command: 'statusbar', args: 'help' } as never)).toMatchObject({ text: `${STRINGS.usage} Showing: model, effort, ctx, 5h, 7d, branch, cost, dir.` })
  expect(stored).toEqual({})
})

const SUMMARY = { role: 'user', text: 'summary', toolUses: [] }

test('after a compaction the figure goes, and the engine\'s estimate stands in once the conversation is in place', async ($, on) => {
  let usage: unknown = MEASURED
  on('session.compact', () => ({ messages: [SUMMARY], tokensBefore: 420_000, tokensAfter: 17_000 }) as never)
  const clock = await startSession($, on, {}, () => usage)
  const ui = await $.ui.mount(HINT)
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] } as never)
  expect(await lineOf(ui)).toBe('Opus 5.5  ◧ —  ⎇ main  ~/r')
  await clock.advance(1000) // the engine still answers with the response's figure: no estimate of the old window
  expect(await lineOf(ui)).toBe('Opus 5.5  ◧ —  ⎇ main  ~/r')
  usage = { startedAt: 0, context: { window: 1_000_000, breakdown: { totalTokens: 44_300 } }, rateLimits: [] }
  await clock.advance(30_000)
  expect(await lineOf(ui)).toBe('Opus 5.5  ◧ ▱▱▱▱▱▱▱▱ ~4% 44k/1M  ⎇ main  ~/r')
  await ui.unmount()
})

test('a new session shows the estimate before its first response', async ($, on) => {
  await startSession($, on, {}, () => ({ startedAt: 0, context: { window: 200_000, breakdown: { totalTokens: 21_400 } }, rateLimits: [] }))
  const ui = await $.ui.mount(HINT)
  expect(await lineOf(ui)).toBe('Opus 5.5  ◧ ▰▱▱▱▱▱▱▱ ~11% 21k/200k  ⎇ main  ~/r')
  await ui.unmount()
})
