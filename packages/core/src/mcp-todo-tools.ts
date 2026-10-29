import { z } from 'zod'
import { turnedOff } from './mcp-setting-gate'
import { openTodoCount, todoToolName, TodoOwner, TodoText, TodoTitle, type RpcConnection, type TodoGroup, type TodoToolKind } from '@conclave/protocol'

const argumentsFor = {
  list: z.object({}),
  add: z.object({
    title: TodoTitle,
    note: z.string().trim().max(120).optional(),
    group: z.string().trim().min(1).optional(),
    items: z.array(z.union([TodoText, z.object({ text: TodoText, owner: TodoOwner.optional() })])).min(1).max(30)
  }),
  check: z.object({ group: z.string().trim().min(1), item: z.string().trim().min(1).optional(), done: z.boolean().optional() })
}

const descriptions: Record<TodoToolKind, string> = {
  list:
    '列出这条会话里记下的待办：每一组的标题，组里每一项、谁来做、做完没有，都带 id。记新的待办之前先看一遍，免得重复；' +
    '要勾掉某一项时用它找 id。只读。',
  add:
    '把要用户之后处理的事记成待办。它显示在 Conclave 检查器的「待办」里，跟着这条会话保存，换轮、重启、移交给别的 Agent 都还在，' +
    '用户能逐项勾掉。只在回复里列出了要用户之后去做、或这一轮做不完要留到以后的事时用：上线前要做的、要和别人对齐的、' +
    '要用户去验证或配置的、发布顺序之类。你这一轮自己要做的步骤不要记，那是你自己的计划。' +
    '一组一个标题（如「真机验证」），下面是具体的几项，每项一句话说清做什么；同一标题、还没做完的组会合并，已有的项不会重复记。' +
    '每项标明谁来做：user 是要用户去做（默认），agent 是 Agent 能代做、用户可以交给 Agent。回复里照常说明，记完提一句已记成待办即可。',
  check:
    '把待办里的一项标成已完成（或改回未完成）；不给 item 就是整组。你做完了某一项，或用户告诉你某件事已经办了时用，' +
    `id 来自 ${todoToolName('list')} 或 ${todoToolName('add')} 的结果。`
}

const schemas: Record<TodoToolKind, object> = {
  list: { type: 'object', properties: {}, additionalProperties: false },
  add: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '这一组的标题，几个字，如「真机验证」「跟 CS 团队对齐」' },
      note: { type: 'string', description: '什么时候或为什么，几个字，如「上线前」「可选」' },
      group: { type: 'string', description: '加到已有的这一组（组 id），可选；不给就按标题找还没做完的同名组，没有就新建' },
      items: {
        type: 'array',
        description: '组里的每一项：一句话，或 { text, owner }，owner 是 user（默认）或 agent',
        items: {
          anyOf: [
            { type: 'string' },
            { type: 'object', properties: { text: { type: 'string' }, owner: { type: 'string', enum: ['user', 'agent'] } }, required: ['text'], additionalProperties: false }
          ]
        }
      }
    },
    required: ['title', 'items'],
    additionalProperties: false
  },
  check: {
    type: 'object',
    properties: {
      group: { type: 'string', description: '组 id' },
      item: { type: 'string', description: '这一项的 id；不给就是整组' },
      done: { type: 'boolean', description: 'true 标成已完成（默认），false 改回未完成' }
    },
    required: ['group'],
    additionalProperties: false
  }
}

const OWNER: Record<TodoGroup['items'][number]['owner'], string> = { user: '要用户做', agent: 'Agent 可做' }

// The list as the model reads it: every group and item, with the ids it needs to act on them.
export function todosText(groups: readonly TodoGroup[]): string {
  if (groups.length === 0) return '这条会话还没有待办。'
  const head = `共 ${groups.length} 组，${openTodoCount(groups)} 项未完成：`
  const blocks = groups.map((group) => [
    `## ${group.title}${group.note ? ` · ${group.note}` : ''}（组 id ${group.id}）`,
    ...group.items.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text} · ${OWNER[item.owner]}（id ${item.id}）`)
  ].join('\n'))
  return [head, ...blocks].join('\n\n')
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError: boolean }
const result = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text }], isError })

// The to-do tools, acting on this one conversation's list in core.
export function todoToolsOverCore(withCore: <T>(action: (rpc: RpcConnection) => Promise<T>) => Promise<T>, conversationId: string) {
  const run = async (kind: TodoToolKind, raw: Record<string, unknown>): Promise<ToolResult> => {
    const args = argumentsFor[kind].safeParse(raw)
    if (!args.success) return result(`参数不对：${args.error.issues.map((issue) => `${issue.path.join('.') || '参数'} ${issue.message}`).join('；')}`, true)
    try {
      const off = await withCore((rpc) => turnedOff(rpc, 'userTodos'))
      if (off) return result(off, true)
      if (kind === 'list') return result(todosText(await withCore((rpc) => rpc.call('todos.list', { id: conversationId }))))
      if (kind === 'add') {
        const { title, note, group, items } = argumentsFor.add.parse(raw)
        const groups = await withCore((rpc) => rpc.call('todos.add', {
          id: conversationId,
          title,
          ...(note !== undefined ? { note } : {}),
          ...(group !== undefined ? { groupId: group } : {}),
          items: items.map((item) => (typeof item === 'string' ? { text: item, owner: 'user' as const } : { text: item.text, owner: item.owner ?? 'user' }))
        }))
        return result(`已记成待办，用户在检查器的「待办」里能看到。\n\n${todosText(groups)}`)
      }
      const { group, item, done } = argumentsFor.check.parse(raw)
      const groups = await withCore((rpc) => rpc.call('todos.check', { id: conversationId, groupId: group, ...(item !== undefined ? { itemId: item } : {}), done: done ?? true }))
      return result(todosText(groups))
    } catch (error) {
      return result(`没能完成：${error instanceof Error ? error.message : String(error)}`, true)
    }
  }
  return (['list', 'add', 'check'] as const).map((kind) => ({
    spec: {
      name: todoToolName(kind),
      title: kind === 'list' ? '查看待办' : kind === 'add' ? '记下待办' : '勾掉待办',
      description: descriptions[kind],
      inputSchema: schemas[kind],
      annotations: { readOnlyHint: kind === 'list', destructiveHint: false, idempotentHint: kind !== 'add', openWorldHint: false }
    },
    run: (raw: Record<string, unknown>) => run(kind, raw)
  }))
}
