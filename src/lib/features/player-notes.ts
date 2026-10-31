import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { logger } from '@/index'
import { lcu, LcuEventUri } from '@/lib/lcu'
import type { LCUEventMessage, GameflowPhase, ChampSelectSession } from '@/lib/lcu'
import { injector } from '@/lib/InjectorManager'
import { store } from '@/lib/store'
import { translate } from '@/i18n'
import {
  getPlayerNoteKey,
  type PlayerNote,
  type PlayerNoteIdentity,
} from '@/lib/player-notes'
import { PlayerNoteEditor } from '@/components/ui/PlayerNoteEditor'

// ==================== 选人界面备注徽标注入 ====================

const BADGE_ATTR = 'data-sona-player-note'
const BADGE_VERSION_ATTR = 'data-sona-player-note-version'

const EDITOR_CLOSE_ANIMATION_MS = 240

/** 选人队友身份（与 DOM 顺序一一对应） */
interface NoteTarget extends PlayerNoteIdentity {
  displayName: string
}

let unsubStore: (() => void) | null = null
let unsubGameflow: (() => void) | null = null
let unsubChampSelect: (() => void) | null = null
let badgeTaskRegistered = false

let noteTargets: NoteTarget[] = []
let notesSnapshot: Record<string, PlayerNote> = store.get('playerNotes')

let editorRoot: Root | null = null
let editorContainer: HTMLDivElement | null = null
let editorCloseTimer: number | null = null

/** 判断 target 是否能在当前会话中解析出稳定标识 */
function toNoteTarget(player: ChampSelectSession['myTeam'][number]): NoteTarget | null {
  if (!player.puuid && !player.obfuscatedPuuid) return null
  return {
    puuid: player.puuid || undefined,
    obfuscatedPuuid: player.obfuscatedPuuid || undefined,
    nameVisibilityType: player.nameVisibilityType,
    displayName: player.gameName || player.playerAlias || '',
  }
}

/** 从 ChampSelect session 重建队友身份列表（过滤空位占位） */
function refreshNoteTargets(session: ChampSelectSession) {
  noteTargets = (session.myTeam ?? [])
    .map(toNoteTarget)
    .filter((target): target is NoteTarget => target != null)
  if (noteTargets.length === 0) cleanupPlayerNoteBadges()
}

// ---- 编辑弹窗（独立 React root） ----

function cleanupPlayerNoteEditor() {
  if (editorCloseTimer != null) {
    window.clearTimeout(editorCloseTimer)
    editorCloseTimer = null
  }
  if (editorRoot) {
    editorRoot.unmount()
    editorRoot = null
  }
  if (editorContainer) {
    editorContainer.remove()
    editorContainer = null
  }
}

function showPlayerNoteEditor(target: NoteTarget) {
  if (editorCloseTimer != null) {
    window.clearTimeout(editorCloseTimer)
    editorCloseTimer = null
  }

  if (!editorContainer) {
    editorContainer = document.createElement('div')
    editorContainer.id = 'sona-player-note-editor-root'
    document.body.appendChild(editorContainer)
    editorRoot = createRoot(editorContainer)
  }

  const rootAtRender = editorRoot
  const close = () => {
    rootAtRender?.render(
      createElement(PlayerNoteEditor, { open: false, onClose: close, player: target }),
    )
    if (editorCloseTimer != null) window.clearTimeout(editorCloseTimer)
    editorCloseTimer = window.setTimeout(() => {
      editorCloseTimer = null
      if (editorRoot === rootAtRender) cleanupPlayerNoteEditor()
    }, EDITOR_CLOSE_ANIMATION_MS)
  }

  rootAtRender!.render(
    createElement(PlayerNoteEditor, { open: true, onClose: close, player: target }),
  )
}

// ---- DOM 注入 ----

function cleanupPlayerNoteBadges() {
  document.querySelectorAll(`[${BADGE_ATTR}]`).forEach((node) => node.remove())
}

/** 徽标内容签名：备注更新或黑名单切换后需要重建节点 */
function getBadgeVersion(note: PlayerNote): string {
  return `${note.updatedAt}:${note.blacklisted ? 1 : 0}:${note.note.length}:${note.anonymous ? 1 : 0}`
}

function createPlayerNoteBadge(target: NoteTarget, key: string, note: PlayerNote): HTMLButtonElement {
  const badge = document.createElement('button')
  badge.type = 'button'
  badge.setAttribute(BADGE_ATTR, key)
  badge.setAttribute(BADGE_VERSION_ATTR, getBadgeVersion(note))
  badge.className = `sona-player-note-badge${note.blacklisted ? ' sona-player-note-badge--blacklist' : ''}`

  const dot = document.createElement('span')
  dot.className = 'sona-player-note-badge-dot'

  const label = document.createElement('span')
  label.className = 'sona-player-note-badge-label'
  label.textContent = translate(note.blacklisted ? 'playerNotes.blacklisted' : 'playerNotes.noteTag')

  badge.append(dot, label)

  const summary = note.note.trim()
  if (summary) {
    const text = document.createElement('span')
    text.className = 'sona-player-note-badge-text'
    text.textContent = summary
    badge.appendChild(text)
  }

  if (note.anonymous) {
    const anon = document.createElement('span')
    anon.className = 'sona-player-note-badge-anon'
    anon.textContent = translate('playerNotes.anonymousShort')
    badge.appendChild(anon)
  }

  const titleParts = [label.textContent ?? '']
  if (summary) titleParts.push(summary)
  if (note.anonymous) titleParts.push(translate('playerNotes.anonymous'))
  badge.title = titleParts.join(' · ')

  badge.addEventListener('click', (e) => {
    e.stopPropagation()
    e.preventDefault()
    showPlayerNoteEditor(target)
  })

  return badge
}

/**
 * 注入任务：在选人队友名字旁插入备注 / 黑名单徽标。
 *
 * 幂等、轻量：找不到位置或没有备注时返回 true/清理节点，不抛异常。
 * 队友顺序与 features.ts 中头像战绩注入保持一致（myTeam 过滤空位后按 DOM 顺序对齐）。
 */
function tryInjectPlayerNoteBadges(): boolean {
  // 不在选人阶段时直接跳过，避免全局注入任务每帧查询 DOM
  if (noteTargets.length === 0) return true

  const wrappers = document.querySelectorAll('.party.visible .summoner-wrapper.visible.left')
  if (wrappers.length === 0) return true

  wrappers.forEach((wrapper, index) => {
    const anchor = wrapper.querySelector('.player-name-wrapper') as HTMLElement | null
    const existing = wrapper.querySelector(`[${BADGE_ATTR}]`) as HTMLElement | null
    const target = noteTargets[index]
    const key = target ? getPlayerNoteKey(target) : null
    const note = key ? notesSnapshot[key] : undefined

    if (!anchor || !target || !key || !note) {
      existing?.remove()
      return
    }

    if (
      existing
      && existing.getAttribute(BADGE_ATTR) === key
      && existing.getAttribute(BADGE_VERSION_ATTR) === getBadgeVersion(note)
    ) {
      // Ember 重建 DOM 后节点可能被挪走，这里确保仍紧跟名字
      if (existing.previousElementSibling !== anchor) anchor.after(existing)
      return
    }

    existing?.remove()
    anchor.after(createPlayerNoteBadge(target, key, note))
  })

  return true
}

// ---- 生命周期 ----

function resetChampSelectNotes() {
  noteTargets = []
  cleanupPlayerNoteBadges()
  cleanupPlayerNoteEditor()
}

async function loadChampSelectTargets() {
  try {
    const session = await lcu.getChampSelectSession()
    if (!unsubGameflow) return
    refreshNoteTargets(session)
    tryInjectPlayerNoteBadges()
  } catch {
    // 未在选人阶段或查询失败：保持空目标，静默降级
  }
}

function handleChampSelectUpdate(event: LCUEventMessage) {
  if (event.eventType !== 'Update') return
  const session = event.data as ChampSelectSession
  if (!session?.myTeam) return
  refreshNoteTargets(session)
  tryInjectPlayerNoteBadges()
}

/** 启用 / 停用玩家备注功能（幂等） */
export function updatePlayerNotes(enabled: boolean) {
  if (enabled && !unsubGameflow) {
    notesSnapshot = store.get('playerNotes')

    unsubStore = store.onChange('playerNotes', () => {
      notesSnapshot = store.get('playerNotes')
      try {
        tryInjectPlayerNoteBadges()
      } catch (err) {
        logger.error('[PlayerNotes] 刷新备注徽标失败:', err)
      }
    })

    unsubGameflow = lcu.observe(LcuEventUri.GAMEFLOW_PHASE_CHANGE, (event: LCUEventMessage) => {
      const phase = event.data as GameflowPhase
      if (phase === 'ChampSelect') {
        void loadChampSelectTargets()
      } else {
        resetChampSelectNotes()
      }
    })

    unsubChampSelect = lcu.observe(LcuEventUri.CHAMP_SELECT, handleChampSelectUpdate)

    if (!badgeTaskRegistered) {
      injector.register(tryInjectPlayerNoteBadges)
      badgeTaskRegistered = true
    }

    // 启动时可能已经在选人阶段，主动补一次
    void loadChampSelectTargets()

    logger.info('Player notes enabled ✓')
  } else if (!enabled && unsubGameflow) {
    unsubGameflow()
    unsubGameflow = null

    if (unsubChampSelect) {
      unsubChampSelect()
      unsubChampSelect = null
    }

    if (unsubStore) {
      unsubStore()
      unsubStore = null
    }

    if (badgeTaskRegistered) {
      injector.unregister(tryInjectPlayerNoteBadges)
      badgeTaskRegistered = false
    }

    resetChampSelectNotes()
    noteTargets = []
    logger.info('Player notes disabled')
  }
}
