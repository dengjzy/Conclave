import { describe, expect, it } from 'vitest'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { continueList, deleteListMarker, parseListItem, stripTrailingEmptyListItem } from './chat-list-continuation'

function setup(doc: string, cursor = doc.length, composing = false, readOnly = false) {
  let state = EditorState.create({ doc, selection: { anchor: cursor } })
  if (readOnly) state = EditorState.create({ doc, selection: { anchor: cursor }, extensions: [EditorState.readOnly.of(true)] })
  const view = {
    composing,
    get state() { return state },
    dispatch: (spec: TransactionSpec) => { state = state.update(spec).state }
  }
  return { view, getText: () => state.doc.toString(), getCursor: () => state.selection.main.head }
}

describe('parseListItem', () => {
  it('identifies standard numbered lists', () => {
    expect(parseListItem('1. hello')).toEqual({
      kind: 'ordered',
      indent: '',
      marker: '1. ',
      nextMarker: '2. ',
      body: 'hello',
      empty: false,
      number: 1,
      delim: '.',
      space: ' '
    })
    expect(parseListItem('  10) world')).toEqual({
      kind: 'ordered',
      indent: '  ',
      marker: '  10) ',
      nextMarker: '  11) ',
      body: 'world',
      empty: false,
      number: 10,
      delim: ')',
      space: ' '
    })
  })

  it('identifies Chinese dunhao and parenthesis numbered lists', () => {
    expect(parseListItem('1、测试')).toEqual({
      kind: 'ordered',
      indent: '',
      marker: '1、',
      nextMarker: '2、',
      body: '测试',
      empty: false,
      number: 1,
      delim: '、',
      space: ''
    })
    expect(parseListItem('1、 测试')).toEqual({
      kind: 'ordered',
      indent: '',
      marker: '1、 ',
      nextMarker: '2、 ',
      body: '测试',
      empty: false,
      number: 1,
      delim: '、',
      space: ' '
    })
    expect(parseListItem('3）测试')).toEqual({
      kind: 'ordered',
      indent: '',
      marker: '3）',
      nextMarker: '4）',
      body: '测试',
      empty: false,
      number: 3,
      delim: '）',
      space: ''
    })
  })

  it('identifies bullets and task checkboxes', () => {
    expect(parseListItem('- item')).toEqual({
      kind: 'bullet',
      indent: '',
      marker: '- ',
      nextMarker: '- ',
      body: 'item',
      empty: false
    })
    expect(parseListItem('* star')).toEqual({
      kind: 'bullet',
      indent: '',
      marker: '* ',
      nextMarker: '* ',
      body: 'star',
      empty: false
    })
    expect(parseListItem('- [x] done')).toEqual({
      kind: 'checkbox',
      indent: '',
      marker: '- [x] ',
      nextMarker: '- [ ] ',
      body: 'done',
      empty: false
    })
  })

  it('detects empty list items', () => {
    expect(parseListItem('2. ')?.empty).toBe(true)
    expect(parseListItem('2、')?.empty).toBe(true)
    expect(parseListItem('  - ')?.empty).toBe(true)
  })

  it('rejects non-list lines', () => {
    expect(parseListItem('normal paragraph')).toBeNull()
    expect(parseListItem('version 1.2.3 released')).toBeNull()
  })
})

describe('continueList', () => {
  it('continues numbered lists with incremented number', () => {
    const editor = setup('1. 第一点')
    expect(continueList(editor.view)).toBe(true)
    expect(editor.getText()).toBe('1. 第一点\n2. ')
    expect(editor.getCursor()).toBe('1. 第一点\n2. '.length)
  })

  it('renumbers consecutive following items when inserting', () => {
    const text = '1. 第一点\n2. 第二点\n3. 第三点\n4. 第四点\n5. 第五点'
    const cursor = '1. 第一点\n2. 第二点\n3. 第三点'.length
    const editor = setup(text, cursor)
    expect(continueList(editor.view)).toBe(true)
    expect(editor.getText()).toBe('1. 第一点\n2. 第二点\n3. 第三点\n4. \n5. 第四点\n6. 第五点')
    expect(editor.getCursor()).toBe('1. 第一点\n2. 第二点\n3. 第三点\n4. '.length)
  })

  it('renumbers Chinese dunhao lists when inserting', () => {
    const text = '1、第一点\n2、第二点\n3、第三点\n4、第四点'
    const cursor = '1、第一点\n2、第二点\n3、第三点'.length
    const editor = setup(text, cursor)
    expect(continueList(editor.view)).toBe(true)
    expect(editor.getText()).toBe('1、第一点\n2、第二点\n3、第三点\n4、\n5、第四点')
  })

  it('only renumbers items with matching indent and delimiter', () => {
    const text = '1. 第一点\n   1. 子任务一\n   2. 子任务二\n2. 第二点'
    const cursor = '1. 第一点\n   1. 子任务一'.length
    const editor = setup(text, cursor)
    expect(continueList(editor.view)).toBe(true)
    expect(editor.getText()).toBe('1. 第一点\n   1. 子任务一\n   2. \n   3. 子任务二\n2. 第二点')
  })

  it('continues Chinese dunhao lists', () => {
    const editor = setup('1、第一点')
    expect(continueList(editor.view)).toBe(true)
    expect(editor.getText()).toBe('1、第一点\n2、')
    expect(editor.getCursor()).toBe('1、第一点\n2、'.length)
  })

  it('continues bullet lists', () => {
    const editor = setup('- item')
    expect(continueList(editor.view)).toBe(true)
    expect(editor.getText()).toBe('- item\n- ')
  })

  it('resets task checkbox to unchecked on continuation', () => {
    const editor = setup('- [x] item')
    expect(continueList(editor.view)).toBe(true)
    expect(editor.getText()).toBe('- [x] item\n- [ ] ')
  })

  it('splits lines in the middle and renumbers subsequent items', () => {
    const doc = '1. 苹果\n2. 香蕉橙子\n3. 西瓜'
    const caret = '1. 苹果\n2. 香蕉'.length
    const editor = setup(doc, caret)
    expect(continueList(editor.view)).toBe(true)
    expect(editor.getText()).toBe('1. 苹果\n2. 香蕉\n3. 橙子\n4. 西瓜')
    expect(editor.getCursor()).toBe('1. 苹果\n2. 香蕉\n3. '.length)
  })

  it('exits list when called on an empty item and decrements following items', () => {
    const text = '1. 一\n2. 二\n3. 三\n4. \n5. 四\n6. 五'
    const cursor = '1. 一\n2. 二\n3. 三\n4. '.length
    const editor = setup(text, cursor)
    expect(continueList(editor.view)).toBe(true)
    expect(editor.getText()).toBe('1. 一\n2. 二\n3. 三\n\n4. 四\n5. 五')
    expect(editor.getCursor()).toBe('1. 一\n2. 二\n3. 三\n'.length)
  })

  it('preserves indentation when exiting list on empty item', () => {
    const editor = setup('1. 第一点\n  2. ')
    expect(continueList(editor.view)).toBe(true)
    expect(editor.getText()).toBe('1. 第一点\n  ')
    expect(editor.getCursor()).toBe('1. 第一点\n  '.length)
  })

  it('ignores when cursor is inside marker', () => {
    const editor = setup('1. hello', 1)
    expect(continueList(editor.view)).toBe(false)
    expect(editor.getText()).toBe('1. hello')
  })

  it('does nothing when composing IME or read-only', () => {
    const composingEditor = setup('1. hello', '1. hello'.length, true)
    expect(continueList(composingEditor.view)).toBe(false)

    const readOnlyEditor = setup('1. hello', '1. hello'.length, false, true)
    expect(continueList(readOnlyEditor.view)).toBe(false)
  })
})

describe('deleteListMarker', () => {
  it('clears empty list marker on backspace and decrements following items', () => {
    const text = '1. 一\n2. 二\n3. 三\n4. \n5. 四\n6. 五'
    const cursor = '1. 一\n2. 二\n3. 三\n4. '.length
    const editor = setup(text, cursor)
    expect(deleteListMarker(editor.view)).toBe(true)
    expect(editor.getText()).toBe('1. 一\n2. 二\n3. 三\n\n4. 四\n5. 五')
  })

  it('clears empty Chinese dunhao marker on backspace', () => {
    const editor = setup('1、第一点\n2、')
    expect(deleteListMarker(editor.view)).toBe(true)
    expect(editor.getText()).toBe('1、第一点\n')
  })

  it('does not delete when item has content', () => {
    const editor = setup('1. 第一点')
    expect(deleteListMarker(editor.view)).toBe(false)
    expect(editor.getText()).toBe('1. 第一点')
  })

  it('does not delete when cursor is not at line end', () => {
    const editor = setup('1. 第一点\n2. ', '1. 第一点\n2.'.length)
    expect(deleteListMarker(editor.view)).toBe(false)
  })
})

describe('stripTrailingEmptyListItem', () => {
  it('strips dangling empty list markers from the end', () => {
    expect(stripTrailingEmptyListItem('1. 测试\n2. ')).toBe('1. 测试')
    expect(stripTrailingEmptyListItem('1. 测试\n2.')).toBe('1. 测试')
    expect(stripTrailingEmptyListItem('1. 测试\n2、')).toBe('1. 测试')
    expect(stripTrailingEmptyListItem('1. 测试\n- ')).toBe('1. 测试')
    expect(stripTrailingEmptyListItem('1. 测试\n- [ ] ')).toBe('1. 测试')
  })

  it('leaves intact when last item has content', () => {
    expect(stripTrailingEmptyListItem('1. 测试\n2. 测试2')).toBe('1. 测试\n2. 测试2')
  })

  it('returns empty string if only empty marker exists', () => {
    expect(stripTrailingEmptyListItem('2. ')).toBe('')
    expect(stripTrailingEmptyListItem('2、')).toBe('')
  })
})
