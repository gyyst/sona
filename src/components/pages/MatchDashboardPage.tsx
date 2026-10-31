import { useCallback, useEffect, useRef, useState } from 'react'
import { SonaButton } from '@/components/ui/SonaButton'
import { SonaSelect } from '@/components/ui/SonaSelect'
import { MatchHistoryModal } from '@/components/ui/MatchHistoryModal'
import { getChampionById, getChampIcon, getPlayableQueues, getQueueName, resolveCurrentPuuid } from '@/lib/assets'
import { fetchDashboardMatches } from '@/lib/match-dashboard-data'
import {
  summarizeMatchHistory,
  type DashboardRole,
  type DashboardSummary,
  type DashboardTrendPoint,
} from '@/lib/match-stats'
import { getSessionStats, type SessionStats } from '@/lib/session-stats'
import { captureInitialLp, getSessionLpChange, type LpSnapshot } from '@/lib/lp-tracker'
import { store } from '@/lib/store'
import { useI18n } from '@/i18n'
import type { TranslationKey } from '@/i18n'
import '@/styles/MatchDashboardPage.css'

type TFn = (key: TranslationKey, params?: Record<string, string | number>) => string

const FETCH_COUNTS = [20, 50, 100]
const DEFAULT_FETCH_COUNT = 50
const TREND_MIN_POINTS = 2
const SESSION_REFRESH_MS = 30_000
const RECENT_CHAMPION_LIMIT = 5

const ROLE_LABELS: Record<DashboardRole, TranslationKey> = {
  TOP: 'opgg.position.top',
  JUNGLE: 'opgg.position.jungle',
  MIDDLE: 'opgg.position.mid',
  BOTTOM: 'opgg.position.adc',
  UTILITY: 'opgg.position.support',
  UNKNOWN: 'common.unknown',
}

export function MatchDashboardPage() {
  const { t } = useI18n()
  const [queueId, setQueueId] = useState(() => normalizeQueueId(store.get('dashboardQueueId')))
  const [fetchCount, setFetchCount] = useState(() => normalizeFetchCount(store.get('dashboardFetchCount')))
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [playerPuuid, setPlayerPuuid] = useState('')
  const [expandedChampionPool, setExpandedChampionPool] = useState(false)
  const [matchesOpen, setMatchesOpen] = useState(false)
  const [fallbackSource, setFallbackSource] = useState(false)

  const [sessionStats, setSessionStats] = useState<SessionStats>(() => getSessionStats())
  const [lp, setLp] = useState<LpSnapshot | null>(null)
  const [lpDelta, setLpDelta] = useState<number | null>(null)
  const [lpRankChanged, setLpRankChanged] = useState(false)
  const [lpLoading, setLpLoading] = useState(false)

  const loadTokenRef = useRef(0)
  const mountedRef = useRef(true)
  const [assetsTick, setAssetsTick] = useState(0)

  // 资源映射异步初始化；若首次渲染时队列列表为空，稍后重试触发刷新
  useEffect(() => {
    if (getPlayableQueues().length > 0) return

    const timer = window.setInterval(() => {
      if (getPlayableQueues().length > 0) {
        setAssetsTick((value) => value + 1)
        window.clearInterval(timer)
      }
    }, 2000)

    return () => window.clearInterval(timer)
  }, [assetsTick])

  // 卸载后让进行中的请求结果失效，避免更新已卸载组件
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadTokenRef.current++
    }
  }, [])

  const runLoad = useCallback(async (force = false) => {
    const token = ++loadTokenRef.current
    setLoading(true)
    setError('')

    try {
      const puuid = await resolveCurrentPuuid()
      if (!puuid) throw new Error(t('dashboard.errorNoAccount'))

      const result = await fetchDashboardMatches({
        puuid,
        queueId,
        maxGames: fetchCount,
        force,
      })
      if (token !== loadTokenRef.current) return

      setPlayerPuuid(puuid)
      setFallbackSource(result.fallback)
      setSummary(summarizeMatchHistory(result.games, puuid, { queueId }))
    } catch (err) {
      if (token !== loadTokenRef.current) return
      setError(summarizeError(err))
    } finally {
      if (token === loadTokenRef.current) setLoading(false)
    }
  }, [fetchCount, queueId, t])

  const refreshLp = useCallback(async () => {
    setLpLoading(true)
    try {
      await captureInitialLp()
      const change = await getSessionLpChange()
      if (!mountedRef.current) return
      setLp(change.current)
      setLpDelta(change.delta)
      setLpRankChanged(change.rankChanged)
    } catch {
      if (!mountedRef.current) return
      setLp(null)
      setLpDelta(null)
      setLpRankChanged(false)
    } finally {
      if (mountedRef.current) setLpLoading(false)
    }
  }, [])

  // 队列 / 场次范围变化或语言切换时重新加载
  useEffect(() => {
    void runLoad()
  }, [runLoad])

  // 会话统计定时刷新；LP 在页面打开时读取
  useEffect(() => {
    setSessionStats(getSessionStats())
    void refreshLp()

    const timer = window.setInterval(() => {
      setSessionStats(getSessionStats())
    }, SESSION_REFRESH_MS)

    return () => window.clearInterval(timer)
  }, [refreshLp])

  const handleQueueChange = (value: string) => {
    const next = normalizeQueueId(Number(value))
    setQueueId(next)
    setExpandedChampionPool(false)
    store.set('dashboardQueueId', next)
  }

  const handleFetchCountChange = (value: string) => {
    const next = normalizeFetchCount(Number(value))
    setFetchCount(next)
    store.set('dashboardFetchCount', next)
  }

  const handleRefresh = () => {
    void runLoad(true)
    void refreshLp()
    setSessionStats(getSessionStats())
  }

  const queueOptions = [
    { value: '0', label: t('dashboard.queueAll') },
    ...getPlayableQueues().map((queue) => ({ value: String(queue.id), label: queue.name })),
  ]
  const fetchCountOptions = FETCH_COUNTS.map((count) => ({
    value: String(count),
    label: t(`option.recent.${count}` as TranslationKey),
  }))

  const hasSummary = Boolean(summary)
  const isEmpty = Boolean(summary && summary.totalGames === 0)

  return (
    <div className="smdb-page">
      <div className="smdb-header">
        <div className="smdb-heading">
          <h2 className="smdb-title">{t('dashboard.title')}</h2>
          <p className="smdb-subtitle">{t('dashboard.subtitle')}</p>
        </div>
        <div className="smdb-toolbar">
          <div className="smdb-field">
            <span className="smdb-field-label">{t('dashboard.queueFilter')}</span>
            <div className="smdb-select">
              <SonaSelect
                options={queueOptions}
                value={String(queueId)}
                onChange={handleQueueChange}
              />
            </div>
          </div>
          <div className="smdb-field">
            <span className="smdb-field-label">{t('dashboard.fetchCount')}</span>
            <div className="smdb-select smdb-select--compact">
              <SonaSelect
                options={fetchCountOptions}
                value={String(fetchCount)}
                onChange={handleFetchCountChange}
              />
            </div>
          </div>
          <SonaButton variant="primary" onClick={handleRefresh} disabled={loading}>
            {t('dashboard.refresh')}
          </SonaButton>
        </div>
      </div>

      {error && hasSummary && (
        <div className="smdb-banner smdb-banner--error">
          <span>{t('dashboard.error', { error })}</span>
          <SonaButton variant="secondary" onClick={() => void runLoad(true)}>
            {t('dashboard.retry')}
          </SonaButton>
        </div>
      )}

      {fallbackSource && (
        <div className="smdb-banner smdb-banner--warning">
          {t('dashboard.fallbackNotice')}
        </div>
      )}

      {loading && hasSummary && (
        <p className="smdb-loading-inline">{t('dashboard.loading')}</p>
      )}

      {!hasSummary && loading && (
        <div className="smdb-state">{t('dashboard.loading')}</div>
      )}

      {!hasSummary && !loading && (
        <div className={`smdb-state${error ? ' smdb-state--error' : ''}`}>
          <p>{error ? t('dashboard.error', { error }) : t('dashboard.empty')}</p>
          <SonaButton onClick={() => void runLoad(true)}>
            {error ? t('dashboard.retry') : t('dashboard.refresh')}
          </SonaButton>
        </div>
      )}

      {summary && isEmpty && !loading && (
        <div className="smdb-state">
          <p>{t('dashboard.empty')}</p>
          <SonaButton onClick={() => void runLoad(true)}>{t('dashboard.refresh')}</SonaButton>
        </div>
      )}

      {summary && !isEmpty && (
        <>
          <section className="smdb-section">
            <h3 className="smdb-section-title">{t('dashboard.overview')}</h3>
            <div className="smdb-stat-grid">
              <StatCard label={t('dashboard.games')} value={String(summary.totalGames)} />
              <StatCard
                label={t('dashboard.winRate')}
                value={`${formatPercent(summary.winRate)}%`}
                tone={winRateTone(summary.winRate)}
              />
              <StatCard
                label={t('dashboard.winsLosses')}
                value={t('gameAnalysis.winLoss', { wins: summary.wins, losses: summary.losses })}
              />
              <StatCard label={t('dashboard.avgKda')} value={formatKda(summary.avgKda)} />
              {summary.avgScore != null && (
                <StatCard
                  label={t('dashboard.avgScore')}
                  value={summary.avgScore.toFixed(1)}
                  tone={summary.avgScore >= 10.8 ? 'good' : summary.avgScore < 8 ? 'bad' : undefined}
                />
              )}
              <StatCard
                label={t('dashboard.streak')}
                value={formatStreak(summary.currentStreak, t)}
                tone={summary.currentStreak?.type === 'win' ? 'good' : summary.currentStreak ? 'bad' : undefined}
              />
            </div>
          </section>

          <section className="smdb-section">
            <h3 className="smdb-section-title">{t('dashboard.trend')}</h3>
            <div className="smdb-panel">
              <TrendChart trend={summary.trend} t={t} />
            </div>
          </section>

          <div className="smdb-columns">
            <section className="smdb-section smdb-section--panel">
              <h3 className="smdb-section-title">{t('dashboard.championPool')}</h3>
              {summary.championPool.length === 0 && (
                <p className="smdb-empty-inline">{t('common.noData')}</p>
              )}
              {summary.championPool.length > 0 && (
                <>
                  {(expandedChampionPool
                    ? summary.championPool
                    : summary.championPool.slice(0, RECENT_CHAMPION_LIMIT)
                  ).map((champion) => <ChampionRow key={champion.championId} champion={champion} t={t} />)}
                  {summary.championPool.length > RECENT_CHAMPION_LIMIT && (
                    <button
                      className="smdb-link-button"
                      type="button"
                      onClick={() => setExpandedChampionPool((value) => !value)}
                    >
                      {expandedChampionPool ? t('dashboard.collapse') : t('dashboard.expand')}
                    </button>
                  )}
                </>
              )}
            </section>

            <section className="smdb-section smdb-section--panel">
              <h3 className="smdb-section-title">{t('dashboard.roleStats')}</h3>
              {summary.roleStats.length === 0 && (
                <p className="smdb-empty-inline">{t('common.noData')}</p>
              )}
              <div className="smdb-role-grid">
                {summary.roleStats.map((role) => (
                  <div className="smdb-role-card" key={role.role}>
                    <span className="smdb-role-name">{t(ROLE_LABELS[role.role])}</span>
                    <span className="smdb-role-games">{t('dashboard.gamesShort', { count: role.games })}</span>
                    <span className={`smdb-role-winrate${toneClass(winRateTone(role.winRate))}`}>
                      {formatPercent(role.winRate)}%
                    </span>
                    <span className="smdb-role-kda">{formatKda(role.kda)}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="smdb-columns">
            <section className="smdb-section smdb-section--panel">
              <h3 className="smdb-section-title">{t('dashboard.queueStats')}</h3>
              {summary.queueStats.length === 0 && (
                <p className="smdb-empty-inline">{t('common.noData')}</p>
              )}
              <div className="smdb-queue-list">
                {summary.queueStats.map((queue) => (
                  <div className="smdb-queue-row" key={queue.queueId}>
                    <span className="smdb-queue-name">
                      {queue.queueId > 0 ? getQueueName(queue.queueId) : t('common.unknown')}
                    </span>
                    <span className="smdb-queue-games">{t('dashboard.gamesShort', { count: queue.games })}</span>
                    <span className={`smdb-queue-winrate${toneClass(winRateTone(queue.winRate))}`}>
                      {formatPercent(queue.winRate)}%
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <div className="smdb-stack">
              <section className="smdb-section smdb-section--panel">
                <h3 className="smdb-section-title">{t('dashboard.session')}</h3>
                <div className="smdb-kv-list">
                  <div className="smdb-kv">
                    <span>{t('dashboard.games')}</span>
                    <strong>{sessionStats.games.length}</strong>
                  </div>
                  <div className="smdb-kv">
                    <span>{t('dashboard.winsLosses')}</span>
                    <strong>{t('gameAnalysis.winLoss', { wins: sessionStats.wins, losses: sessionStats.losses })}</strong>
                  </div>
                  <div className="smdb-kv">
                    <span>{t('dashboard.netWins')}</span>
                    <strong className={toneClass(sessionStats.netWins > 0 ? 'good' : sessionStats.netWins < 0 ? 'bad' : undefined)}>
                      {formatSigned(sessionStats.netWins)}
                    </strong>
                  </div>
                  <div className="smdb-kv">
                    <span>{t('dashboard.sessionDuration')}</span>
                    <strong>{formatDuration(sessionStats.durationMs, t)}</strong>
                  </div>
                </div>
              </section>

              <section className="smdb-section smdb-section--panel">
                <h3 className="smdb-section-title">{t('dashboard.lp')}</h3>
                <div className="smdb-kv-list">
                  <div className="smdb-kv">
                    <span>{t('dashboard.lpCurrent')}</span>
                    <strong>{lpLoading ? t('common.loading') : lp ? formatRank(lp, t) : t('dashboard.unavailable')}</strong>
                  </div>
                  {lp && lp.tier !== 'UNRANKED' && (
                    <div className="smdb-kv">
                      <span>{t('dashboard.lpPointsLabel')}</span>
                      <strong>{t('dashboard.lpPoints', { lp: lp.leaguePoints })}</strong>
                    </div>
                  )}
                  <div className="smdb-kv">
                    <span>{t('dashboard.lpSessionChange')}</span>
                    <strong className={toneClass(lpDelta != null && lpDelta > 0 ? 'good' : lpDelta != null && lpDelta < 0 ? 'bad' : undefined)}>
                      {lpLoading
                        ? t('common.loading')
                        : lpDelta != null
                          ? `${formatSigned(lpDelta)} LP`
                          : lpRankChanged
                            ? t('dashboard.lpRankChanged')
                            : t('dashboard.unavailable')}
                    </strong>
                  </div>
                </div>
              </section>
            </div>
          </div>

          <section className="smdb-section smdb-recent">
            <div>
              <h3 className="smdb-section-title smdb-section-title--inline">{t('dashboard.recentMatches')}</h3>
              <p className="smdb-section-desc">{t('dashboard.recentMatchesHint')}</p>
            </div>
            <SonaButton
              variant="primary"
              onClick={() => setMatchesOpen(true)}
              disabled={!playerPuuid}
            >
              {t('dashboard.recentMatches')}
            </SonaButton>
          </section>
        </>
      )}

      <MatchHistoryModal
        open={matchesOpen}
        onClose={() => setMatchesOpen(false)}
        puuid={playerPuuid}
        playerName=""
        queueId={queueId > 0 ? queueId : undefined}
      />
    </div>
  )
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="smdb-stat-card">
      <span className="smdb-stat-label">{label}</span>
      <span className={`smdb-stat-value${toneClass(tone)}`}>{value}</span>
    </div>
  )
}

function ChampionRow({
  champion,
  t,
}: {
  champion: DashboardSummary['championPool'][number]
  t: TFn
}) {
  const info = getChampionById(champion.championId)
  const name = info?.name || `#${champion.championId}`

  return (
    <div className="smdb-champion-row">
      <img className="smdb-champion-icon" src={getChampIcon(champion.championId)} alt="" />
      <span className="smdb-champion-name">{name}</span>
      <span className="smdb-champion-games">{t('dashboard.gamesShort', { count: champion.games })}</span>
      <span className={`smdb-champion-winrate${toneClass(winRateTone(champion.winRate))}`}>
        {formatPercent(champion.winRate)}%
      </span>
      <span className="smdb-champion-kda">{formatKda(champion.kda)}</span>
    </div>
  )
}

function TrendChart({ trend, t }: { trend: DashboardTrendPoint[]; t: TFn }) {
  if (trend.length < TREND_MIN_POINTS) {
    return <p className="smdb-empty-inline">{t('dashboard.trendEmpty')}</p>
  }

  const width = 600
  const height = 170
  const padX = 34
  const padY = 18
  const innerWidth = width - padX * 2
  const innerHeight = height - padY * 2
  const points = trend.map((point, index) => ({
    ...point,
    x: padX + (index / (trend.length - 1)) * innerWidth,
    y: padY + (1 - clampWinRate(point.winRate) / 100) * innerHeight,
  }))
  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ')
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)} ${height - padY} L${points[0].x.toFixed(1)} ${height - padY} Z`

  return (
    <div className="smdb-trend">
      <svg className="smdb-trend-svg" viewBox={`0 0 ${width} ${height}`} role="img">
        {[0, 25, 50, 75, 100].map((value) => {
          const y = padY + (1 - value / 100) * innerHeight
          return (
            <g key={value}>
              <line
                x1={padX}
                y1={y}
                x2={width - padX}
                y2={y}
                className={`smdb-trend-grid${value === 50 ? ' smdb-trend-grid--mid' : ''}`}
              />
              <text x={4} y={y + 3} className="smdb-trend-axis">{value}%</text>
            </g>
          )
        })}
        <path d={areaPath} className="smdb-trend-area" />
        <path d={linePath} className="smdb-trend-line" />
        {points.map((point) => (
          <circle key={point.date} cx={point.x} cy={point.y} r={3.5} className="smdb-trend-point">
            <title>
              {t('dashboard.trendPoint', {
                date: point.date,
                games: point.games,
                winRate: formatPercent(point.winRate),
              })}
            </title>
          </circle>
        ))}
      </svg>
      <div className="smdb-trend-dates">
        <span>{trend[0].date}</span>
        <span>{trend[trend.length - 1].date}</span>
      </div>
    </div>
  )
}

function formatRank(snapshot: LpSnapshot, t: TFn): string {
  const queueLabel = snapshot.queueType === 'RANKED_FLEX_SR'
    ? t('rank.queue.RANKED_FLEX_SR')
    : t('rank.queue.RANKED_SOLO_5x5')

  if (snapshot.tier === 'UNRANKED') {
    return `${t('rank.UNRANKED')} · ${queueLabel}`
  }

  const tierLabel = t(`rank.${snapshot.tier}` as TranslationKey)
  const division = snapshot.division && snapshot.division !== 'NA' ? ` ${snapshot.division}` : ''
  return `${tierLabel}${division} · ${queueLabel}`
}

function formatStreak(
  streak: DashboardSummary['currentStreak'],
  t: TFn,
): string {
  if (!streak) return '--'
  return streak.type === 'win'
    ? t('dashboard.winStreak', { count: streak.count })
    : t('dashboard.lossStreak', { count: streak.count })
}

function formatDuration(durationMs: number, t: TFn): string {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours > 0) {
    return t('dashboard.durationHoursMinutes', { hours, minutes })
  }
  return t('dashboard.durationMinutes', { minutes: totalMinutes })
}

function formatKda(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00'
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0.0'
  return value.toFixed(1)
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value)
}

function winRateTone(winRate: number): 'good' | 'bad' | undefined {
  if (winRate >= 60) return 'good'
  if (winRate < 45) return 'bad'
  return undefined
}

function toneClass(tone?: 'good' | 'bad'): string {
  return tone ? ` smdb-tone-${tone}` : ''
}

function clampWinRate(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

function normalizeQueueId(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function normalizeFetchCount(value: number): number {
  return FETCH_COUNTS.includes(value) ? value : DEFAULT_FETCH_COUNT
}

function summarizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.length > 200 ? `${message.slice(0, 200)}...` : message
}
