import { useState, useEffect, useMemo } from 'react'
import '@/styles/App.css'
import { logger } from '.'
import { Modal } from '@/components/ui/Modal'
import { Sidebar, type SidebarItem } from '@/components/ui/Sidebar'
import { HomePage } from '@/components/pages/HomePage'
import { ToolsPage } from '@/components/pages/ToolsPage'
import { MatchDashboardPage } from '@/components/pages/MatchDashboardPage'
import { BeautifyPage } from '@/components/pages/BeautifyPage'
import { SettingsPage } from '@/components/pages/SettingsPage'
import { AboutPage } from '@/components/pages/AboutPage'
import { RewardsPage } from '@/components/pages/RewardsPage'
import { DebugPage } from '@/components/pages/DebugPage'
import { UpdatePage } from '@/components/pages/UpdatePage'
import { HomeIcon, GamepadIcon, DashboardIcon, PaletteIcon, SettingsIcon, InfoIcon, BugIcon, ZapIcon, GiftIcon } from '@/components/ui/icons'
import { onModalVisibilityChange, isModalVisible, closeModal } from '@/lib/modal'
import { store } from '@/lib/store'
import { getUpdateState, isUpdateAttentionRequired, onUpdateStateChange, type UpdateState } from '@/lib/update/update-checker'
import { useI18n } from '@/i18n'
import type { TranslationKey } from '@/i18n'

const baseSidebarItemConfigs: Array<Omit<SidebarItem, 'label'> & { labelKey: TranslationKey }> = [
  { id: 'home', icon: <HomeIcon />, labelKey: 'nav.home' },
  { id: 'tools', icon: <GamepadIcon />, labelKey: 'nav.tools' },
  { id: 'dashboard', icon: <DashboardIcon />, labelKey: 'nav.dashboard' },
  { id: 'rewards', icon: <GiftIcon />, labelKey: 'nav.rewards' },
  { id: 'beautify', icon: <PaletteIcon />, labelKey: 'nav.beautify' },
  { id: 'settings', icon: <SettingsIcon />, labelKey: 'nav.settings' },
  { id: 'about', icon: <InfoIcon />, labelKey: 'nav.about' },
]

const debugSidebarItemConfig: Omit<SidebarItem, 'label'> & { labelKey: TranslationKey } = {
  id: 'debug', icon: <BugIcon />, labelKey: 'nav.debug',
}

function PageContent({ pageId }: { pageId: string }) {
  switch (pageId) {
    case 'update':
      return <UpdatePage />
    case 'home':
      return <HomePage />
    case 'tools':
      return <ToolsPage />
    case 'dashboard':
      return <MatchDashboardPage />
    case 'rewards':
      return <RewardsPage />
    case 'beautify':
      return <BeautifyPage />
    case 'settings':
      return <SettingsPage />
    case 'about':
      return <AboutPage />
    case 'debug':
      return <DebugPage />
    default:
      return <HomePage />
  }
}

function getUpdateNavLabelKey(state: UpdateState): TranslationKey {
  if (state.status === 'ready' || (state.status === 'checking' && Boolean(state.pendingVersion))) return 'nav.updateReady'
  if (state.status === 'error') return 'nav.updateError'
  return 'nav.updateAvailable'
}

export function App() {
  const { t } = useI18n()
  const [visible, setVisible] = useState(isModalVisible())
  const [activePageId, setActivePageId] = useState(() => (isUpdateAttentionRequired(getUpdateState()) ? 'update' : 'home'))
  const [sidebarCollapsed, setSidebarCollapsed] = useState(store.get('sidebarCollapsed'))
  const [devMode, setDevMode] = useState(store.get('developerMode'))
  const [updateState, setUpdateState] = useState<UpdateState>(() => getUpdateState())

  useEffect(() => {
    return onModalVisibilityChange((v) => {
      const rootConnected = Boolean(document.getElementById('sona-root')?.isConnected)
      logger.debug('Modal visibility changed: %s (root in DOM: %s)', String(v), String(rootConnected))
      setVisible(v)
      if (v && isUpdateAttentionRequired(getUpdateState())) {
        setActivePageId('update')
      }
    })
  }, [])

  // 监听开发者模式变化
  useEffect(() => {
    return store.onChange('developerMode', (v) => {
      setDevMode(v)
      // 如果关闭开发者模式时正在调试页，切回主页
      if (!v && activePageId === 'debug') {
        setActivePageId('home')
      }
    })
  }, [activePageId])

  useEffect(() => {
    return onUpdateStateChange((state) => {
      setUpdateState(state)
      // 只有流程真正结束（无更新/已跳过）才离开更新页；错误页保留给用户处理
      if (state.status === 'latest' && activePageId === 'update') {
        setActivePageId('home')
      }
    })
  }, [activePageId])

  // 动态构建侧边栏项目
  const sidebarItems = useMemo(() => {
    const makeItem = (item: Omit<SidebarItem, 'label'> & { labelKey: TranslationKey }): SidebarItem => ({
      id: item.id,
      icon: item.icon,
      label: t(item.labelKey),
    })
    const baseItems = baseSidebarItemConfigs.map(makeItem)
    const items = isUpdateAttentionRequired(updateState)
      ? [
        {
          id: 'update',
          icon: <ZapIcon />,
          label: t(getUpdateNavLabelKey(updateState)),
        },
        ...baseItems,
      ]
      : baseItems
    return devMode ? [...items, makeItem(debugSidebarItemConfig)] : items
  }, [devMode, t, updateState])

  const handleClose = () => {
    closeModal()
    logger.info('Modal closed')
  }

  const handleToggleSidebar = () => {
    setSidebarCollapsed((v) => {
      const next = !v
      store.set('sidebarCollapsed', next)
      return next
    })
  }

  return (
    <Modal
      open={visible}
      onClose={handleClose}
      width={900}
      height={560}
    >
      <div className="sona-layout">
        <Sidebar
          items={sidebarItems}
          activeId={activePageId}
          onSelect={setActivePageId}
          collapsed={sidebarCollapsed}
          onToggle={handleToggleSidebar}
        />
        <div className="sona-content">
          <PageContent pageId={activePageId} />
        </div>
      </div>
    </Modal>
  )
}
