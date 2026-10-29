import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import { describe, expect, it } from 'vitest'
import { remarkPlugins } from './markdown-syntax'

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins }, text))

describe('reply markdown', () => {
  it('bolds a Chinese label that ends in punctuation and runs straight into the text', () => {
    expect(render('1. **逐行对齐：**每一行的分支图只画到这一行。')).toContain('<strong>逐行对齐：</strong>每一行')
    expect(render('**验证：**新增 2 个测试')).toContain('<strong>验证：</strong>新增')
    expect(render('Conclave 的**「本月」**窗口')).toContain('<strong>「本月」</strong>窗口')
  })
  it('leaves English emphasis to CommonMark', () => {
    expect(render('**Note:** done')).toContain('<strong>Note:</strong> done')
    expect(render('a**b**c and snake_case_name')).toContain('a<strong>b</strong>c and snake_case_name')
  })
  it('draws a GitHub alert as a callout of its kind, without its marker', () => {
    const html = render('> [!WARNING]\n> 0.14.4 之前的会话，截图仍会显示两张。')
    expect(html).toContain('<blockquote class="chat-alert" data-alert="warning">')
    expect(html).toContain('0.14.4 之前的会话')
    expect(html).not.toContain('[!WARNING]')
    // The marker's own line leaves no empty paragraph behind.
    expect(html).not.toContain('<p></p>')
    expect(render('> [!tip] 先实测再改')).toContain('<blockquote class="chat-alert" data-alert="tip">\n<p>先实测再改</p>')
  })
  it('leaves a plain quote, or one with an unknown marker, a quote', () => {
    expect(render('> 普通引用')).toContain('<blockquote>')
    expect(render('> [!HINT] 不是 GitHub 的类型')).toContain('<blockquote>\n<p>[!HINT] 不是 GitHub 的类型</p>')
  })
})
