export const MANAGEMENT_TOOLS = {
  scheduleList: 'conclave_schedule_list',
  scheduleCreate: 'conclave_schedule_create',
  routineList: 'conclave_routine_list',
  routineCreate: 'conclave_routine_create',
  skillList: 'conclave_skill_list',
  skillSearch: 'conclave_skill_search',
  skillInstall: 'conclave_skill_install',
  skillSetActivation: 'conclave_skill_set_activation',
  commandList: 'conclave_chat_command_list',
  commandCreate: 'conclave_chat_command_create'
} as const

export const MANAGEMENT_READ_TOOLS: readonly string[] = [
  MANAGEMENT_TOOLS.scheduleList, MANAGEMENT_TOOLS.routineList,
  MANAGEMENT_TOOLS.skillList, MANAGEMENT_TOOLS.skillSearch, MANAGEMENT_TOOLS.commandList
]
