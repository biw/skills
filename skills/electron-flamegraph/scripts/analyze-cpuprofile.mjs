#!/usr/bin/env node
// Parse a V8 .cpuprofile (as written by --cpu-prof or the inspector Profiler domain)
// and surface hot functions, irregular sampling gaps, and common perf anti-patterns.
//
// Usage: node analyze-cpuprofile.mjs <path> [--top=N] [--sampling-gap-threshold-ms=N] [--json]

import { readFileSync } from 'node:fs'
import { argv, exit, stdout } from 'node:process'

// --- argv parsing -----------------------------------------------------------

const [, , profilePath, ...flags] = argv
if (!profilePath) {
  console.error('usage: analyze-cpuprofile.mjs <path-to-cpuprofile> [--top=N] [--sampling-gap-threshold-ms=N] [--json]')
  exit(1)
}

const flagVal = (name, fallback) => {
  const f = flags.find((x) => x.startsWith(`${name}=`))
  return f ? Number(f.split('=')[1]) : fallback
}
const topN = flagVal('--top', 20)
const samplingGapMs = flagVal(
  '--sampling-gap-threshold-ms',
  flagVal('--stall-threshold-ms', 50),
)
const asJson = flags.includes('--json')

// --- load -------------------------------------------------------------------

let raw
try {
  raw = readFileSync(profilePath, 'utf8')
} catch (err) {
  console.error(`could not read ${profilePath}: ${err.message}`)
  exit(1)
}

let profile
try {
  profile = JSON.parse(raw)
} catch (err) {
  console.error(`${profilePath} is not valid JSON: ${err.message}`)
  exit(1)
}

if (!profile.nodes || !profile.samples || !profile.timeDeltas) {
  console.error(`${profilePath} does not look like a V8 cpuprofile (missing nodes/samples/timeDeltas)`)
  exit(1)
}

const { nodes, samples, timeDeltas, startTime = 0, endTime = 0 } = profile

// Build id -> node index and parent map
const byId = new Map(nodes.map((n) => [n.id, n]))
const parentOf = new Map()
for (const n of nodes) {
  for (const childId of n.children ?? []) parentOf.set(childId, n.id)
}

// --- frame classification ---------------------------------------------------

// V8 synthetic nodes: (root), (program), (idle), (garbage collector), (no samples)
const isSynthetic = (frame) => frame.url === '' && /^\(.+\)$/.test(frame.functionName || '')
const isGC = (frame) => frame.functionName === '(garbage collector)'
const isIdle = (frame) => frame.functionName === '(idle)'
const isProgram = (frame) => frame.functionName === '(program)'
const isRoot = (frame) => frame.functionName === '(root)'
const isNodeBuiltin = (frame) => typeof frame.url === 'string' && frame.url.startsWith('node:')
const isNodeModule = (frame) => typeof frame.url === 'string' && frame.url.includes('/node_modules/')
const isUserCode = (frame) =>
  typeof frame.url === 'string' && frame.url.length > 0 && !isNodeBuiltin(frame) && !isNodeModule(frame)

const shortenUrl = (url) => {
  if (!url) return ''
  const stripped = url.replace(/^file:\/\//, '')
  const parts = stripped.split('/')
  return parts.slice(-2).join('/')
}

const labelNode = (node) => {
  const f = node.callFrame
  const name = f.functionName || '(anonymous)'
  if (isSynthetic(f)) return name
  if (!f.url) return name
  const line = typeof f.lineNumber === 'number' ? f.lineNumber + 1 : '?'
  return `${name}  ${shortenUrl(f.url)}:${line}`
}

// --- time accounting --------------------------------------------------------

// timeDeltas[i] is the time between sample[i-1] and sample[i], in microseconds.
// Attribute each delta to the node that samples[i] points to (self time).
// Clamp negatives (V8 occasionally emits them on clock skew).
const selfTimeUs = new Map()
let totalSampledUs = 0
for (let i = 0; i < samples.length; i++) {
  const id = samples[i]
  const dt = Math.max(0, timeDeltas[i] ?? 0)
  selfTimeUs.set(id, (selfTimeUs.get(id) ?? 0) + dt)
  totalSampledUs += dt
}

// Total time per node: self + sum of descendants' self. Compute bottom-up with memoization.
const totalTimeUs = new Map()
const visiting = new Set()
const computeTotal = (id) => {
  if (totalTimeUs.has(id)) return totalTimeUs.get(id)
  if (visiting.has(id)) return 0 // cycle guard; shouldn't happen in well-formed profiles
  visiting.add(id)
  const node = byId.get(id)
  let total = selfTimeUs.get(id) ?? 0
  for (const childId of node?.children ?? []) total += computeTotal(childId)
  visiting.delete(id)
  totalTimeUs.set(id, total)
  return total
}
for (const n of nodes) computeTotal(n.id)

// --- category aggregation --------------------------------------------------

const categorize = (frame) => {
  if (isIdle(frame)) return 'idle'
  if (isGC(frame)) return 'gc'
  if (isProgram(frame) || isRoot(frame)) return 'root'
  if (isSynthetic(frame)) return 'native'
  if (isNodeBuiltin(frame)) return 'builtin'
  if (isNodeModule(frame)) return 'node_modules'
  if (isUserCode(frame)) return 'user'
  return 'unknown'
}

const categorySelfUs = {
  user: 0,
  node_modules: 0,
  builtin: 0,
  native: 0,
  gc: 0,
  idle: 0,
  root: 0,
  unknown: 0,
}
for (const n of nodes) {
  categorySelfUs[categorize(n.callFrame)] += selfTimeUs.get(n.id) ?? 0
}

// --- sampling-gap detection -------------------------------------------------

// timeDeltas describe intervals between adjacent profiler samples. A large
// interval can come from scheduling, profiler behavior, process suspension, or
// workload behavior; it does not by itself prove that the event loop was
// blocked. Surface these as capture-quality evidence without attributing the
// full interval to the sample that follows it.
const samplingGapThresholdUs = samplingGapMs * 1000
const samplingGaps = []
for (let i = 0; i < samples.length; i++) {
  const dt = timeDeltas[i] ?? 0
  if (dt >= samplingGapThresholdUs) {
    samplingGaps.push({ sampleIdx: i, nodeId: samples[i], durationUs: dt })
  }
}
samplingGaps.sort((a, b) => b.durationUs - a.durationUs)

// Build a call stack (leaf -> root) for a node id
const stackFor = (leafId) => {
  const stack = []
  let cur = leafId
  const seen = new Set()
  while (cur != null && !seen.has(cur)) {
    seen.add(cur)
    const node = byId.get(cur)
    if (!node) break
    stack.push(node)
    cur = parentOf.get(cur)
  }
  return stack
}

// --- heuristic warnings -----------------------------------------------------

// Sum self time of all nodes whose callFrame matches a predicate.
const sumWhere = (pred) => {
  let t = 0
  for (const n of nodes) if (pred(n.callFrame)) t += selfTimeUs.get(n.id) ?? 0
  return t
}

const nameMatches = (re) => (f) => re.test(f.functionName || '')
const urlMatches = (re) => (f) => re.test(f.url || '')

const warnings = []
const addWarning = (level, message) => warnings.push({ level, message })

// Idle percentage — high idle means the capture does not show sustained CPU work.
const idlePct = totalSampledUs > 0 ? (categorySelfUs.idle / totalSampledUs) * 100 : 0
if (idlePct > 70 && samplingGaps.length === 0) {
  addWarning(
    'info',
    `${idlePct.toFixed(0)}% of sampled time was (idle) with no large sampling gaps. The profile does not show sustained main-process CPU work; use tracing or event-loop delay instrumentation before concluding where a responsiveness problem lives.`,
  )
}

// Sync fs
const syncFsUs = sumWhere(nameMatches(/^(readFileSync|writeFileSync|existsSync|statSync|readdirSync|mkdirSync|unlinkSync)$/))
if (syncFsUs > totalSampledUs * 0.02) {
  addWarning('high', `Synchronous fs calls account for ${(syncFsUs / 1000).toFixed(0)}ms — move to async equivalents, especially on the hot path.`)
}

// JSON
const jsonParseUs = sumWhere((f) => /^JSON\.parse$/.test(f.functionName || ''))
const jsonStringifyUs = sumWhere((f) => f.functionName === 'stringify' && /json/i.test(f.url || ''))
  + sumWhere((f) => /^JSON\.stringify$/.test(f.functionName || ''))
if (jsonParseUs > totalSampledUs * 0.05) {
  addWarning('medium', `JSON.parse ~${(jsonParseUs / 1000).toFixed(0)}ms (${((jsonParseUs / totalSampledUs) * 100).toFixed(1)}%). Consider smaller payloads, streaming parser, or binary format.`)
}
if (jsonStringifyUs > totalSampledUs * 0.05) {
  addWarning('medium', `JSON.stringify ~${(jsonStringifyUs / 1000).toFixed(0)}ms (${((jsonStringifyUs / totalSampledUs) * 100).toFixed(1)}%). Likely serializing too-large objects across IPC or to disk.`)
}

// Module loading (startup-ish)
const moduleLoadUs = sumWhere(nameMatches(/^(compile|_compile|_load|_resolveFilename|_findPath)$/))
if (moduleLoadUs > totalSampledUs * 0.15) {
  addWarning('medium', `Module loading ~${(moduleLoadUs / 1000).toFixed(0)}ms (${((moduleLoadUs / totalSampledUs) * 100).toFixed(1)}%). If this isn't a startup profile, something is require()-ing on the hot path — lazy-load or precompile.`)
}

// GC pressure
const gcPct = totalSampledUs > 0 ? (categorySelfUs.gc / totalSampledUs) * 100 : 0
if (gcPct > 5) {
  addWarning('medium', `Garbage collector took ${gcPct.toFixed(1)}% of sampled time. Allocation-heavy hot path — look for per-call object/array/string creation in loops.`)
}

// Native-heavy profile (often libSQL, Prisma engine IPC, N-API addons)
const nativePct = totalSampledUs > 0 ? (categorySelfUs.native / totalSampledUs) * 100 : 0
if (nativePct > 25) {
  addWarning(
    'info',
    `${nativePct.toFixed(0)}% of time is in (native) frames — likely a native addon, FFI call, or V8 builtin. JS-level optimization won't help; call the native thing less or ask for less data.`,
  )
}

// Buffer / crypto hot paths
const cryptoUs = sumWhere(urlMatches(/node:(crypto|zlib)/))
if (cryptoUs > totalSampledUs * 0.1) {
  addWarning('medium', `crypto/zlib ~${(cryptoUs / 1000).toFixed(0)}ms (${((cryptoUs / totalSampledUs) * 100).toFixed(1)}%). Candidate for offloading to a worker thread.`)
}

// --- output -----------------------------------------------------------------

const fmtMs = (us) => `${(us / 1000).toFixed(1)}ms`
const pct = (us) => (totalSampledUs > 0 ? `${((us / totalSampledUs) * 100).toFixed(1)}%` : '0.0%')

if (asJson) {
  const topSelf = [...selfTimeUs.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, topN)
    .map(([id, us]) => ({ id, selfUs: us, label: labelNode(byId.get(id)) }))
  const topTotal = [...totalTimeUs.entries()]
    .filter(([id]) => {
      const n = byId.get(id)
      return n && !isRoot(n.callFrame) && !isProgram(n.callFrame) && !isIdle(n.callFrame)
    })
    .sort(([, a], [, b]) => b - a)
    .slice(0, topN)
    .map(([id, us]) => ({ id, totalUs: us, label: labelNode(byId.get(id)) }))
  stdout.write(
    JSON.stringify(
      {
        profilePath,
        durationMs: (endTime - startTime) / 1000,
        sampledMs: totalSampledUs / 1000,
        sampleCount: samples.length,
        categories: Object.fromEntries(
          Object.entries(categorySelfUs).map(([k, v]) => [k, { us: v, pct: totalSampledUs ? (v / totalSampledUs) * 100 : 0 }]),
        ),
        topSelf,
        topTotal,
        samplingGaps: samplingGaps.slice(0, 20).map((gap) => ({
          durationUs: gap.durationUs,
          sampleAfterGap: stackFor(gap.nodeId).map(labelNode),
        })),
        warnings,
      },
      null,
      2,
    ) + '\n',
  )
  exit(0)
}

// Human-readable report

console.log(`\n=== CPU Profile Analysis ===`)
console.log(`File:            ${profilePath}`)
if (startTime || endTime) {
  console.log(`Wall duration:   ${fmtMs(endTime - startTime)}`)
}
console.log(`Sampled time:    ${fmtMs(totalSampledUs)} across ${samples.length} samples`)
console.log(`Sample interval: ~${samples.length > 0 ? (totalSampledUs / samples.length).toFixed(0) : '?'}μs avg`)

console.log(`\n--- Time distribution (self time) ---`)
const catOrder = ['user', 'node_modules', 'builtin', 'native', 'gc', 'idle', 'root', 'unknown']
for (const cat of catOrder) {
  const us = categorySelfUs[cat]
  if (us === 0 && cat !== 'idle' && cat !== 'user') continue
  console.log(`  ${cat.padEnd(14)} ${fmtMs(us).padStart(10)}  ${pct(us).padStart(7)}`)
}

console.log(`\n--- Top ${topN} functions by SELF time ---`)
const bySelf = [...selfTimeUs.entries()].sort(([, a], [, b]) => b - a).slice(0, topN)
for (const [id, us] of bySelf) {
  const node = byId.get(id)
  if (!node) continue
  console.log(`  ${fmtMs(us).padStart(10)}  ${pct(us).padStart(7)}  ${labelNode(node)}`)
}

console.log(`\n--- Top ${topN} functions by TOTAL time (self + callees) ---`)
const byTotal = [...totalTimeUs.entries()]
  .filter(([id]) => {
    const n = byId.get(id)
    return n && !isRoot(n.callFrame) && !isProgram(n.callFrame) && !isIdle(n.callFrame)
  })
  .sort(([, a], [, b]) => b - a)
  .slice(0, topN)
for (const [id, us] of byTotal) {
  const node = byId.get(id)
  if (!node) continue
  console.log(`  ${fmtMs(us).padStart(10)}  ${pct(us).padStart(7)}  ${labelNode(node)}`)
}

console.log(`\n--- Large sampling gaps (intervals >= ${samplingGapMs}ms) ---`)
if (samplingGaps.length === 0) {
  console.log(`  None detected. This does not prove the event loop remained responsive; CPU profiles do not directly measure event-loop delay.`)
} else {
  console.log(`  ${samplingGaps.length} gap(s). Showing top ${Math.min(10, samplingGaps.length)}. A gap is not proof of a main-thread stall.\n`)
  for (const gap of samplingGaps.slice(0, 10)) {
    const stack = stackFor(gap.nodeId)
    console.log(`  ${fmtMs(gap.durationUs)} sampling gap — sample after gap: ${stack[0] ? labelNode(stack[0]) : '(unknown)'}`)
    for (const frame of stack.slice(1, 6)) {
      console.log(`      ← ${labelNode(frame)}`)
    }
    if (stack.length > 6) console.log(`      ← ... (${stack.length - 6} more frames)`)
    console.log('')
  }
}

console.log(`--- Heuristic warnings ---`)
if (warnings.length === 0) {
  console.log(`  None.`)
} else {
  const icon = { high: '!!', medium: ' !', info: ' i' }
  for (const w of warnings) console.log(`  ${icon[w.level] ?? '  '} ${w.message}`)
}

console.log(`\nTip: Open the .cpuprofile in Chrome DevTools (chrome://inspect → Open dedicated DevTools → Performance → Load profile) or in VS Code for an interactive flamegraph.`)
