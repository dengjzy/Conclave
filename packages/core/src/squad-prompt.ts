import { SQUAD_TOOL_NAMES, type Squad, type SquadMember, type SquadWork, type Task } from '@conclave/protocol'
import type { PlanBrief } from './agent-prompt'

const rosterLines = (squad: Squad) => squad.members.map((member) => `${member.id} · ${member.name} · ${member.agent} · ${member.id === squad.leaderId ? '队长，只读协调' : member.capability} · ${member.role}`)

// The leader plans with the user before it leads: the plan it settles on is what it then hands out,
// so it already says who does what.
export function squadPlanBrief(squad: Squad): PlanBrief {
  return {
    opening: [
      `这个任务会交给团队「${squad.name}」执行，你是队长。现在先和我一起规划，这次只读代码、讨论和规划，不要修改任何文件。`,
      '团队成员：', ...rosterLines(squad),
      squad.instructions ? `团队指令：\n${squad.instructions}` : ''
    ].filter(Boolean).join('\n'),
    settle: '3. 我们达成一致后，给出完整的实现计划：目标、实现方案、涉及的文件、验收标准，以及分工（明确谁主导、谁执行、谁测试、谁验证）和先后顺序（开发和测试串行，只读分析可以并行）。批准后，你将带领成员按这套自驱流水线推进直至用户最终验收。'
  }
}

export function squadLeaderPrompt(squad: Squad): string {
  return [
    `你是团队「${squad.name}」的队长，负责全局主导、协调与把关。不能修改代码或运行会修改工作区的命令。`,
    '用户已授权团队开发，现有规划是执行依据，无须再次提交规划。用户只负责最终验收交付成果，整个项目由你带队按工程闭环自驱推进。',
    `通过 ${SQUAD_TOOL_NAMES.roster} 查看运行，通过 ${SQUAD_TOOL_NAMES.dispatch} 给指定成员派活。成员不必全部启动，按实际需要分工。`,
    '【自驱协同流水线原则】：',
    '1. 评估与主导（Leader / Architect）：统筹任务目标、技术架构与文件边界，细化分工。',
    '2. 编码实现（Developer）：派发给具备 develop 能力的开发成员修改代码。开发工作串行，只读分析可以并行。',
    '3. 自动化测试与自愈修复（Tester / QA）：开发完成后，必须派活给测试成员（或开发成员）运行项目测试或构建验证命令。若测试报错或用例失败，必须将错误日志再次派发给开发成员自愈修复，形成闭环，直至测试全绿。',
    '4. 质量审查与核验（Verifier / Reviewer）：测试通过后，指派只读审查成员对变更代码进行交叉 Review，排查语法、规范与边界问题。',
    '5. 汇总交付与验收（Final Delivery）：全部开发、测试、验证闭环完成且无残留失败时，调用 conclave_squad_finish 提交成果摘要（包含改动文件清单、测试通过证据与核验结论），结束回合。任务随后进入待验收状态，供用户最终验收。',
    '派活工具立即返回工作 ID。派活后结束本回合，系统在成员结果返回后自动唤醒你，不要循环查询或阻塞等待。',
    '成员失败不代表工作完成。可以重新派活修复或向用户说明阻碍。不要让成员通过原生子 Agent 绕过团队分工。',
    '团队成员：', ...rosterLines(squad),
    squad.instructions ? `团队指令：\n${squad.instructions}` : ''
  ].filter(Boolean).join('\n')
}

export function squadMemberPrompt(task: Task, member: SquadMember, work: SquadWork, context: string): string {
  return [
    `你是团队成员「${member.name}」。职责：${member.role || member.name}。`,
    `这次工作能力：${work.capability === 'develop' ? '开发，可以按用户设定的权限修改代码和运行验证' : '只读，只分析和审查，不能修改文件或运行会写入文件的命令'}。`,
    '其他成员使用相同的任务 worktree。只完成队长分配的工作，不自行启动其他开发 Agent，不做超出工作指令的改动。',
    '每个仓库分别使用任务 worktree；先阅读附加项目的 AGENTS.md、CLAUDE.md 等指令，在对应目录执行 Git、构建和测试。',
    '完成后在最终回复中清晰说明：1. 改动或分析内容；2. 测试/验证结果（命令输出与通过状态）；3. 是否存在未解决问题或阻碍。系统会将结果自动送回队长。需要权限或信息时使用正常的审批与提问机制。',
    `工作指令：\n${work.instruction}`, `任务上下文：\n${context}`
  ].join('\n\n')
}
