import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { SonaButton } from '@/components/ui/SonaButton'
import { SonaSwitch } from '@/components/ui/SonaSwitch'
import { useI18n } from '@/i18n'
import {
  MAX_PLAYER_NOTE_LENGTH,
  getPlayerNote,
  getPlayerNoteKey,
  isObfuscatedPlayerNoteKey,
  removePlayerNote,
  upsertPlayerNote,
  type PlayerNoteIdentity,
} from '@/lib/player-notes'
import '@/styles/PlayerNotes.css'

export interface PlayerNoteEditorProps {
  open: boolean
  onClose: () => void
  /** 目标玩家；为 null 或无法解析稳定标识时只展示提示 */
  player: (PlayerNoteIdentity & { displayName?: string }) | null
  onSaved?: () => void
}

/** 玩家备注 / 黑名单编辑弹窗 */
export function PlayerNoteEditor({ open, onClose, player, onSaved }: PlayerNoteEditorProps) {
  const { t } = useI18n()
  const [noteText, setNoteText] = useState('')
  const [blacklisted, setBlacklisted] = useState(false)

  const playerKey = player ? getPlayerNoteKey(player) : null
  const anonymous = playerKey ? isObfuscatedPlayerNoteKey(playerKey) : false

  // 每次打开或目标变化时从 store 重新加载，避免显示上一个玩家的备注
  useEffect(() => {
    if (!open) return
    const existing = getPlayerNote(playerKey)
    setNoteText(existing?.note ?? '')
    setBlacklisted(existing?.blacklisted ?? false)
  }, [open, playerKey])

  const existing = getPlayerNote(playerKey)
  const displayName = player?.displayName?.trim()
    || existing?.displayName
    || t('playerNotes.unknownPlayer')

  const handleSave = () => {
    if (!playerKey) return
    upsertPlayerNote({
      key: playerKey,
      puuid: player?.puuid,
      displayName: player?.displayName || existing?.displayName,
      note: noteText,
      blacklisted,
      anonymous,
    })
    onSaved?.()
    onClose()
  }

  const handleDelete = () => {
    if (!playerKey) return
    removePlayerNote(playerKey)
    onSaved?.()
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} width={460} height={380}>
      <div className="spn-editor">
        <h3 className="spn-editor-title">{t('playerNotes.editorTitle')}</h3>

        <div className="spn-editor-player">
          <span className="spn-editor-name" title={displayName}>{displayName}</span>
          {anonymous ? <span className="spn-editor-anon">{t('playerNotes.anonymous')}</span> : null}
        </div>

        {playerKey ? (
          <>
            <textarea
              className="spn-editor-textarea"
              value={noteText}
              maxLength={MAX_PLAYER_NOTE_LENGTH}
              placeholder={t('playerNotes.notePlaceholder')}
              onChange={(e) => setNoteText(e.target.value)}
            />
            <div className={`spn-editor-counter${noteText.length >= MAX_PLAYER_NOTE_LENGTH ? ' spn-editor-counter--limit' : ''}`}>
              {noteText.length >= MAX_PLAYER_NOTE_LENGTH ? `${t('playerNotes.tooLong')} · ` : ''}
              {t('playerNotes.charCount', { count: noteText.length, max: MAX_PLAYER_NOTE_LENGTH })}
            </div>

            <div className="spn-editor-blacklist">
              <span className="spn-editor-blacklist-text">{t('playerNotes.blacklist')}</span>
              <SonaSwitch checked={blacklisted} onChange={setBlacklisted} />
            </div>
          </>
        ) : (
          <p className="spn-editor-unavailable">{t('playerNotes.identityUnavailable')}</p>
        )}

        {existing ? (
          <div>
            <button type="button" className="spn-link-btn spn-link-btn--danger" onClick={handleDelete}>
              {t('playerNotes.deleteRecord')}
            </button>
          </div>
        ) : null}

        <div className="spn-editor-actions">
          <SonaButton variant="secondary" onClick={onClose}>{t('common.cancel')}</SonaButton>
          <SonaButton onClick={handleSave} disabled={!playerKey}>{t('common.save')}</SonaButton>
        </div>
      </div>
    </Modal>
  )
}
