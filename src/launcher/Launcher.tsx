import { useState, type ReactElement } from 'react'

interface Props {
  readonly onLaunch: (text: string) => void
}

const SUGGESTIONS = ['火星', '猎户座腰带', '超新星爆发', '黑洞', '土星环']

/** 发射台：输入一段文字并"发射"，保留对话提交的仪式感。 */
export function Launcher({ onLaunch }: Props): ReactElement {
  const [value, setValue] = useState('')

  /** 提交：空输入不发射。 */
  const submit = (): void => {
    const text = value.trim()
    if (text.length === 0) return
    onLaunch(text)
  }

  return (
    <div className="launcher">
      <div className="launcher-label">文字星图生成器</div>
      <div className="launcher-row">
        <input
          className="launcher-input"
          value={value}
          placeholder="输入一段文字，例如：中子星的旋转"
          maxLength={120}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        <button className="launch-btn" onClick={submit}>发射</button>
      </div>
      <div className="launcher-chips">
        {SUGGESTIONS.map((word) => (
          <button
            key={word}
            className="chip"
            onClick={() => {
              setValue(word)
              onLaunch(word)
            }}
          >
            {word}
          </button>
        ))}
      </div>
      <div className="launcher-note">按字符特征哈希生成图案，非语义理解</div>
    </div>
  )
}
