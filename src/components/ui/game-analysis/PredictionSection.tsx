import type { PredictionBasis, WinRatePrediction } from '@/lib/team-composition'
import { useI18n, type TranslationKey } from '@/i18n'

const BASIS_LABEL_KEYS: Record<PredictionBasis, TranslationKey> = {
  winRate: 'gameAnalysis.prediction.basisWinRate',
  composition: 'gameAnalysis.prediction.basisComposition',
  matchups: 'gameAnalysis.prediction.basisMatchups',
}

export function PredictionSection({ prediction }: { prediction: WinRatePrediction }) {
  const { t } = useI18n()
  const basisText = prediction.basis.map((basis) => t(BASIS_LABEL_KEYS[basis])).join(' / ')

  return (
    <section className="sga-insight sga-prediction">
      <div className="sga-insight-title">{t('gameAnalysis.prediction.title')}</div>
      <div className="sga-pred-rates">
        <span className="sga-pred-blue">
          {t('gameAnalysis.prediction.blue', { rate: prediction.blue })}
        </span>
        <span className="sga-pred-red">
          {t('gameAnalysis.prediction.red', { rate: prediction.red })}
        </span>
      </div>
      <div className="sga-pred-bar">
        <div className="sga-pred-bar-blue" style={{ width: `${prediction.blue}%` }} />
        <div className="sga-pred-bar-red" style={{ width: `${prediction.red}%` }} />
      </div>
      <div className="sga-pred-basis">
        {t('gameAnalysis.prediction.basis', { items: basisText })}
      </div>
      <div className="sga-pred-disclaimer">{t('gameAnalysis.prediction.disclaimer')}</div>
    </section>
  )
}
