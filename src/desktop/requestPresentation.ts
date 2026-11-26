export function requestTitle(method: string, supported: boolean) {
  if (!supported) return 'Unsupported request'
  return ({
    'item/commandExecution/requestApproval': 'Command approval',
    'item/fileChange/requestApproval': 'File changes approval',
    'item/permissions/requestApproval': 'Permissions request',
    'item/tool/requestUserInput': 'Your input is needed',
    'mcpServer/elicitation/request': 'Tool request',
  } as Record<string, string>)[method] || 'Agent request'
}
