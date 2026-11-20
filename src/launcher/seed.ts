/** URL 种子：?s=文字 让分享链接打开即发射。 */

/** 读取当前地址中的种子文字。 */
export function readSeed(): string {
  if (typeof window === 'undefined') return ''
  const value = new URLSearchParams(window.location.search).get('s')
  return value === null ? '' : value.slice(0, 120)
}

/** 把新文字写入地址栏（不刷新页面），生成可分享的链接。 */
export function writeSeed(text: string): void {
  const url = new URL(window.location.href)
  if (text.trim().length === 0) url.searchParams.delete('s')
  else url.searchParams.set('s', text.trim())
  window.history.replaceState(null, '', url.toString())
}
