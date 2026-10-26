import { useCallback, useEffect, useState } from 'react'
import './App.css'

type Ticker = {
  symbol: string
  lastPrice: string
  priceChangePercent: string
  quoteVolume: string
}
type Candle = { close: number; high: number; low: number; volume: number; closeTime: number }
type Signal = {
  symbol: string
  price: number
  change: number
  volume: number
  score: number
  status: string
  rsi: number
  entry: number
  stop: number
  target: number
  reasons: string[]
  updated: number
}
type PaperIdea = {
  id: number
  symbol: string
  entry: number
  stop: number
  target: number
  time: string
  quote: string
  stake: number
  feePct: number
  slippagePct: number
}

const API = 'https://data-api.binance.vision/api/v3'
const QUOTES = ['USDT', 'USDC']
const SYMBOLS_BY_QUOTE: Record<string, string[]> = {
  USDT: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'TRXUSDT'],
  USDC: ['BTCUSDC', 'ETHUSDC', 'BNBUSDC', 'SOLUSDC', 'XRPUSDC', 'ADAUSDC', 'DOGEUSDC', 'LINKUSDC'],
}
const money = (n: number, digits = 6) =>
  Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—'
const percent = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`

function estimateNet(
  idea: PaperIdea,
  exitPrice: number,
): number {
  const stake = Number.isFinite(idea.stake) ? idea.stake : 25
  const feePct = Number.isFinite(idea.feePct) ? idea.feePct : 0.1
  const slippagePct = Number.isFinite(idea.slippagePct) ? idea.slippagePct : 0.05
  if (idea.entry <= 0 || exitPrice <= 0 || stake <= 0) return NaN

  const exitValue = (stake / idea.entry) * exitPrice
  const gross = exitValue - stake
  const estimatedCosts = (stake + exitValue) * (feePct + slippagePct) / 100
  return gross - estimatedCosts
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`)
  if (!response.ok) throw new Error(`Binance market-data request failed (${response.status})`)
  return response.json() as Promise<T>
}

function ema(values: number[], period: number): number {
  if (values.length < period) return NaN
  const k = 2 / (period + 1)
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (const value of values.slice(period)) result = value * k + result * (1 - k)
  return result
}

function rsi(values: number[], period = 14): number {
  if (values.length <= period) return NaN
  let gain = 0, loss = 0
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1]
    if (diff > 0) gain += diff
    else loss -= diff
  }
  if (loss === 0) return gain === 0 ? 50 : 100
  return 100 - 100 / (1 + gain / loss)
}

async function candles(symbol: string, interval: string): Promise<Candle[]> {
  const raw = await getJson<unknown[][]>(`/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=220`)
  return raw
    .filter((row) =>
      Array.isArray(row) && row.length >= 7 &&
      [row[2], row[3], row[4], row[5], row[6]].every(
        (value) => value !== null && value !== undefined && value !== '',
      )
    )
    .map((row) => ({
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
    }))
    .filter((candle) =>
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) &&
      Number.isFinite(candle.volume) &&
      Number.isFinite(candle.closeTime) &&
      candle.closeTime < Date.now()
    )
}

async function analyze(ticker: Ticker): Promise<Signal> {
  const [fast, slow] = await Promise.all([
    candles(ticker.symbol, '15m'),
    candles(ticker.symbol, '1h'),
  ])
  const closes = fast.map((c) => c.close)
  const slowCloses = slow.map((c) => c.close)
  const price = Number(ticker.lastPrice)
  const enoughCandles = fast.length >= 200 && slow.length >= 50
  const validCandles = [...fast, ...slow].every((c) =>
    Number.isFinite(c.close) && c.close > 0 &&
    Number.isFinite(c.high) && Number.isFinite(c.low) &&
    Number.isFinite(c.volume) && c.volume >= 0 &&
    c.high >= c.low &&
    c.close >= c.low && c.close <= c.high
  )
  const ema20 = ema(closes, 20)
  const ema50 = ema(closes, 50)
  const ema200 = ema(closes, 200)
  const hourly20 = ema(slowCloses, 20)
  const hourly50 = ema(slowCloses, 50)
  const strength = rsi(closes)
  const recent = fast.slice(-21, -1)
  const resistance = Math.max(...recent.map((c) => c.high))
  const averageVolume = fast.slice(-21, -1).reduce((a, c) => a + c.volume, 0) / 20
  const latestVolume = fast.at(-1)?.volume ?? 0
  const atrRows = fast.slice(-15)
  const atr = atrRows.reduce((sum, c, i) => {
    const previous = fast[fast.length - 15 + i - 1]?.close ?? c.close
    return sum + Math.max(c.high - c.low, Math.abs(c.high - previous), Math.abs(c.low - previous))
  }, 0) / Math.max(1, atrRows.length)
  const reasons: string[] = []
  if (ema20 > ema50 && ema50 > ema200) reasons.push('15m EMA trend aligned')
  if (hourly20 > hourly50) reasons.push('1h trend confirms')
  if (strength >= 50 && strength <= 68) reasons.push('RSI in momentum range')
  if (closes.at(-1)! > resistance) reasons.push('Resistance breakout')
  if (averageVolume > 0 && latestVolume > averageVolume * 1.2) reasons.push('Volume above average')

  const score = reasons.length
  const indicatorsValid =
    Number.isFinite(price) && price > 0 &&
    Number.isFinite(ema20) && Number.isFinite(ema50) &&
    Number.isFinite(ema200) && Number.isFinite(hourly20) &&
    Number.isFinite(hourly50) && Number.isFinite(strength) &&
    Number.isFinite(resistance) && Number.isFinite(averageVolume) &&
    Number.isFinite(atr) && atr > 0
  const dataValid = enoughCandles && validCandles && indicatorsValid
  const confirmed =
    dataValid &&
    ema20 > ema50 && ema50 > ema200 &&
    hourly20 > hourly50 &&
    strength >= 50 && strength <= 68 &&
    closes.at(-1)! > resistance &&
    score >= 4 && price > ema20
  return {
    symbol: ticker.symbol,
    price,
    change: Number(ticker.priceChangePercent),
    volume: Number(ticker.quoteVolume),
    score,
    status: confirmed
      ? 'CONFIRMED SETUP'
      : dataValid && score >= 2
        ? 'WATCH'
        : 'NO TRADE',
    rsi: strength,
    entry: price,
    stop: price - atr * 1.5,
    target: price + atr * 3,
    reasons,
    updated: Date.now(),
  }
}

function App() {
  const [quote, setQuote] = useState('USDT')
  const [tickers, setTickers] = useState<Ticker[]>([])
  const [signals, setSignals] = useState<Signal[]>([])
  const [stakeInput, setStakeInput] = useState('25')
  const [feeInput, setFeeInput] = useState('0.1')
  const [slippageInput, setSlippageInput] = useState('0.05')
  const [ideas, setIdeas] = useState<PaperIdea[]>(() => {
    try {
      const saved = window.localStorage.getItem('spotb-paper-ideas-v1')
      if (!saved) return []
      const parsed: unknown = JSON.parse(saved)
      return Array.isArray(parsed) ? parsed as PaperIdea[] : []
    } catch {
      return []
    }
  })
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState('')
  const [tab, setTab] = useState<'scanner' | 'paper'>('scanner')

  const loadMarkets = useCallback(async (): Promise<Ticker[]> => {
    setLoading(true)
    setError('')
    try {
      const candidates = SYMBOLS_BY_QUOTE[quote] ?? []
      if (!candidates.length) throw new Error(`No configured market shortlist for ${quote}.`)
      const symbolsParam = encodeURIComponent(JSON.stringify(candidates))
      const [info, allTickers] = await Promise.all([
        getJson<{ symbols: { symbol: string; status: string; quoteAsset: string; isSpotTradingAllowed?: boolean }[] }>(`/exchangeInfo?symbols=${symbolsParam}`),
        getJson<Ticker[]>(`/ticker/24hr?symbols=${symbolsParam}`),
      ])
      const allowed = new Set(
        info.symbols
          .filter((s) => s.status === 'TRADING' && s.quoteAsset === quote && s.isSpotTradingAllowed !== false)
          .map((s) => s.symbol),
      )
      const selected = allTickers
        .filter((t) => allowed.has(t.symbol) && Number(t.lastPrice) > 0)
        .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
      setTickers(selected)
      setLastUpdated(new Date().toLocaleTimeString())
      if (!selected.length) setError(`No eligible ${quote} spot markets were returned.`)
      return selected
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load public market data.')
      return []
    } finally {
      setLoading(false)
    }
  }, [quote])

  const runScan = useCallback(async () => {
    setScanning(true)
    setError('')
    try {
      const marketList = tickers.length ? tickers : await loadMarkets()
      const shortlist = marketList.slice(0, 8)
      if (!shortlist.length) throw new Error('No market shortlist available. Refresh markets and retry.')
      const results = await Promise.allSettled(shortlist.map(analyze))
      const valid = results
        .filter((r): r is PromiseFulfilledResult<Signal> => r.status === 'fulfilled')
        .map((r) => r.value)
        .sort((a, b) => b.score - a.score)
      const failures = results.flatMap((r, i) =>
        r.status === 'rejected'
          ? [`${shortlist[i].symbol}: ${r.reason instanceof Error ? r.reason.message : 'request failed'}`]
          : [],
      )
      setSignals(valid)
      if (!valid.length) {
        setError(`No analysis completed. ${failures.slice(0, 3).join(' | ') || 'Check your connection and retry.'}`)
      } else {
        setLastUpdated(new Date().toLocaleTimeString())
        if (failures.length) setError(`Analysed ${valid.length}/${shortlist.length} markets. Failed: ${failures.slice(0, 2).join(' | ')}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed.')
    } finally {
      setScanning(false)
    }
  }, [tickers, loadMarkets])

  useEffect(() => { void loadMarkets() }, [loadMarkets])
  useEffect(() => {
    try {
      window.localStorage.setItem('spotb-paper-ideas-v1', JSON.stringify(ideas))
    } catch {
      // Keep the in-memory journal usable if browser storage is unavailable.
    }
  }, [ideas])


  function addPaperIdea(signal: Signal) {
    const stake = Number(stakeInput)
    const feePct = Number(feeInput)
    const slippagePct = Number(slippageInput)

    if (
      !Number.isFinite(stake) || stake <= 0 ||
      !Number.isFinite(feePct) || feePct < 0 || feePct > 5 ||
      !Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct > 5
    ) {
      setError('Set a positive stake and fee/slippage values between 0% and 5%.')
      setTab('paper')
      return
    }

    setError('')
    setIdeas((current) => [{
      id: Date.now(),
      symbol: signal.symbol,
      entry: signal.entry,
      stop: signal.stop,
      target: signal.target,
      time: new Date().toLocaleString(),
      quote: signal.symbol.endsWith('USDC') ? 'USDC' : 'USDT',
      stake,
      feePct,
      slippagePct,
    }, ...current])
    setTab('paper')
  }

  const confirmed = signals.filter((s) => s.status === 'CONFIRMED SETUP').length

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Spotb home">
          <span className="brand-mark">S</span><span>spotb<span className="brand-dot">.</span></span>
        </a>
        <div className="mode-pill"><span className="live-dot" /> PAPER MODE · NO REAL ORDERS</div>
      </header>

      <section className="hero">
        <p className="eyebrow">HALAL SPOT TRADING WORKSPACE</p>
        <h1>Trade with a plan.<br /><span>Not a promise.</span></h1>
        <p className="hero-copy">Market evidence, risk-first signals, and paper ideas. No leverage. No futures. No guaranteed wins.</p>
        <div className="hero-actions">
          <button className="primary-btn" onClick={() => void runScan()} disabled={scanning || loading}>
            {scanning ? 'Analyzing markets…' : 'Run market scan'} <span aria-hidden="true">↗</span>
          </button>
          <span className="update-label">{lastUpdated ? `Updated ${lastUpdated}` : 'Waiting for market data'}</span>
        </div>
      </section>

      <section className="stat-grid" aria-label="Paper trading settings">
        <article className="stat-card"><span>Virtual equity</span><strong>KES 1,000</strong><small>Practice balance only</small></article>
        <article className="stat-card"><span>Max planned risk</span><strong>KES 10</strong><small>1% of virtual equity</small></article>
        <article className="stat-card"><span>Confirmed setups</span><strong>{confirmed.toString().padStart(2, '0')}</strong><small>Technical rules only</small></article>
        <article className="stat-card"><span>Order execution</span><strong className="safe-text">Disabled</strong><small>Spot paper mode</small></article>
      </section>

      <nav className="tabs" aria-label="Workspace sections">
        <button className={tab === 'scanner' ? 'tab active' : 'tab'} onClick={() => setTab('scanner')}>Market scanner</button>
        <button className={tab === 'paper' ? 'tab active' : 'tab'} onClick={() => setTab('paper')}>Paper ideas <span className="tab-count">{ideas.length}</span></button>
      </nav>

      {tab === 'scanner' ? (
        <section className="panel">
          <div className="panel-heading">
            <div><p className="eyebrow">PUBLIC EXCHANGE DATA</p><h2>Market scanner</h2><p className="muted">Highest native quote-volume markets for the selected quote asset.</p></div>
            <div className="controls">
              <label className="select-label">Quote asset
                <select value={quote} onChange={(e) => { setQuote(e.target.value); setSignals([]) }}>
                  {QUOTES.map((q) => <option key={q}>{q}</option>)}
                </select>
              </label>
              <button className="secondary-btn" onClick={() => void loadMarkets()} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
            </div>
          </div>

          {error && <div className="error-banner" role="status">{error}</div>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Market</th><th>Last price</th><th>24h change</th><th>24h volume*</th><th>Signal</th><th>RSI 14</th><th>Paper</th></tr></thead>
              <tbody>
                {signals.length ? signals.map((s) => (
                  <tr key={s.symbol}>
                    <td><strong>{s.symbol.replace(quote, '')}</strong><small className="sub-symbol">/{quote}</small></td>
                    <td className="price-cell">{money(s.price, 8)}</td>
                    <td className={s.change >= 0 ? 'positive' : 'negative'}>{percent(s.change)}</td>
                    <td>{money(s.volume, 2)}</td>
                    <td><span className={`signal-badge ${s.status === 'CONFIRMED SETUP' ? 'signal-confirmed' : s.status === 'WATCH' ? 'signal-watch' : 'signal-none'}`}>{s.status}</span></td>
                    <td>{Number.isFinite(s.rsi) ? s.rsi.toFixed(1) : '—'}</td>
                    <td><button className="tiny-btn" disabled={s.status !== 'CONFIRMED SETUP'} onClick={() => addPaperIdea(s)}>Log idea</button></td>
                  </tr>
                )) : tickers.map((t) => (
                  <tr key={t.symbol}>
                    <td><strong>{t.symbol.replace(quote, '')}</strong><small className="sub-symbol">/{quote}</small></td>
                    <td className="price-cell">{money(Number(t.lastPrice), 8)}</td>
                    <td className={Number(t.priceChangePercent) >= 0 ? 'positive' : 'negative'}>{percent(Number(t.priceChangePercent))}</td>
                    <td>{money(Number(t.quoteVolume), 2)}</td>
                    <td><span className="signal-badge signal-pending">{loading ? 'LOADING' : 'NOT SCANNED'}</span></td>
                    <td>—</td><td>—</td>
                  </tr>
                ))}
                {!tickers.length && !loading && <tr><td colSpan={7} className="empty-cell">No market data loaded yet. Try Refresh.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="table-note">*Volume is in each market’s quote asset, so figures across different quote assets are not directly comparable. Only the first 8 shortlisted markets are technically analyzed per scan.</p>
          {signals.length > 0 && (
            <div className="analysis-grid">
              {signals.slice(0, 3).map((s) => <article className="analysis-card" key={s.symbol}>
                <div className="analysis-title"><strong>{s.symbol}</strong><span className={`signal-badge ${s.status === 'CONFIRMED SETUP' ? 'signal-confirmed' : s.status === 'WATCH' ? 'signal-watch' : 'signal-none'}`}>{s.status}</span></div>
                <p className="muted">Technical confirmations: {s.score}/5</p>
                <ul>{s.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                <div className="levels"><span>Entry <b>{money(s.entry, 8)}</b></span><span>Stop <b>{money(s.stop, 8)}</b></span><span>Target <b>{money(s.target, 8)}</b></span></div>
                <p className="screening-note">Shariah status: <b>UNVERIFIED</b>. Technical confirmation is not a halal ruling or a guarantee of profit.</p>
              </article>)}
            </div>
          )}
        </section>
      ) : (
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">SIMULATED ONLY</p><h2>Paper ideas</h2><p className="muted">Saved estimates only; no orders are sent to Binance.</p></div></div>

          <div className="controls paper-settings">
            <label className="select-label">Stake per idea (USDT/USDC)
              <input type="number" min="0.01" step="any" value={stakeInput} onChange={(e) => setStakeInput(e.target.value)} />
            </label>
            <label className="select-label">Fee per side (%)
              <input type="number" min="0" max="5" step="0.01" value={feeInput} onChange={(e) => setFeeInput(e.target.value)} />
            </label>
            <label className="select-label">Slippage per side (%)
              <input type="number" min="0" max="5" step="0.01" value={slippageInput} onChange={(e) => setSlippageInput(e.target.value)} />
            </label>
          </div>
          <p className="muted">These settings apply to newly logged ideas. Each idea keeps its own assumptions. Stake is in the market's quote asset, not KES.</p>

          {ideas.length === 0 ? <div className="empty-state"><span>◇</span><h3>No paper ideas yet</h3><p>Run a scan and log an idea only when a setup meets the technical rules.</p></div> : (
            <div className="table-wrap"><table><thead><tr><th>Market</th><th>Stake</th><th>Entry</th><th>Stop</th><th>Net at stop*</th><th>Target</th><th>Net at target*</th><th>Assumptions</th><th>Logged</th></tr></thead><tbody>
              {ideas.map((i) => {
                const quoteAsset = i.quote || (i.symbol.endsWith('USDC') ? 'USDC' : 'USDT')
                const stopNet = estimateNet(i, i.stop)
                const targetNet = estimateNet(i, i.target)
                return <tr key={i.id}>
                  <td><strong>{i.symbol}</strong></td>
                  <td>{money(Number.isFinite(i.stake) ? i.stake : 25, 4)} {quoteAsset}</td>
                  <td>{money(i.entry, 8)}</td>
                  <td>{money(i.stop, 8)}</td>
                  <td className={stopNet >= 0 ? 'positive' : 'negative'}>{money(stopNet, 4)} {quoteAsset}</td>
                  <td>{money(i.target, 8)}</td>
                  <td className={targetNet >= 0 ? 'positive' : 'negative'}>{money(targetNet, 4)} {quoteAsset}</td>
                  <td>{Number.isFinite(i.feePct) ? i.feePct : 0.1}% fee / {Number.isFinite(i.slippagePct) ? i.slippagePct : 0.05}% slip per side</td>
                  <td>{i.time}</td>
                </tr>
              })}
            </tbody></table></div>
          )}
          <p className="muted">*Approximate net scenarios subtract estimated entry/exit fees and slippage. They exclude spread, taxes, partial fills and other costs. Actual results can differ; the stop or target is not guaranteed to fill.</p>
        </section>
      )}

      <section className="notice-grid">
        <article><span className="notice-icon">⌁</span><div><h3>Spot only</h3><p>No margin, leverage, futures, shorting, or interest products.</p></div></article>
        <article><span className="notice-icon">◈</span><div><h3>Shariah screening</h3><p>Token permissibility is not verified by this prototype. Research the asset and seek qualified guidance.</p></div></article>
        <article><span className="notice-icon">◎</span><div><h3>Risk first</h3><p>Paper journal scenarios estimate fees and slippage from your settings. Currency conversion, spread, taxes and actual fills are not included.</p></div></article>
      </section>
      <footer><span>SPOTB · EARLY PAPER PROTOTYPE</span><span>Market data via Binance public API · Not financial advice</span></footer>
    </main>
  )
}

export default App
