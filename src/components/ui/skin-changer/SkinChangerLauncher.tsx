/**
 * 选人界面「换肤」入口
 *
 * 由 skin-changer 功能模块挂载到皮肤轮播容器（找不到时回退到右下角按钮区）。
 */

import { useState } from 'react'
import { useI18n } from '@/i18n'
import { SkinChangerModal } from './SkinChangerModal'
import '@/styles/SkinChanger.css'

export function SkinChangerLauncher() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        className="sona-skin-launcher"
        onClick={(event) => {
          event.stopPropagation()
          setOpen(true)
        }}
      >
        <span className="sona-skin-launcher-glyph" aria-hidden="true">✦</span>
        {t('skinChanger.open')}
      </button>
      <SkinChangerModal open={open} onClose={() => setOpen(false)} />
    </>
  )
}
