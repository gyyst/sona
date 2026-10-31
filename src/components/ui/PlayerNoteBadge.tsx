import type { MouseEvent } from 'react'
import { useI18n } from '@/i18n'
import type { PlayerNote } from '@/lib/player-notes'
import '@/styles/PlayerNotes.css'

export interface PlayerNoteBadgeProps {
  note?: PlayerNote
  /** 紧凑模式：只显示标签，不显示备注摘要 */
  compact?: boolean
  onClick?: () => void
}

/**
 * 玩家备注 / 黑名单徽标
 *
 * 点击徽标打开编辑弹窗；徽标自身会阻止事件冒泡，避免触发外层
 * 「点击整行打开战绩」等交互。
 */
export function PlayerNoteBadge({ note, compact = false, onClick }: PlayerNoteBadgeProps) {
  const { t } = useI18n()
  if (!note) return null

  const label = note.blacklisted ? t('playerNotes.blacklisted') : t('playerNotes.noteTag')
  const summary = note.note.trim()
  const titleParts = [label]
  if (summary) titleParts.push(summary)
  if (note.anonymous) titleParts.push(t('playerNotes.anonymous'))

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    e.preventDefault()
    onClick?.()
  }

  return (
    <button
      type="button"
      className={`spn-badge${note.blacklisted ? ' spn-badge--black' : ''}`}
      title={titleParts.join(' · ')}
      onClick={handleClick}
    >
      <span className="spn-badge-dot" />
      <span className="spn-badge-label">{label}</span>
      {!compact && summary ? <span className="spn-badge-text">{summary}</span> : null}
      {note.anonymous ? <span className="spn-badge-anon">{t('playerNotes.anonymousShort')}</span> : null}
    </button>
  )
}

export interface PlayerNoteEditButtonProps {
  onClick?: () => void
  label?: string
}

/** 玩家行内的备注编辑按钮，与徽标一样阻止事件冒泡 */
export function PlayerNoteEditButton({ onClick, label }: PlayerNoteEditButtonProps) {
  const { t } = useI18n()

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    e.preventDefault()
    onClick?.()
  }

  return (
    <button
      type="button"
      className="spn-edit-btn"
      title={label ?? t('playerNotes.edit')}
      aria-label={label ?? t('playerNotes.edit')}
      onClick={handleClick}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M11.2 2.3l2.5 2.5L5.4 13.1l-3.4.9.9-3.4 8.3-8.3z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
